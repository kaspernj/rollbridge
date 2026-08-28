// @ts-check

import {EventEmitter} from "node:events"
import ManagedProcess from "./managed-process.js"
import {findAvailablePort} from "./port-allocator.js"
import {processTemplateContext, renderObject, renderTemplate} from "./template.js"
import {waitForHealth} from "./health.js"

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {"starting" | "active" | "draining" | "stopped" | "failed"} ReleaseState
 * @typedef {{http: number, websocket: number}} ReleaseConnections
 * @typedef {{activatedAt: string | undefined, connectionCount: number, connections: ReleaseConnections, drainStartedAt: string | undefined, ports: Record<string, number>, processes: import("./managed-process.js").ManagedProcessStatus[], releaseId: string, releasePath: string, retirementError: string | undefined, revision: string, state: ReleaseState, stoppedAt: string | undefined}} ReleaseStatus
 * @typedef {{count?: number, guardianKey?: string, index?: number, instanceId?: string, shouldRestart?: () => boolean}} BuildProcessOptions
 */

/**
 * @param {string} id - Process id.
 * @returns {string} Environment suffix.
 */
function envId(id) {
  return id.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()
}

/**
 * @param {import("./config.js").ProcessConfig} processConfig - Process config.
 * @param {number} index - Zero-based replica index.
 * @returns {string} The instance id: the bare process id for a single replica, or `id#index`.
 */
function replicaInstanceId(processConfig, index) {
  return processConfig.replicas > 1 ? `${processConfig.id}#${index}` : processConfig.id
}

export default class ReleaseGroup extends EventEmitter {
  /**
   * @param {object} args - Options.
   * @param {import("./config.js").RollbridgeConfig} args.config - Rollbridge config.
   * @param {(message: string, data?: Record<string, JsonValue>) => void} args.logger - Logger.
   * @param {string} args.releaseId - Release id.
   * @param {string} args.releasePath - Release path.
   * @param {string | undefined} args.revision - Revision.
   * @param {Record<string, number>} [args.servicePorts] - Ports already owned by daemon-wide services.
   * @param {() => boolean} [args.shouldStart] - Whether bootstrap may create another process.
   * @param {(key: string, definition: ConstructorParameters<typeof ManagedProcess>[0]) => ManagedProcess} [args.processFactory] - Durable process factory.
   */
  constructor({config, logger, processFactory, releaseId, releasePath, revision, servicePorts = {}, shouldStart = () => true}) {
    super()

    this.config = config
    this.logger = logger
    this.releaseId = releaseId
    this.releasePath = releasePath
    this.revision = revision || releaseId
    this.state = /** @type {ReleaseState} */ ("starting")
    this.connectionCount = 0
    this.connections = /** @type {ReleaseConnections} */ ({http: 0, websocket: 0})
    this.transferredConnections = /** @type {ReleaseConnections} */ ({http: 0, websocket: 0})
    this.ownerHandoffPaused = false
    this.processes = /** @type {Map<string, ManagedProcess>} */ (new Map())
    this.handoffServiceIds = /** @type {Set<string>} */ (new Set())
    this.nonBlockingDrainIds = /** @type {Set<string>} */ (new Set())
    this.ports = /** @type {Record<string, number>} */ ({})
    this.servicePorts = servicePorts
    this.shouldStart = shouldStart
    this.processFactory = processFactory
    this.portsAllocated = false
    this.drainStartedAt = /** @type {string | undefined} */ (undefined)
    this.activatedAt = /** @type {string | undefined} */ (undefined)
    this.stoppedAt = /** @type {string | undefined} */ (undefined)
    this.retirementError = /** @type {string | undefined} */ (undefined)
    this.preserveConfigOnRetirement = false
  }

  /** @returns {Promise<void>} Starts release-owned processes and health checks the proxied process. */
  async start() {
    this.state = "starting"

    try {
      await this.allocatePorts()

      for (const processConfig of this.releaseProcessStartOrder()) {
        for (let index = 0; index < processConfig.replicas; index += 1) {
          if (!this.shouldStart()) throw new Error("Rollbridge is shutting down")

          const instanceId = replicaInstanceId(processConfig, index)
          const processInstance = this.buildProcess(processConfig, {count: processConfig.replicas, index, instanceId})

          this.processes.set(instanceId, processInstance)
          if (processConfig.policy === "service" && processConfig.deployStrategy === "handoff") this.handoffServiceIds.add(instanceId)
          if (processConfig.nonBlockingDrain) this.nonBlockingDrainIds.add(instanceId)
          await processInstance.start("deploy")
        }

        if (processConfig.policy === "proxied" && processConfig.port && processConfig.health) {
          await waitForHealth({
            health: processConfig.health,
            host: this.config.proxy.upstreamHost,
            port: this.ports[processConfig.id]
          })

          if (!this.shouldStart()) throw new Error("Rollbridge is shutting down")
        }
      }
    } catch (error) {
      this.state = "failed"
      this.logStartupFailure(error instanceof Error ? error : String(error), {phase: "before cleanup"})
      await this.stop()
      this.logStartupFailure(error instanceof Error ? error : String(error), {phase: "after cleanup"})
      throw error
    }
  }

  /**
   * Reconstructs this release around processes still owned by the durable guardian.
   * @param {ReleaseStatus} snapshot - Persisted release snapshot.
   */
  async restore(snapshot) {
    if (!snapshot || snapshot.releaseId !== this.releaseId || snapshot.releasePath !== this.releasePath || snapshot.revision !== this.revision) {
      throw new Error(`Persisted release identity mismatch for ${this.releaseId}`)
    }
    if (!snapshot.ports || !Array.isArray(snapshot.processes)) throw new Error(`Persisted release ${this.releaseId} is missing ports or processes`)

    const expectedProcessIds = this.config.processes
      .filter((processConfig) => processConfig.policy !== "singleton" && (processConfig.policy !== "service" || processConfig.deployStrategy === "handoff"))
      .flatMap((processConfig) => Array.from({length: processConfig.replicas}, (_, index) => replicaInstanceId(processConfig, index)))
      .sort()
    const persistedProcessIds = snapshot.processes.map((processStatus) => processStatus.id).sort()

    if (JSON.stringify(persistedProcessIds) !== JSON.stringify(expectedProcessIds)) {
      throw new Error(`Persisted release ${this.releaseId} process set does not match the configured generation`)
    }
    for (const processConfig of this.config.processes) {
      if (processConfig.port && typeof snapshot.ports[processConfig.id] !== "number") throw new Error(`Persisted release ${this.releaseId} is missing port ${processConfig.id}`)
    }

    this.ports = {...snapshot.ports}
    this.portsAllocated = true
    this.state = snapshot.state
    this.activatedAt = snapshot.activatedAt
    this.drainStartedAt = snapshot.drainStartedAt
    this.retirementError = snapshot.retirementError
    this.stoppedAt = snapshot.stoppedAt
    this.setTransferredConnections(snapshot.connections)

    for (const processStatus of snapshot.processes) {
      const baseId = processStatus.id.replace(/#\d+$/, "")
      const processConfig = this.config.processes.find((candidate) => candidate.id === baseId)

      if (!processConfig || processConfig.policy === "singleton" || (processConfig.policy === "service" && processConfig.deployStrategy !== "handoff")) {
        throw new Error(`Persisted release ${this.releaseId} contains unknown process ${processStatus.id}`)
      }
      const replicaMatch = processStatus.id.match(/#(\d+)$/)
      const index = replicaMatch ? Number(replicaMatch[1]) : 0
      const processInstance = this.buildProcess(processConfig, {count: processConfig.replicas, index, instanceId: processStatus.id})

      this.processes.set(processStatus.id, processInstance)
      if (processConfig.policy === "service" && processConfig.deployStrategy === "handoff") this.handoffServiceIds.add(processStatus.id)
      if (processConfig.nonBlockingDrain) this.nonBlockingDrainIds.add(processStatus.id)
      if ("recover" in processInstance && typeof processInstance.recover === "function") await processInstance.recover()
    }
  }

  /**
   * @param {string} id - Process id.
   * @returns {ManagedProcess | undefined} This release's managed process with the given id, if present.
   */
  getProcess(id) {
    return this.processes.get(id)
  }

  /**
   * Returns the running instances of a process config — one for a single process, or every
   * replica (`id#0`, `id#1`, …) for a replicated one.
   * @param {string} configId - Base process id from the config.
   * @returns {{id: string, process: ManagedProcess}[]} Matching instances, ordered by instance id.
   */
  getProcesses(configId) {
    /** @type {{id: string, process: ManagedProcess}[]} */
    const instances = []

    for (const [instanceId, processInstance] of this.processes) {
      if (instanceId === configId || instanceId.startsWith(`${configId}#`)) {
        instances.push({id: instanceId, process: processInstance})
      }
    }

    return instances
  }

  /**
   * Logs process diagnostics around failed startup cleanup.
   * @param {Error | string} error - Startup failure.
   * @param {{phase: string}} options - Diagnostic phase.
   * @returns {void}
   */
  logStartupFailure(error, {phase}) {
    this.logger("release startup failed", {
      error: error instanceof Error ? error.message : error,
      phase,
      releaseId: this.releaseId
    })

    for (const processInstance of this.processes.values()) {
      const status = processInstance.status()

      this.logger("release startup process status", {
        command: status.command,
        exitCode: status.exitCode ?? null,
        exitSignal: status.exitSignal ?? null,
        logs: status.logs,
        phase,
        pid: status.pid ?? null,
        processId: status.id,
        releaseId: this.releaseId,
        state: status.state
      })
    }
  }

  /**
   * Starts companions before the proxied process so release-local dependencies are available before health checks.
   * @returns {import("./config.js").ProcessConfig[]} Ordered process configs.
   */
  releaseProcessStartOrder() {
    const releaseProcesses = this.config.processes.filter((processConfig) => processConfig.policy !== "singleton" && (processConfig.policy !== "service" || processConfig.deployStrategy === "handoff"))
    const serviceProcesses = releaseProcesses.filter((processConfig) => processConfig.policy === "service")
    const companionProcesses = releaseProcesses.filter((processConfig) => processConfig.policy === "companion")
    const proxiedProcesses = releaseProcesses.filter((processConfig) => processConfig.policy === "proxied")

    return [...serviceProcesses, ...companionProcesses, ...proxiedProcesses]
  }

  /** @returns {void} Marks this release active. */
  activate() {
    this.state = "active"
    this.activatedAt = new Date().toISOString()
  }

  /** @returns {Promise<void>} Allocates all configured per-process ports. */
  async allocatePorts() {
    if (this.portsAllocated) return

    const usedPorts = /** @type {Set<number>} */ (new Set())

    for (const processConfig of this.config.processes) {
      if (!processConfig.port) continue
      if (processConfig.policy === "service" && processConfig.deployStrategy !== "handoff" && this.servicePorts[processConfig.id] !== undefined) {
        this.ports[processConfig.id] = this.servicePorts[processConfig.id]
        usedPorts.add(this.servicePorts[processConfig.id])
        continue
      }

      this.ports[processConfig.id] = await findAvailablePort({
        host: this.config.proxy.upstreamHost,
        range: processConfig.port,
        usedPorts
      })
    }

    this.portsAllocated = true
  }

  /**
   * Builds a managed process from config.
   * @param {import("./config.js").ProcessConfig} processConfig - Process config.
   * @param {BuildProcessOptions} [options] - Build options.
   * @returns {ManagedProcess} Managed process.
   */
  buildProcess(processConfig, options = {}) {
    const index = options.index ?? 0
    const count = options.count ?? 1
    const instanceId = options.instanceId ?? processConfig.id
    const context = this.contextForProcess(processConfig, {count, index})
    const renderedEnv = /** @type {Record<string, string>} */ (renderObject(processConfig.env, context))
    const processEnv = {
      ...this.baseEnvironment(processConfig, {count, index}),
      ...renderedEnv
    }

    const definition = /** @type {ConstructorParameters<typeof ManagedProcess>[0]} */ ({
      command: renderTemplate(processConfig.command, context),
      cwd: processConfig.cwd ? renderTemplate(processConfig.cwd, context) : this.releasePath,
      env: processEnv,
      id: instanceId,
      lifecycle: processConfig.lifecycle,
      logger: (message, data = {}) => this.logger(message, {processId: instanceId, releaseId: this.releaseId, ...data}),
      memory: processConfig.memory,
      outputLines: processConfig.outputLines,
      restart: processConfig.restart,
      restartDelayMs: processConfig.restartDelayMs,
      shouldRestart: options.shouldRestart || (() => this.state === "active" || this.state === "starting"),
      stopSignal: processConfig.stopSignal,
      stopTimeoutMs: processConfig.gracefulStopMs
    })

    return this.processFactory
      ? this.processFactory(options.guardianKey || `release:${this.releaseId}:${instanceId}`, definition)
      : new ManagedProcess(definition)
  }

  /**
   * Applies refreshed process definitions before retiring this release.
   * @param {import("./config.js").RollbridgeConfig} config - Current deployment config.
   * @returns {void}
   */
  refreshProcessDefinitions(config) {
    this.config = config
    this.handoffServiceIds.clear()
    this.nonBlockingDrainIds.clear()

    for (const processConfig of config.processes) {
      const instances = this.getProcesses(processConfig.id)

      for (let index = 0; index < instances.length; index += 1) {
        const instance = instances[index]
        const nextDefinition = this.buildProcess(processConfig, {
          count: processConfig.replicas,
          index,
          instanceId: instance.id
        })

        instance.process.updateDefinition(nextDefinition)
        if (processConfig.policy === "service" && processConfig.deployStrategy === "handoff") this.handoffServiceIds.add(instance.id)
        if (processConfig.nonBlockingDrain) this.nonBlockingDrainIds.add(instance.id)
      }
    }
  }

  /**
   * @param {import("./config.js").ProcessConfig} processConfig - Process config.
   * @param {{count: number, index: number}} replica - Replica index and total count.
   * @returns {Record<string, string>} Base environment.
   */
  baseEnvironment(processConfig, replica = {count: 1, index: 0}) {
    /** @type {Record<string, string>} */
    const env = {
      ROLLBRIDGE_APPLICATION: this.config.application,
      ROLLBRIDGE_PROCESS_ID: processConfig.id,
      ROLLBRIDGE_RELEASE_ID: this.releaseId,
      ROLLBRIDGE_RELEASE_PATH: this.releasePath,
      ROLLBRIDGE_REPLICA_COUNT: String(replica.count),
      ROLLBRIDGE_REPLICA_INDEX: String(replica.index),
      ROLLBRIDGE_REVISION: this.revision
    }

    if (this.ports[processConfig.id] !== undefined) {
      env.ROLLBRIDGE_PORT = String(this.ports[processConfig.id])
    }

    for (const [processId, port] of Object.entries(this.ports)) {
      env[`ROLLBRIDGE_${envId(processId)}_PORT`] = String(port)
    }

    return env
  }

  /**
   * @param {import("./config.js").ProcessConfig} processConfig - Process config.
   * @param {{count: number, index: number}} replica - Replica index and total count.
   * @returns {Record<string, JsonValue>} Template context.
   */
  contextForProcess(processConfig, replica = {count: 1, index: 0}) {
    return processTemplateContext({
      application: this.config.application,
      ports: this.ports,
      processId: processConfig.id,
      proxy: this.config.proxy,
      releaseId: this.releaseId,
      releasePath: this.releasePath,
      replicaCount: replica.count,
      replicaIndex: replica.index,
      revision: this.revision
    })
  }

  /**
   * @returns {{process: ManagedProcess, target: string}} Proxied process target.
   */
  proxyTarget() {
    const processConfig = this.config.processes.find((candidate) => candidate.policy === "proxied")

    if (!processConfig) throw new Error("No proxied process configured")

    const processInstance = this.processes.get(processConfig.id)
    const port = this.ports[processConfig.id]

    if (!processInstance || !port) {
      throw new Error(`Proxied process ${processConfig.id} is not running`)
    }

    return {
      process: processInstance,
      target: `http://${this.config.proxy.upstreamHost}:${port}`
    }
  }

  /**
   * @param {"http" | "websocket"} type - Connection type.
   * @returns {() => void} Release callback.
   */
  retainConnection(type) {
    this.connectionCount += 1
    this.connections[type] += 1
    let released = false

    return () => {
      if (released) return

      released = true
      this.connectionCount -= 1
      this.connections[type] -= 1

      if (this.connectionCount === 0) {
        this.emit("drained")
      }
    }
  }

  /**
   * Reconciles connections still owned by a prior daemon listener.
   * @param {ReleaseConnections} connections - Exact incumbent listener counts.
   */
  setTransferredConnections(connections) {
    const http = connections?.http
    const websocket = connections?.websocket

    if (!Number.isSafeInteger(http) || http < 0 || !Number.isSafeInteger(websocket) || websocket < 0) {
      throw new Error(`Persisted release ${this.releaseId} has invalid listener connection counts`)
    }
    const previous = this.transferredConnections

    this.connectionCount += http + websocket - previous.http - previous.websocket
    this.connections.http += http - previous.http
    this.connections.websocket += websocket - previous.websocket
    this.transferredConnections = {http, websocket}
    if (this.connectionCount === 0) this.emit("drained")
  }

  /** @returns {boolean} Whether a prior daemon still owns live connections for this release. */
  hasTransferredConnections() {
    return this.transferredConnections.http + this.transferredConnections.websocket > 0
  }

  /** Pauses only daemon-local connection-dependent retirement at owner handoff. */
  pauseDrainForOwnerHandoff() {
    if (this.state !== "draining") return
    this.ownerHandoffPaused = true
    this.emit("ownerHandoff")
  }

  /** @returns {boolean} Whether retirement completion belongs to the prepared successor. */
  isDrainPausedForOwnerHandoff() {
    return this.ownerHandoffPaused
  }

  /** Resumes a drain after its prepared owner handoff aborts. */
  resumeDrainAfterOwnerHandoff() {
    this.ownerHandoffPaused = false
  }

  /**
   * Starts draining and stops once existing connections close or timeout.
   * @param {number} timeoutMs - Drain timeout.
   * @param {import("./config.js").RollbridgeConfig} [config] - Refreshed config governing retirement.
   * @returns {Promise<void>} Resolves when stopped.
   */
  async drainAndStop(timeoutMs, config = this.config) {
    if (this.state === "stopped") return

    if (this.state !== "draining") await this.beginRetirement(config)

    // Stop nonBlockingDrain processes (e.g. job workers) immediately and in the background, so
    // their lifecycle drain runs as soon as the release is retired — in parallel with the
    // connection drain, not held until after it. The rest stop once connections have closed.
    const entries = [...this.processes.entries()]
    const nonBlockingStops = entries.filter(([id]) => this.nonBlockingDrainIds.has(id)).map(([, processInstance]) => processInstance.stop())
    const handoffServices = entries.filter(([id]) => this.handoffServiceIds.has(id)).map(([, processInstance]) => processInstance)
    const connectionDependent = entries.filter(([id]) => !this.nonBlockingDrainIds.has(id) && !this.handoffServiceIds.has(id)).map(([, processInstance]) => processInstance)

    if (this.connectionCount > 0) {
      await new Promise((resolve) => {
        let timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined)
        const completed = () => {
          clearTimeout(timer)
          this.off("drained", completed)
          this.off("ownerHandoff", completed)
          resolve(undefined)
        }

        this.once("drained", completed)
        this.once("ownerHandoff", completed)
        timer = setTimeout(completed, timeoutMs)
      })
    }

    if (this.ownerHandoffPaused) {
      void Promise.allSettled(nonBlockingStops)
      return
    }

    await Promise.allSettled(connectionDependent.map((processInstance) => processInstance.stop()))
    await Promise.allSettled(nonBlockingStops)
    await Promise.allSettled(handoffServices.map((processInstance) => processInstance.stop()))
    this.state = "stopped"
    this.stoppedAt = new Date().toISOString()
  }

  /**
   * Marks the generation retired and quiesces its jobs-main and non-blocking workers as one unit.
   * @param {import("./config.js").RollbridgeConfig} [config] - Refreshed retirement config.
   * @returns {Promise<void>} Resolves when retirement quiescence succeeds.
   */
  async beginRetirement(config = this.config) {
    if (this.state === "draining") {
      if (this.retirementError) throw new Error(this.retirementError)
      return
    }

    this.state = "draining"
    this.drainStartedAt = new Date().toISOString()
    this.refreshProcessDefinitions(config)
    const generationIds = new Set([...this.handoffServiceIds, ...this.nonBlockingDrainIds])
    const results = await Promise.allSettled([...this.processes.entries()]
      .filter(([id]) => generationIds.has(id))
      .map(([, processInstance]) => processInstance.quiesceStrict()))
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason)

    if (errors.length > 0) {
      const failure = new AggregateError(errors, `Release ${this.releaseId} retirement quiescence failed`)
      this.retirementError = `${failure.message}: ${errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")}`
      throw failure
    }
  }

  /** @returns {Promise<void>} Stops all release-owned processes. */
  async stop() {
    const stopTasks = [...this.processes.values()].map((processInstance) => processInstance.stop())

    await Promise.allSettled(stopTasks)
    this.state = "stopped"
    this.stoppedAt = new Date().toISOString()
  }

  /** @returns {Promise<void>} Quiesces every release process without waiting for its drain. */
  async quiesce() {
    await Promise.all([...this.processes.values()].map((processInstance) => processInstance.quiesce()))
  }

  /** @returns {ReleaseStatus} Status payload. */
  status() {
    return {
      activatedAt: this.activatedAt,
      connectionCount: this.connectionCount,
      connections: {...this.connections},
      drainStartedAt: this.drainStartedAt,
      ports: {...this.ports},
      processes: [...this.processes.values()].map((processInstance) => processInstance.status()),
      releaseId: this.releaseId,
      releasePath: this.releasePath,
      retirementError: this.retirementError,
      revision: this.revision,
      state: this.state,
      stoppedAt: this.stoppedAt
    }
  }
}
