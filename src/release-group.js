// @ts-check

import {EventEmitter} from "node:events"
import ManagedProcess from "./managed-process.js"
import {findAvailablePort} from "./port-allocator.js"
import {renderObject, renderTemplate} from "./template.js"
import {waitForHealth} from "./health.js"

/**
 * @typedef {"starting" | "active" | "draining" | "stopped" | "failed"} ReleaseState
 */

/**
 * @param {string} id - Process id.
 * @returns {string} Environment suffix.
 */
function envId(id) {
  return id.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()
}

export default class ReleaseGroup extends EventEmitter {
  /**
   * @param {object} args - Options.
   * @param {import("./config.js").SwitchyardConfig} args.config - Switchyard config.
   * @param {(message: string, data?: Record<string, unknown>) => void} args.logger - Logger.
   * @param {string} args.releaseId - Release id.
   * @param {string} args.releasePath - Release path.
   * @param {string | undefined} args.revision - Revision.
   */
  constructor({config, logger, releaseId, releasePath, revision}) {
    super()

    this.config = config
    this.logger = logger
    this.releaseId = releaseId
    this.releasePath = releasePath
    this.revision = revision || releaseId
    this.state = /** @type {ReleaseState} */ ("starting")
    this.connectionCount = 0
    this.connections = {http: 0, websocket: 0}
    this.processes = new Map()
    this.ports = {}
    this.drainStartedAt = undefined
    this.activatedAt = undefined
    this.stoppedAt = undefined
  }

  /** @returns {Promise<void>} Starts release-owned processes and health checks the proxied process. */
  async start() {
    this.state = "starting"

    try {
      await this.allocatePorts()

      for (const processConfig of this.config.processes) {
        if (processConfig.policy === "singleton") continue

        const processInstance = this.buildProcess(processConfig)
        this.processes.set(processConfig.id, processInstance)
        await processInstance.start()

        if (processConfig.policy === "proxied" && processConfig.port && processConfig.health) {
          await waitForHealth({
            health: processConfig.health,
            host: this.config.proxy.host,
            port: this.ports[processConfig.id]
          })
        }
      }
    } catch (error) {
      this.state = "failed"
      await this.stop()
      throw error
    }
  }

  /** @returns {void} Marks this release active. */
  activate() {
    this.state = "active"
    this.activatedAt = new Date().toISOString()
  }

  /** @returns {Promise<void>} Allocates all configured per-process ports. */
  async allocatePorts() {
    const usedPorts = new Set()

    for (const processConfig of this.config.processes) {
      if (!processConfig.port) continue

      this.ports[processConfig.id] = await findAvailablePort({
        host: this.config.proxy.host,
        range: processConfig.port,
        usedPorts
      })
    }
  }

  /**
   * Builds a managed process from config.
   * @param {import("./config.js").ProcessConfig} processConfig - Process config.
   * @returns {ManagedProcess} Managed process.
   */
  buildProcess(processConfig) {
    const context = this.contextForProcess(processConfig)
    const renderedEnv = /** @type {Record<string, string>} */ (renderObject(processConfig.env, context))
    const processEnv = {
      ...this.baseEnvironment(processConfig),
      ...renderedEnv
    }

    return new ManagedProcess({
      command: renderTemplate(processConfig.command, context),
      cwd: processConfig.cwd ? renderTemplate(processConfig.cwd, context) : this.releasePath,
      env: processEnv,
      id: processConfig.id,
      logger: (message, data = {}) => this.logger(message, {processId: processConfig.id, releaseId: this.releaseId, ...data}),
      restartDelayMs: processConfig.restartDelayMs,
      shouldRestart: () => this.state === "active" || this.state === "starting",
      stopTimeoutMs: processConfig.gracefulStopMs
    })
  }

  /**
   * @param {import("./config.js").ProcessConfig} processConfig - Process config.
   * @returns {Record<string, string>} Base environment.
   */
  baseEnvironment(processConfig) {
    /** @type {Record<string, string>} */
    const env = {
      SWITCHYARD_APPLICATION: this.config.application,
      SWITCHYARD_PROCESS_ID: processConfig.id,
      SWITCHYARD_RELEASE_ID: this.releaseId,
      SWITCHYARD_RELEASE_PATH: this.releasePath,
      SWITCHYARD_REVISION: this.revision
    }

    if (this.ports[processConfig.id] !== undefined) {
      env.SWITCHYARD_PORT = String(this.ports[processConfig.id])
    }

    for (const [processId, port] of Object.entries(this.ports)) {
      env[`SWITCHYARD_${envId(processId)}_PORT`] = String(port)
    }

    return env
  }

  /**
   * @param {import("./config.js").ProcessConfig} processConfig - Process config.
   * @returns {Record<string, unknown>} Template context.
   */
  contextForProcess(processConfig) {
    return {
      application: this.config.application,
      port: this.ports[processConfig.id],
      ports: this.ports,
      processId: processConfig.id,
      proxy: {
        host: this.config.proxy.host,
        port: this.config.proxy.port
      },
      releaseId: this.releaseId,
      releasePath: this.releasePath,
      revision: this.revision
    }
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
      target: `http://${this.config.proxy.host}:${port}`
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
   * Starts draining and stops once existing connections close or timeout.
   * @param {number} timeoutMs - Drain timeout.
   * @returns {Promise<void>} Resolves when stopped.
   */
  async drainAndStop(timeoutMs) {
    if (this.state === "stopped") return

    this.state = "draining"
    this.drainStartedAt = new Date().toISOString()

    if (this.connectionCount > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        this.once("drained", () => {
          clearTimeout(timer)
          resolve(undefined)
        })
      })
    }

    await this.stop()
  }

  /** @returns {Promise<void>} Stops all release-owned processes. */
  async stop() {
    const stopTasks = [...this.processes.values()].map((processInstance) => processInstance.stop())

    await Promise.allSettled(stopTasks)
    this.state = "stopped"
    this.stoppedAt = new Date().toISOString()
  }

  /** @returns {Record<string, unknown>} Status payload. */
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
      revision: this.revision,
      state: this.state,
      stoppedAt: this.stoppedAt
    }
  }
}
