// @ts-check

import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import httpProxy from "http-proxy"
import EventLog from "./event-log.js"
import ReleaseGroup from "./release-group.js"
import {clearState, liveProcesses, readState, writeState} from "./state-store.js"
import {resolveGroupId, resolveUserId} from "./system-ids.js"

const EVENT_HISTORY_LIMIT = 1000
const STATE_PERSIST_INTERVAL_MS = 5000

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {{releaseId?: string, releasePath: string, revision?: string}} DeployArgs
 * @typedef {{id: string, process: import("./managed-process.js").ManagedProcessStatus}} ProcessStatus
 * @typedef {{activeReleaseId: string | null, application: string, control: import("./config.js").ControlConfig, proxy: {host: string, port: number | undefined, upstreamHost: string}, releases: import("./release-group.js").ReleaseStatus[], services: ProcessStatus[], singletons: ProcessStatus[]}} DaemonStatus
 */

export default class RollbridgeDaemon {
  /**
   * @param {object} args - Options.
   * @param {import("./config.js").RollbridgeConfig} args.config - Rollbridge config.
   * @param {(message: string, data?: Record<string, JsonValue>) => void} [args.logger] - Logger.
   */
  constructor({config, logger}) {
    this.config = config
    this.eventLog = new EventLog(EVENT_HISTORY_LIMIT)

    const baseLogger = logger || ((message, data = {}) => console.log(JSON.stringify({at: new Date().toISOString(), data, message})))

    // Every operational milestone is logged through this.logger, so recording here
    // gives a structured event history for free (deploys, switches, stops, crashes,
    // restarts, and failed commands).
    this.logger = /** @type {(message: string, data?: Record<string, JsonValue>) => void} */ ((message, data = {}) => {
      this.eventLog.record(message, data)
      baseLogger(message, data)
    })

    this.releases = /** @type {Map<string, ReleaseGroup>} */ (new Map())
    this.services = /** @type {Map<string, import("./managed-process.js").default>} */ (new Map())
    this.servicePorts = /** @type {Record<string, number>} */ ({})
    this.singletons = /** @type {Map<string, import("./managed-process.js").default>} */ (new Map())
    this.activeRelease = /** @type {ReleaseGroup | undefined} */ (undefined)
    this.proxy = httpProxy.createProxyServer({ws: true, xfwd: true})
    this.proxyServer = /** @type {http.Server | undefined} */ (undefined)
    this.controlServer = /** @type {net.Server | undefined} */ (undefined)
    this.proxyPort = /** @type {number | undefined} */ (undefined)
    this.stopping = false
    this.statePath = config.statePath
    this.persistTimer = /** @type {ReturnType<typeof setInterval> | undefined} */ (undefined)
    this.pendingWrite = /** @type {Promise<void> | undefined} */ (undefined)

    this.proxy.on("error", (error, req, res) => this.onProxyError(error, req, res))
  }

  /** @returns {Promise<void>} Starts proxy and control listeners. */
  async start() {
    await this.reportOrphans()
    await this.startProxy()
    await this.startControlServer()
    this.startStatePersistence()
  }

  /** @returns {Promise<void>} Starts the stable local proxy. */
  async startProxy() {
    const server = http.createServer((request, response) => this.proxyHttp(request, response))

    server.on("upgrade", (request, socket, head) => this.proxyWebSocket(request, socket, head))
    this.proxyServer = server

    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.config.proxy.port, this.config.proxy.host, () => {
        const address = server.address()
        this.proxyPort = address && typeof address === "object" ? address.port : this.config.proxy.port
        this.logger("proxy listening", {host: this.config.proxy.host, port: this.proxyPort})
        resolve(undefined)
      })
    })
  }

  /** @returns {Promise<void>} Starts the control socket. */
  async startControlServer() {
    const server = net.createServer((socket) => this.handleControlSocket(socket))

    this.controlServer = server
    await this.prepareControlSocketPath()

    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.config.control.path, () => {
        this.logger("control socket listening", {path: this.config.control.path})
        resolve(undefined)
      })
    })

    if (this.config.control.mode !== undefined) {
      await fs.chmod(this.config.control.path, this.config.control.mode)
    }

    await this.applyControlSocketOwnership()
  }

  /**
   * Applies control.owner/control.group to the bound socket via chown, resolving names to ids.
   * @returns {Promise<void>} Resolves once ownership is applied (no-op when neither is set).
   */
  async applyControlSocketOwnership() {
    const {group, owner, path: socketPath} = this.config.control

    if (owner === undefined && group === undefined) return

    // -1 leaves the uid/gid unchanged (POSIX chown semantics).
    const uid = owner === undefined ? -1 : resolveUserId(owner)
    const gid = group === undefined ? -1 : resolveGroupId(group)

    try {
      await fs.chown(socketPath, uid, gid)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)

      throw new Error(`Could not set control socket owner/group on ${socketPath}: ${reason}. Run the daemon as a user allowed to chown it (for example root, or a member of the target group).`, {cause: error})
    }
  }

  /** @returns {Promise<void>} Removes a stale Unix socket before binding, or fails clearly when a daemon is alive. */
  async prepareControlSocketPath() {
    const existing = await inspectControlSocket(this.config.control.path)

    if (existing.alive) {
      throw new Error(controlSocketBusyMessage(this.config.control.path, existing))
    }

    try {
      await fs.rm(this.config.control.path, {force: true})
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
      throw error
    }
  }

  /**
   * @param {http.IncomingMessage} request - Client request.
   * @param {http.ServerResponse} response - Client response.
   * @returns {void}
   */
  proxyHttp(request, response) {
    const release = this.activeRelease

    if (!release) {
      response.writeHead(503, {"Content-Type": "text/plain; charset=utf-8"})
      response.end("No active release\n")
      return
    }

    const {target} = release.proxyTarget()
    const releaseConnection = release.retainConnection("http")
    let released = false
    const done = () => {
      if (released) return

      released = true
      releaseConnection()
    }

    response.once("finish", done)
    response.once("close", done)
    this.proxy.web(request, response, {target})
  }

  /**
   * @param {http.IncomingMessage} request - Client request.
   * @param {import("node:stream").Duplex} socket - Client socket.
   * @param {Buffer} head - Upgrade head.
   * @returns {void}
   */
  proxyWebSocket(request, socket, head) {
    const release = this.activeRelease

    if (!release) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n")
      return
    }

    const {target} = release.proxyTarget()
    const releaseConnection = release.retainConnection("websocket")
    socket.once("close", releaseConnection)
    this.proxy.ws(request, socket, head, {target})
  }

  /**
   * @param {Error} error - Proxy error.
   * @param {http.IncomingMessage} _request - Client request.
   * @param {http.ServerResponse | import("node:net").Socket} response - Response or socket.
   * @returns {void}
   */
  onProxyError(error, _request, response) {
    this.logger("proxy error", {error: error.message})

    if ("writeHead" in response && !response.headersSent) {
      response.writeHead(502, {"Content-Type": "text/plain; charset=utf-8"})
      response.end("Bad gateway\n")
      return
    }

    if ("destroy" in response) {
      response.destroy()
    }
  }

  /**
   * @param {import("node:net").Socket} socket - Control socket.
   * @returns {void}
   */
  handleControlSocket(socket) {
    socket.setEncoding("utf8")
    let buffer = ""

    socket.on("data", (chunk) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf("\n")

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        this.handleControlLine(line, socket)
        newlineIndex = buffer.indexOf("\n")
      }
    })
  }

  /**
   * @param {string} line - JSON command line.
   * @param {import("node:net").Socket} socket - Control socket.
   * @returns {void}
   */
  handleControlLine(line, socket) {
    this.executeControlLine(line)
      .then((response) => socket.write(`${JSON.stringify({status: "success", ...response})}\n`))
      .catch((error) => {
        this.logger("command failed", {error: error instanceof Error ? error.message : String(error)})
        socket.write(`${JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          status: "error"
        })}\n`)
      })
  }

  /**
   * @param {string} line - JSON command line.
   * @returns {Promise<Record<string, JsonValue>>} Command response.
   */
  async executeControlLine(line) {
    const command = JSON.parse(line)

    if (!command || typeof command !== "object") {
      throw new Error("Control command must be an object")
    }

    const data = /** @type {Record<string, JsonValue>} */ (command)
    const commandName = data.command

    if (commandName === "deploy") {
      return await this.deploy({
        releaseId: stringOrUndefined(data.releaseId),
        releasePath: requiredString(data.releasePath, "releasePath"),
        revision: stringOrUndefined(data.revision)
      })
    }

    if (commandName === "status") {
      return this.status()
    }

    if (commandName === "events") {
      return {events: this.eventLog.recent(typeof data.limit === "number" ? data.limit : undefined)}
    }

    if (commandName === "stop") {
      await this.stopRelease(stringOrUndefined(data.releaseId))
      return this.status()
    }

    if (commandName === "restart") {
      return await this.restartProcesses({
        policy: stringOrUndefined(data.policy),
        processId: stringOrUndefined(data.processId)
      })
    }

    if (commandName === "rollback") {
      return await this.rollback({releaseId: stringOrUndefined(data.releaseId)})
    }

    if (commandName === "shutdown") {
      setImmediate(() => {
        this.shutdown().catch((error) => {
          this.logger("shutdown failed", {error: error instanceof Error ? error.message : String(error)})
        })
      })

      return {message: "shutdown"}
    }

    throw new Error(`Unknown command: ${String(commandName)}`)
  }

  /**
   * Starts a new release, switches traffic, and drains the previous release.
   * @param {DeployArgs} args - Deploy args.
   * @returns {Promise<Record<string, JsonValue>>} Deploy result.
   */
  async deploy({releaseId, releasePath, revision}) {
    if (this.stopping) throw new Error("Rollbridge is shutting down")

    const newReleaseId = releaseId || revision || new Date().toISOString().replace(/[^0-9]/g, "")
    const release = new ReleaseGroup({
      config: this.config,
      logger: this.logger,
      releaseId: newReleaseId,
      releasePath,
      revision,
      servicePorts: this.servicePorts
    })

    this.logger("deploy starting", {releaseId: newReleaseId, releasePath, revision})
    const startedServices = /** @type {string[]} */ ([])

    try {
      await this.ensureServices(release, startedServices)
      await release.start()
    } catch (error) {
      this.logger("deploy failed", {error: error instanceof Error ? error.message : String(error), releaseId: newReleaseId})
      await this.stopStartedServices(startedServices)
      throw error
    }

    const previousRelease = this.activeRelease

    this.releases.set(release.releaseId, release)
    release.activate()
    this.activeRelease = release
    this.logger("traffic switched", {previousReleaseId: previousRelease ? previousRelease.releaseId : null, releaseId: release.releaseId})

    this.refreshServiceDefinitions(release)
    await this.replaceSingletons(release)

    if (previousRelease) {
      void this.drainAndPrune(previousRelease)
    }

    this.persistState()

    return {
      activeReleaseId: release.releaseId,
      previousReleaseId: previousRelease ? previousRelease.releaseId : null
    }
  }

  /**
   * Rolls back to a previously-active release by re-running the deploy flow on its
   * retained metadata: it re-starts the target release, health-checks it, switches
   * traffic, replaces singletons, and drains the current release — just like a deploy,
   * so a failed rollback leaves the current release active.
   * @param {{releaseId?: string}} [args] - Target release id; defaults to the most recently retired release.
   * @returns {Promise<Record<string, JsonValue>>} The rollback result.
   */
  async rollback({releaseId} = {}) {
    const target = releaseId ? this.releases.get(releaseId) : this.previousRelease()

    if (!target) {
      throw new Error(releaseId ? `No retained release "${releaseId}" to roll back to.` : "No previous release to roll back to.")
    }

    if (target === this.activeRelease) {
      throw new Error(`Release "${target.releaseId}" is already active.`)
    }

    // The target may still be draining a prior deploy (live processes). Stop it before the
    // deploy below re-uses its id in this.releases, otherwise the still-running instance
    // would be dropped from status/pruning/shutdown and could be orphaned.
    if (target.state !== "stopped" && target.state !== "failed") {
      await target.stop()
    }

    this.logger("rollback starting", {releaseId: target.releaseId, releasePath: target.releasePath})

    return await this.deploy({releaseId: target.releaseId, releasePath: target.releasePath, revision: target.revision})
  }

  /**
   * @returns {ReleaseGroup | undefined} The most recently active release other than the current one, if any.
   */
  previousRelease() {
    /** @type {ReleaseGroup | undefined} */
    let previous

    for (const release of this.releases.values()) {
      if (release === this.activeRelease || !release.activatedAt) continue
      if (!previous || Date.parse(release.activatedAt) >= Date.parse(/** @type {string} */ (previous.activatedAt))) previous = release
    }

    return previous
  }

  /**
   * Starts missing daemon-wide services before release-owned processes need them.
   * @param {ReleaseGroup} release - Release providing templates and ports.
   * @param {string[]} startedServices - Service ids started by this deploy.
   * @returns {Promise<void>} Resolves when missing services are running.
   */
  async ensureServices(release, startedServices) {
    await release.allocatePorts()

    for (const processConfig of this.config.processes) {
      if (processConfig.policy !== "service") continue
      if (this.services.has(processConfig.id)) continue

      const service = release.buildProcess(processConfig, {shouldRestart: () => !this.stopping})

      this.services.set(processConfig.id, service)

      if (release.ports[processConfig.id] !== undefined) {
        this.servicePorts[processConfig.id] = release.ports[processConfig.id]
      }

      try {
        await service.start("deploy")
        startedServices.push(processConfig.id)
      } catch (error) {
        this.services.delete(processConfig.id)
        delete this.servicePorts[processConfig.id]
        throw error
      }
    }
  }

  /**
   * Stops services that were started for a failed deploy.
   * @param {string[]} startedServices - Service ids started by the failed deploy.
   * @returns {Promise<void>} Resolves when cleanup finishes.
   */
  async stopStartedServices(startedServices) {
    for (const serviceId of startedServices) {
      const service = this.services.get(serviceId)

      if (!service) continue

      await service.stop()
      this.services.delete(serviceId)
      delete this.servicePorts[serviceId]
    }
  }

  /**
   * Updates daemon-wide service restart templates after a successful deploy.
   * @param {ReleaseGroup} release - Active release.
   * @returns {void}
   */
  refreshServiceDefinitions(release) {
    for (const processConfig of this.config.processes) {
      if (processConfig.policy !== "service") continue

      const service = this.services.get(processConfig.id)

      if (!service) continue

      const nextDefinition = release.buildProcess(processConfig, {shouldRestart: () => !this.stopping})

      service.updateDefinition({
        command: nextDefinition.command,
        cwd: nextDefinition.cwd,
        env: nextDefinition.env,
        lifecycle: nextDefinition.lifecycle,
        logger: nextDefinition.logger,
        memory: nextDefinition.memory,
        outputLines: nextDefinition.outputLines,
        restart: nextDefinition.restart,
        restartDelayMs: nextDefinition.restartDelayMs,
        shouldRestart: nextDefinition.shouldRestart,
        stopSignal: nextDefinition.stopSignal,
        stopTimeoutMs: nextDefinition.stopTimeoutMs
      })
    }
  }

  /**
   * Restarts singleton processes for the new release without overlapping old singleton processes.
   * @param {ReleaseGroup} release - Active release.
   * @returns {Promise<void>} Resolves when singletons have been replaced.
   */
  async replaceSingletons(release) {
    for (const processConfig of this.config.processes) {
      if (processConfig.policy !== "singleton") continue

      const previous = this.singletons.get(processConfig.id)

      if (previous) {
        await previous.stop()
      }

      const singleton = release.buildProcess(processConfig)

      this.singletons.set(processConfig.id, singleton)
      await singleton.start("deploy")
    }
  }

  /**
   * Restarts non-proxied processes selected by id or policy, or all of them: running
   * processes are bounced (stop then start) and crashed or stopped ones are revived,
   * matching the conventional meaning of "restart".
   *
   * The proxied process is never restarted in place (that would drop traffic); use a
   * deploy for a zero-downtime replacement.
   * @param {{policy?: string, processId?: string}} selector - Restart selector; restarts all non-proxied processes when both are omitted.
   * @returns {Promise<Record<string, JsonValue>>} The ids that were restarted.
   */
  async restartProcesses({policy, processId} = {}) {
    if (policy === "proxied" || (processId !== undefined && this.isProxiedId(processId))) {
      throw new Error('The proxied process cannot be restarted in place; use "rollbridge deploy" for a zero-downtime replacement.')
    }

    const targets = this.collectRestartTargets({policy, processId})

    if (processId !== undefined && targets.length === 0) {
      throw new Error(`No managed process with id "${processId}" to restart.`)
    }

    for (const target of targets) {
      this.logger("process restart requested", {processId: target.id})
      await target.process.stop()
      await target.process.start("manual")
    }

    return {restarted: targets.map((target) => target.id)}
  }

  /**
   * @param {{policy?: string, processId?: string}} selector - Restart selector.
   * @returns {{id: string, process: import("./managed-process.js").default}[]} Running non-proxied processes matching the selector.
   */
  collectRestartTargets({policy, processId}) {
    const targets = /** @type {{id: string, process: import("./managed-process.js").default}[]} */ ([])

    for (const processConfig of this.config.processes) {
      if (processConfig.policy === "proxied") continue
      if (policy !== undefined && processConfig.policy !== policy) continue

      for (const instance of this.runningInstances(processConfig)) {
        // A processId selector matches the base config id (all replicas) or one replica's id.
        if (processId !== undefined && processId !== processConfig.id && processId !== instance.id) continue

        targets.push(instance)
      }
    }

    return targets
  }

  /**
   * @param {import("./config.js").ProcessConfig} processConfig - Process definition.
   * @returns {{id: string, process: import("./managed-process.js").default}[]} Running instances (replicas) for this config.
   */
  runningInstances(processConfig) {
    if (processConfig.policy === "service") {
      const service = this.services.get(processConfig.id)

      return service ? [{id: processConfig.id, process: service}] : []
    }

    if (processConfig.policy === "singleton") {
      const singleton = this.singletons.get(processConfig.id)

      return singleton ? [{id: processConfig.id, process: singleton}] : []
    }

    return this.activeRelease ? this.activeRelease.getProcesses(processConfig.id) : []
  }

  /**
   * @param {string} id - Process id.
   * @returns {boolean} True when the id belongs to the proxied process.
   */
  isProxiedId(id) {
    return this.config.processes.some((processConfig) => processConfig.policy === "proxied" && processConfig.id === id)
  }

  /**
   * @param {string | undefined} releaseId - Release id, or active release when omitted.
   * @returns {Promise<void>} Resolves when stopped.
   */
  async stopRelease(releaseId) {
    const release = releaseId ? this.releases.get(releaseId) : this.activeRelease

    if (!release) throw new Error(`Release not found: ${releaseId || "active"}`)
    if (release === this.activeRelease) this.activeRelease = undefined

    await release.stop()
    this.logger("release stopped", {releaseId: release.releaseId})
    this.pruneStoppedReleases()
    this.persistState()
  }

  /**
   * Drains and stops a retired release in the background, then prunes stopped releases.
   * @param {ReleaseGroup} release - Release to drain and stop.
   * @returns {Promise<void>} Resolves once drained, stopped, and pruned.
   */
  async drainAndPrune(release) {
    try {
      await release.drainAndStop(this.config.proxy.drainTimeoutMs)
      this.logger("release drained", {releaseId: release.releaseId})
    } catch (error) {
      this.logger("release drain failed", {error: error instanceof Error ? error.message : String(error), releaseId: release.releaseId})
    } finally {
      this.pruneStoppedReleases()
      this.persistState()
    }
  }

  /** @returns {void} Removes stopped releases beyond the retention policy. */
  pruneStoppedReleases() {
    const statuses = [...this.releases.values()].map((release) => release.status())

    for (const releaseId of releasesToPrune(statuses, this.config.releaseRetention, Date.now())) {
      this.releases.delete(releaseId)
    }
  }

  /** @returns {void} Starts periodic state persistence when statePath is configured. */
  startStatePersistence() {
    if (!this.statePath) return

    this.persistState()
    this.persistTimer = setInterval(() => this.persistState(), STATE_PERSIST_INTERVAL_MS)
    this.persistTimer.unref?.()
  }

  /**
   * Persists a state snapshot (status plus recent events) to statePath, atomically and
   * fire-and-forget. A failed write is logged but never blocks daemon operation.
   * @returns {void}
   */
  persistState() {
    if (!this.statePath || this.stopping) return

    const statePath = this.statePath
    const snapshot = {...this.status(), events: this.eventLog.recent(), persistedAt: new Date().toISOString()}

    // Serialize writes (and track the tail) so shutdown can wait for an in-flight write before
    // clearing the file — otherwise a write started before shutdown could recreate it afterward.
    this.pendingWrite = Promise.resolve(this.pendingWrite)
      .catch(() => {})
      .then(() => writeState(statePath, snapshot))
      .catch((error) => {
        this.logger("state persist failed", {error: error instanceof Error ? error.message : String(error)})
      })
  }

  /**
   * On startup, reads any state left by a previous daemon and reports managed processes whose
   * pids are still alive — likely orphans from a daemon that did not shut down cleanly. This is
   * advisory (Rollbridge cannot re-adopt detached children); the operator stops the leftovers.
   * A recycled pid could be a false positive, so reports are a prompt to investigate.
   * @returns {Promise<void>} Resolves once orphans are reported.
   */
  async reportOrphans() {
    if (!this.statePath) return

    const orphans = liveProcesses(await readState(this.statePath))

    for (const orphan of orphans) {
      this.logger("orphaned managed process detected", {pid: orphan.pid, processId: orphan.id, releaseId: orphan.releaseId})
    }

    if (orphans.length > 0) {
      this.logger("orphaned processes from a previous daemon", {count: orphans.length, hint: "a previous daemon did not shut down cleanly; verify these pids and stop any leftovers"})
    }
  }

  /** @returns {Promise<void>} Stops proxy, control socket, and child processes. */
  async shutdown() {
    if (this.stopping) return

    this.stopping = true

    if (this.persistTimer) {
      clearInterval(this.persistTimer)
      this.persistTimer = undefined
    }

    this.proxy.close()
    await Promise.allSettled([...this.services.values()].map((processInstance) => processInstance.stop()))
    await Promise.allSettled([...this.singletons.values()].map((processInstance) => processInstance.stop()))
    await Promise.allSettled([...this.releases.values()].map((release) => release.stop()))
    await this.closeServer(this.proxyServer)
    await this.closeServer(this.controlServer)
    await fs.rm(this.config.control.path, {force: true})

    // A clean shutdown leaves no orphans, so remove the state file rather than leaving stale
    // pids. Wait for any in-flight write first so it can't recreate the file afterward (no new
    // writes start: stopping is set and the persist timer is cleared above).
    if (this.statePath) {
      if (this.pendingWrite) await this.pendingWrite
      await clearState(this.statePath)
    }
  }

  /**
   * @param {net.Server | http.Server | undefined} server - Server.
   * @returns {Promise<void>} Resolves when closed.
   */
  async closeServer(server) {
    if (!server || !server.listening) return

    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }

  /** @returns {number | undefined} Current proxy port. */
  getProxyPort() {
    return this.proxyPort
  }

  /** @returns {DaemonStatus} Status payload. */
  status() {
    return {
      activeReleaseId: this.activeRelease ? this.activeRelease.releaseId : null,
      application: this.config.application,
      control: {...this.config.control},
      proxy: {
        host: this.config.proxy.host,
        port: this.proxyPort ?? this.config.proxy.port,
        upstreamHost: this.config.proxy.upstreamHost
      },
      releases: [...this.releases.values()].map((release) => release.status()),
      services: [...this.services.entries()].map(([id, processInstance]) => ({
        id,
        process: processInstance.status()
      })),
      singletons: [...this.singletons.entries()].map(([id, processInstance]) => ({
        id,
        process: processInstance.status()
      }))
    }
  }
}

/**
 * @param {JsonValue} value - Value.
 * @returns {string | undefined} String value.
 */
function stringOrUndefined(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Error("Expected string value")

  return value
}

/**
 * @param {JsonValue} value - Value.
 * @param {string} key - Key.
 * @returns {string} String value.
 */
function requiredString(value, key) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`)
  }

  return value
}

/**
 * @typedef {{releaseId: string, state: string, stoppedAt: string | undefined}} PrunableRelease
 */

/**
 * Selects stopped releases to prune by the retention policy, keeping the most recent.
 * @param {PrunableRelease[]} releases - Status of all tracked releases, in deploy order (oldest first).
 * @param {import("./config.js").ReleaseRetentionConfig} policy - Retention policy.
 * @param {number} now - Current epoch milliseconds.
 * @returns {string[]} Release ids to remove.
 */
export function releasesToPrune(releases, policy, now) {
  const stopped = releases
    .filter((release) => release.state === "stopped")
    .map((release, index) => ({deployOrder: index, releaseId: release.releaseId, stoppedAtMs: release.stoppedAt ? Date.parse(release.stoppedAt) : 0}))
    // Most recent first; ties (same stoppedAt millisecond) prefer the later-deployed release.
    .sort((first, second) => second.stoppedAtMs - first.stoppedAtMs || second.deployOrder - first.deployOrder)

  /** @type {string[]} */
  const remove = []

  stopped.forEach((release, index) => {
    const beyondKeep = index >= policy.keep
    const tooOld = policy.maxAgeMs > 0 && release.stoppedAtMs > 0 && now - release.stoppedAtMs > policy.maxAgeMs

    if (beyondKeep || tooOld) remove.push(release.releaseId)
  })

  return remove
}

/**
 * @typedef {{alive: boolean, application?: string, activeReleaseId?: string | null}} ControlSocketInspection
 */

/**
 * Builds an operator-facing message explaining why the control socket cannot be bound.
 * @param {string} socketPath - Control socket path.
 * @param {ControlSocketInspection} inspection - Result of probing the socket.
 * @returns {string} Diagnostic message.
 */
function controlSocketBusyMessage(socketPath, inspection) {
  if (inspection.application === undefined) {
    return `The control socket ${socketPath} is already in use by another process. Stop that process or set a different control.path.`
  }

  const releaseDetail = inspection.activeReleaseId ? `active release: ${inspection.activeReleaseId}` : "no active release"

  return `A Rollbridge daemon for application "${inspection.application}" is already running on ${socketPath} (${releaseDetail}). ` +
    `Run "rollbridge status" to inspect it or "rollbridge shutdown" to stop it, or set a different control.path.`
}

/**
 * Probes an existing control socket to see whether a daemon is alive, and identifies it when it is Rollbridge.
 * @param {string} socketPath - Control socket path.
 * @param {number} [timeoutMs] - How long to wait for a status response before treating the socket as busy.
 * @returns {Promise<ControlSocketInspection>} Whether the socket is live and, when it is Rollbridge, its identity.
 */
export async function inspectControlSocket(socketPath, timeoutMs = 1000) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ""
    let settled = false
    let timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined)

    const finish = (/** @type {ControlSocketInspection} */ result) => {
      if (settled) return

      settled = true
      if (timer) clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    timer = setTimeout(() => finish({alive: true}), timeoutMs)
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(`${JSON.stringify({command: "status"})}\n`))
    socket.on("data", (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf("\n")

      if (newlineIndex < 0) return

      const status = parseControlStatus(buffer.slice(0, newlineIndex))

      finish(status ? {activeReleaseId: status.activeReleaseId, alive: true, application: status.application} : {alive: true})
    })
    socket.once("error", (error) => {
      if (settled) return

      if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        settled = true
        if (timer) clearTimeout(timer)
        resolve({alive: false})
        return
      }

      settled = true
      if (timer) clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * Parses a control status response line into a Rollbridge identity, if it is one.
 * @param {string} line - JSON response line.
 * @returns {{application: string, activeReleaseId: string | null} | undefined} Identity, or undefined when unrecognized.
 */
function parseControlStatus(line) {
  /** @type {JsonValue} */
  let parsed

  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  if (typeof parsed.application !== "string") return undefined

  return {activeReleaseId: typeof parsed.activeReleaseId === "string" ? parsed.activeReleaseId : null, application: parsed.application}
}
