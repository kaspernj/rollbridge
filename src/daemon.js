// @ts-check

import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import httpProxy from "http-proxy"
import ReleaseGroup from "./release-group.js"

/**
 * @typedef {{releaseId?: string, releasePath: string, revision?: string}} DeployArgs
 */

export default class RollbridgeDaemon {
  /**
   * @param {object} args - Options.
   * @param {import("./config.js").RollbridgeConfig} args.config - Rollbridge config.
   * @param {(message: string, data?: Record<string, unknown>) => void} [args.logger] - Logger.
   */
  constructor({config, logger}) {
    this.config = config
    this.logger = logger || ((message, data = {}) => console.log(JSON.stringify({at: new Date().toISOString(), data, message})))
    this.releases = new Map()
    this.singletons = new Map()
    this.activeRelease = undefined
    this.proxy = httpProxy.createProxyServer({ws: true, xfwd: true})
    this.proxyServer = undefined
    this.controlServer = undefined
    this.proxyPort = undefined
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

  /** @returns {Promise<void>} Removes a stale Unix socket before binding. */
  async prepareControlSocketPath() {
    if (await controlSocketAcceptsConnections(this.config.control.path)) {
      throw new Error(`Control socket already accepts connections: ${this.config.control.path}`)
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
   * @param {import("node:net").Socket} socket - Client socket.
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
   * @returns {Promise<Record<string, unknown>>} Command response.
   */
  async executeControlLine(line) {
    const command = JSON.parse(line)

    if (!command || typeof command !== "object") {
      throw new Error("Control command must be an object")
    }

    const data = /** @type {Record<string, unknown>} */ (command)
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
      await this.shutdown()
      return {message: "shutdown"}
    }

    throw new Error(`Unknown command: ${String(commandName)}`)
  }

  /**
   * Starts a new release, switches traffic, and drains the previous release.
   * @param {DeployArgs} args - Deploy args.
   * @returns {Promise<Record<string, unknown>>} Deploy result.
   */
  async deploy({releaseId, releasePath, revision}) {
    if (this.stopping) throw new Error("Rollbridge is shutting down")

    const newReleaseId = releaseId || revision || new Date().toISOString().replace(/[^0-9]/g, "")
    const release = new ReleaseGroup({
      config: this.config,
      logger: this.logger,
      releaseId: newReleaseId,
      releasePath,
      revision
    })

    this.logger("deploy starting", {releaseId: newReleaseId, releasePath, revision})
    await release.start()

    const previousRelease = this.activeRelease

    this.releases.set(release.releaseId, release)
    release.activate()
    this.activeRelease = release
    this.logger("traffic switched", {previousReleaseId: previousRelease ? previousRelease.releaseId : null, releaseId: release.releaseId})

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

  /** @returns {Record<string, unknown>} Status payload. */
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
      singletons: [...this.singletons.entries()].map(([id, processInstance]) => ({
        id,
        process: processInstance.status()
      }))
    }
  }
}

/**
 * @param {unknown} value - Value.
 * @returns {string | undefined} String value.
 */
function stringOrUndefined(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Error("Expected string value")

  return value
}

/**
 * @param {unknown} value - Value.
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
 * @param {string} socketPath - Control socket path.
 * @returns {Promise<boolean>} True when an existing daemon is reachable.
 */
async function controlSocketAcceptsConnections(socketPath) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)

    socket.once("connect", () => {
      socket.end()
      resolve(true)
    })
    socket.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          resolve(false)
          return
        }
      }

      reject(error)
    })
  })
}
