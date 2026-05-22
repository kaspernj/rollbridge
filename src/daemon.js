// @ts-check

import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import httpProxy from "http-proxy"
import ReleaseGroup from "./release-group.js"

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {{releaseId?: string, releasePath: string, revision?: string}} DeployArgs
 * @typedef {{id: string, process: import("./managed-process.js").ManagedProcessStatus}} ProcessStatus
 * @typedef {{activeReleaseId: string | null, application: string, control: import("./config.js").ControlConfig, proxy: {host: string, port: number | undefined}, releases: import("./release-group.js").ReleaseStatus[], services: ProcessStatus[], singletons: ProcessStatus[]}} DaemonStatus
 */

export default class RollbridgeDaemon {
  /**
   * @param {object} args - Options.
   * @param {import("./config.js").RollbridgeConfig} args.config - Rollbridge config.
   * @param {(message: string, data?: Record<string, JsonValue>) => void} [args.logger] - Logger.
   */
  constructor({config, logger}) {
    this.config = config
    this.logger = logger || ((message, data = {}) => console.log(JSON.stringify({at: new Date().toISOString(), data, message})))
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

    this.proxy.on("error", (error, req, res) => this.onProxyError(error, req, res))
  }

  /** @returns {Promise<void>} Starts proxy and control listeners. */
  async start() {
    await this.startProxy()
    await this.startControlServer()
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

    if (commandName === "stop") {
      await this.stopRelease(stringOrUndefined(data.releaseId))
      return this.status()
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
      previousRelease.drainAndStop(this.config.proxy.drainTimeoutMs).catch((error) => {
        this.logger("release drain failed", {error: error instanceof Error ? error.message : String(error), releaseId: previousRelease.releaseId})
      })
    }

    return {
      activeReleaseId: release.releaseId,
      previousReleaseId: previousRelease ? previousRelease.releaseId : null
    }
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
        await service.start()
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
        logger: nextDefinition.logger,
        outputLines: nextDefinition.outputLines,
        restartDelayMs: nextDefinition.restartDelayMs,
        shouldRestart: nextDefinition.shouldRestart,
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
      await singleton.start()
    }
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
  }

  /** @returns {Promise<void>} Stops proxy, control socket, and child processes. */
  async shutdown() {
    if (this.stopping) return

    this.stopping = true
    this.proxy.close()
    await Promise.allSettled([...this.services.values()].map((processInstance) => processInstance.stop()))
    await Promise.allSettled([...this.singletons.values()].map((processInstance) => processInstance.stop()))
    await Promise.allSettled([...this.releases.values()].map((release) => release.stop()))
    await this.closeServer(this.proxyServer)
    await this.closeServer(this.controlServer)
    await fs.rm(this.config.control.path, {force: true})
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
        port: this.proxyPort ?? this.config.proxy.port
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
async function inspectControlSocket(socketPath, timeoutMs = 1000) {
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
