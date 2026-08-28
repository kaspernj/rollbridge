// @ts-check

import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import crypto from "node:crypto"
import {isDeepStrictEqual} from "node:util"
import httpProxy from "http-proxy"
import {loadConfig} from "./config.js"
import EventLog from "./event-log.js"
import GuardianClient from "./guardian-client.js"
import ReleaseGroup from "./release-group.js"
import {clearState, isProcessAlive, liveProcesses, readState, writeState} from "./state-store.js"
import {resolveGroupId, resolveUserId} from "./system-ids.js"

const EVENT_HISTORY_LIMIT = 1000
const STATE_PERSIST_INTERVAL_MS = 5000

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {{releaseId?: string, releasePath: string, revision?: string}} DeployArgs
 * @typedef {{attestation?: string, releaseId: string, releasePath: string, revision: string}} BootstrapIdentity
 * @typedef {{id: string, process: import("./managed-process.js").ManagedProcessStatus}} ProcessStatus
 * @typedef {{activeReleaseId: string | null, application: string, bootstrap: BootstrapIdentity | undefined, control: import("./config.js").ControlConfig, daemonRuntime: import("./daemon-runtime.js").DaemonRuntimeIdentity | undefined, ownerRecovery: {configDigest: string} | undefined, orphans: {id: string, pid: number, releaseId: string | null}[], proxy: {host: string, port: number | undefined, upstreamHost: string}, releaseReferences: {releaseId: string, releasePath: string}[], releases: import("./release-group.js").ReleaseStatus[], services: ProcessStatus[], singletons: ProcessStatus[]}} DaemonStatus
 * @typedef {{configDigest: string, format: number, guardian: {pid?: number, socketPath: string, token: string}, reconnectGraceMs: number}} OwnerRecoveryMetadata
 * @typedef {DaemonStatus & {recovery: OwnerRecoveryMetadata}} OwnerRecoverySnapshot
 */

export default class RollbridgeDaemon {
  /**
   * @param {object} args - Options.
   * @param {BootstrapIdentity} [args.bootstrap] - Immutable known-release foreground bootstrap identity.
   * @param {import("./config.js").RollbridgeConfig} args.config - Rollbridge config.
   * @param {string} [args.configPath] - Config file path to reload before deploys.
   * @param {(message: string, data?: Record<string, JsonValue>) => void} [args.logger] - Logger.
   * @param {import("./daemon-runtime.js").DaemonRuntimeIdentity} [args.runtime] - Immutable daemon runtime identity.
   */
  constructor({bootstrap, config, configPath, logger, runtime}) {
    this.bootstrap = bootstrap ? {...bootstrap} : undefined
    this.config = config
    this.configPath = configPath
    this.runtime = runtime
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
    this.controlSocketOwned = false
    this.controlSockets = /** @type {Set<net.Socket>} */ (new Set())
    this.proxyPort = /** @type {number | undefined} */ (undefined)
    this.stopping = false
    this.statePath = config.statePath
    this.persistTimer = /** @type {ReturnType<typeof setInterval> | undefined} */ (undefined)
    this.persistenceEnabled = false
    this.pendingWrite = /** @type {Promise<void> | undefined} */ (undefined)
    this.stateCleanupEnabled = false
    this.shutdownPromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.retirementPromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.controlClosePromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.startingReleases = /** @type {Set<ReleaseGroup>} */ (new Set())
    this.guardian = /** @type {GuardianClient | undefined} */ (undefined)
    this.guardianIdentity = /** @type {{pid?: number, socketPath: string, token: string} | undefined} */ (undefined)
    // Still-alive managed processes left by a previous daemon (from statePath), captured at
    // startup and surfaced in status(). The daemon cannot re-manage them, only report them.
    this.orphans = /** @type {{id: string, pid: number, releaseId: string | null}[]} */ ([])

    this.proxy.on("error", (error, req, res) => this.onProxyError(error, req, res))
  }

  /**
   * Starts daemon listeners.
   * @param {{exposeControl?: boolean, reportOrphans?: boolean}} [options] - Listener startup options.
   * @returns {Promise<void>} Resolves when the requested listeners are ready.
   */
  async start({exposeControl = true, reportOrphans = true} = {}) {
    if (this.config.ownerRecovery) await this.initializeOwnerRecovery()
    else if (reportOrphans) await this.reportOrphans()
    await this.startProxy()
    if (exposeControl) await this.exposeControl()
  }

  /** Connects to the durable process guardian and reconstructs a matching persisted owner snapshot. */
  async initializeOwnerRecovery() {
    if (!this.statePath) throw new Error("ownerRecovery requires statePath")
    const state = await readState(this.statePath)
    const snapshot = state && typeof state === "object" && !Array.isArray(state) ? /** @type {OwnerRecoverySnapshot} */ (state) : undefined
    const recovery = snapshot?.recovery
    const configDigest = this.ownerRecoveryConfigDigest()

    if (snapshot && !recovery) throw new Error(`Owner recovery state ${this.statePath} is missing durable guardian identity; refusing to overwrite it.`)
    if (recovery && recovery.configDigest !== configDigest) throw new Error("Owner recovery config identity does not match the persisted owner; refusing cross-authority adoption.")
    if (snapshot && ((this.runtime?.digest ?? null) !== (snapshot.daemonRuntime?.digest ?? null))) {
      throw new Error("Owner recovery runtime identity does not match the persisted owner; use the exact same Rollbridge runtime.")
    }

    const guardianIdentity = recovery?.guardian || {
      socketPath: `${this.statePath}.guardian.sock`,
      token: crypto.randomBytes(32).toString("hex")
    }
    this.guardianIdentity = guardianIdentity
    this.guardian = new GuardianClient(guardianIdentity)
    if (recovery) await this.guardian.connect()
    else {
      await this.guardian.launch()
      guardianIdentity.pid = this.guardian.pid
    }
    await this.guardian.claimOwner(this.config.ownerRecovery?.reconnectGraceMs ?? 30000)

    if (snapshot) {
      await this.restoreOwnerState(snapshot)
      await this.guardian.reconcileInventory()
      for (const release of this.releases.values()) {
        if (release.state === "draining") void this.drainAndPrune(release, this.config)
      }
    }
    else {
      this.persistenceEnabled = true
      await this.persistState({throwOnError: true})
    }
    this.stateCleanupEnabled = true
  }

  /** @returns {string} Stable identity for same-authority recovery. */
  ownerRecoveryConfigDigest() {
    return crypto.createHash("sha256").update(JSON.stringify(this.config)).digest("hex")
  }

  /** @param {OwnerRecoverySnapshot} snapshot - Validated persisted owner state. */
  async restoreOwnerState(snapshot) {
    if (!Array.isArray(snapshot.releases) || (snapshot.activeReleaseId !== null && typeof snapshot.activeReleaseId !== "string")) {
      throw new Error("Owner recovery state is partial or corrupt; active release metadata is required.")
    }
    if (snapshot.activeReleaseId === null && snapshot.releases.length === 0) return
    this.bootstrap = snapshot.bootstrap ? {...snapshot.bootstrap} : undefined

    for (const releaseStatus of snapshot.releases) {
      if (releaseStatus.state !== "active" && releaseStatus.state !== "draining") continue
      const release = new ReleaseGroup({
        config: this.config,
        logger: this.logger,
        processFactory: (key, definition) => this.guardianProcess(key, definition),
        releaseId: releaseStatus.releaseId,
        releasePath: releaseStatus.releasePath,
        revision: releaseStatus.revision,
        servicePorts: this.servicePorts,
        shouldStart: () => !this.stopping
      })

      await release.restore(releaseStatus)
      this.releases.set(release.releaseId, release)
      if (release.releaseId === snapshot.activeReleaseId) this.activeRelease = release
    }

    if (snapshot.activeReleaseId !== null && !this.activeRelease) throw new Error(`Owner recovery state does not contain active release ${snapshot.activeReleaseId}.`)
    const definitionRelease = this.activeRelease || [...this.releases.values()].at(-1)
    if (!definitionRelease) throw new Error("Owner recovery state has no release definition for owned processes.")
    if (!this.activeRelease && snapshot.singletons.length > 0) throw new Error("Owner recovery state has release-owned singletons without an active release identity.")
    for (const serviceStatus of snapshot.services) {
      const processConfig = this.config.processes.find((candidate) => candidate.id === serviceStatus.id && candidate.policy === "service" && candidate.deployStrategy !== "handoff")

      if (!processConfig) throw new Error(`Owner recovery state contains unknown service ${serviceStatus.id}.`)
      const service = definitionRelease.buildProcess(processConfig, {guardianKey: `service:${serviceStatus.id}`, shouldRestart: () => !this.stopping})

      await this.recoverGuardianProcess(service)
      this.services.set(serviceStatus.id, service)
      if (definitionRelease.ports[serviceStatus.id] !== undefined) this.servicePorts[serviceStatus.id] = definitionRelease.ports[serviceStatus.id]
    }
    for (const singletonStatus of snapshot.singletons) {
      const processConfig = this.config.processes.find((candidate) => candidate.id === singletonStatus.id && candidate.policy === "singleton")

      if (!processConfig) throw new Error(`Owner recovery state contains unknown singleton ${singletonStatus.id}.`)
      const singleton = definitionRelease.buildProcess(processConfig, {guardianKey: `singleton:${definitionRelease.releaseId}:${singletonStatus.id}`})

      await this.recoverGuardianProcess(singleton)
      this.singletons.set(singletonStatus.id, singleton)
    }
    this.logger("owner state recovered", {activeReleaseId: this.activeRelease?.releaseId ?? null, releases: this.releases.size})
  }

  /**
   * @param {string} key - Guardian key.
   * @param {Parameters<GuardianClient["process"]>[1]} definition - Process definition.
   * @returns {import("./managed-process.js").default} Guardian-backed managed process.
   */
  guardianProcess(key, definition) {
    if (!this.guardian) throw new Error("Process guardian is not initialized")
    return this.guardian.process(key, definition)
  }

  /** @param {import("./managed-process.js").default} processInstance - Guardian-backed process. */
  async recoverGuardianProcess(processInstance) {
    if (!("recover" in processInstance) || typeof processInstance.recover !== "function") throw new Error(`Managed process ${processInstance.id} is not guardian-backed`)
    await processInstance.recover()
  }

  /** Releases only resources created by a fenced startup loser. */
  async abandonOwnerRecoveryAttempt() {
    this.guardian?.disconnect()
    await this.closeServer(this.proxyServer)
  }

  /** @returns {Promise<void>} Exposes control commands and begins periodic state persistence. */
  async exposeControl() {
    if (this.stopping) throw new Error("Rollbridge is shutting down")

    await this.startControlServer()

    if (this.stopping) {
      await this.closeServer(this.controlServer)
      await fs.rm(this.config.control.path, {force: true})
      throw new Error("Rollbridge is shutting down")
    }

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
        this.controlSocketOwned = true
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
    this.controlSockets.add(socket)
    socket.setEncoding("utf8")
    let buffer = ""

    socket.once("close", () => this.controlSockets.delete(socket))
    socket.on("error", (error) => {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null

      this.logger("control connection error", {code, error: error.message})
    })

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
    const closesConnection = isShutdownControlLine(line)
    const respond = (/** @type {Record<string, JsonValue>} */ response) => {
      const payload = `${JSON.stringify(response)}\n`

      if (closesConnection) {
        socket.end(payload, () => socket.destroy())
      } else if (!socket.destroyed) {
        socket.write(payload)
      }
    }

    this.executeControlLine(line, socket)
      .then((response) => respond({status: "success", ...response}))
      .catch((error) => {
        this.logger("command failed", {error: error instanceof Error ? error.message : String(error)})
        respond({
          error: error instanceof Error ? error.message : String(error),
          status: "error"
        })
      })
  }

  /**
   * @param {string} line - JSON command line.
   * @param {net.Socket} [controlSocket] - Requesting control connection, used only for shutdown completion.
   * @returns {Promise<Record<string, JsonValue>>} Command response.
   */
  async executeControlLine(line, controlSocket) {
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
      // Stop accepting new control connections before cleanup, but keep this requesting
      // connection open as the completion channel. Waiting for all control connections here
      // would deadlock: server.close() includes the socket awaiting this response.
      await this.shutdown({completionSocket: controlSocket, waitForControlConnections: false})

      return {message: "shutdown"}
    }

    if (commandName === "retire-owner") {
      const attestation = requiredString(data.attestation, "attestation")
      if (!/^sha256:[a-f0-9]{64}$/.test(attestation)) throw new Error("Owner retirement attestation must use the canonical sha256:<64 lowercase hex> format")
      await this.retireOwner({attestation, completionSocket: controlSocket})
      return {message: "owner retired"}
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

    const nextConfig = this.configPath ? await loadConfig(this.configPath) : this.config

    this.assertReloadCompatible(nextConfig)

    const newReleaseId = releaseId || revision || new Date().toISOString().replace(/[^0-9]/g, "")
    const release = new ReleaseGroup({
      config: nextConfig,
      logger: this.logger,
      ...(this.guardian ? {processFactory: (key, definition) => this.guardianProcess(key, definition)} : {}),
      releaseId: newReleaseId,
      releasePath,
      revision,
      servicePorts: this.servicePorts,
      shouldStart: () => !this.stopping
    })

    this.logger("deploy starting", {releaseId: newReleaseId, releasePath, revision})
    const startedServices = /** @type {string[]} */ ([])

    this.startingReleases.add(release)

    try {
      await this.ensureServices(release, startedServices)
      await release.start()
      if (this.stopping) throw new Error("Rollbridge is shutting down")
    } catch (error) {
      this.logger("deploy failed", {error: error instanceof Error ? error.message : String(error), releaseId: newReleaseId})
      await release.stop()
      await this.stopStartedServices(startedServices)
      throw error
    } finally {
      this.startingReleases.delete(release)
    }

    const previousRelease = this.activeRelease

    this.config = nextConfig
    this.releases.set(release.releaseId, release)
    release.activate()
    this.activeRelease = release
    this.logger("traffic switched", {previousReleaseId: previousRelease ? previousRelease.releaseId : null, releaseId: release.releaseId})

    this.refreshServiceDefinitions(release)
    let retirementFailure

    if (previousRelease) {
      try {
        await previousRelease.beginRetirement(nextConfig)
        void this.drainAndPrune(previousRelease, nextConfig)
      } catch (error) {
        retirementFailure = previousRelease.retirementError ?? (error instanceof Error ? error.message : String(error))
        this.logger("release retirement quiescence failed", {error: retirementFailure, releaseId: previousRelease.releaseId})
      }
    }

    await this.replaceSingletons(release)

    await this.persistState()

    return {
      activeReleaseId: release.releaseId,
      previousReleaseId: previousRelease ? previousRelease.releaseId : null,
      ...(retirementFailure && previousRelease ? {retirement: {error: retirementFailure, releaseId: previousRelease.releaseId, status: "quiescence_failed"}} : {})
    }
  }

  /**
   * Rejects config changes that require rebinding daemon-owned resources or changing process topology.
   * @param {import("./config.js").RollbridgeConfig} nextConfig - Freshly loaded config.
   * @returns {void}
   */
  assertReloadCompatible(nextConfig) {
    /** @type {string[]} */
    const restartRequired = []

    if (nextConfig.application !== this.config.application) restartRequired.push("application")
    if (!isDeepStrictEqual(nextConfig.control, this.config.control)) restartRequired.push("control")
    if (nextConfig.statePath !== this.config.statePath) restartRequired.push("statePath")
    if (!isDeepStrictEqual(nextConfig.ownerRecovery, this.config.ownerRecovery)) restartRequired.push("ownerRecovery")

    if (nextConfig.proxy.host !== this.config.proxy.host) restartRequired.push("proxy.host")
    if (nextConfig.proxy.port !== this.config.proxy.port) restartRequired.push("proxy.port")
    if (nextConfig.proxy.upstreamHost !== this.config.proxy.upstreamHost) restartRequired.push("proxy.upstreamHost")

    if (nextConfig.processes.length !== this.config.processes.length) {
      restartRequired.push("processes")
    } else {
      for (const processConfig of this.config.processes) {
        const nextProcessConfig = nextConfig.processes.find((candidate) => candidate.id === processConfig.id)

        if (!nextProcessConfig ||
          nextProcessConfig.policy !== processConfig.policy ||
          nextProcessConfig.deployStrategy !== processConfig.deployStrategy ||
          nextProcessConfig.replicas !== processConfig.replicas ||
          !isDeepStrictEqual(nextProcessConfig.port, processConfig.port)) {
          restartRequired.push("processes")
          break
        }
      }
    }

    if (restartRequired.length > 0) {
      throw new Error(`Config changes to ${restartRequired.join(", ")} cannot be applied live; restart the Rollbridge daemon before deploying.`)
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

    for (const processConfig of release.config.processes) {
      if (this.stopping) throw new Error("Rollbridge is shutting down")
      if (processConfig.policy !== "service" || processConfig.deployStrategy === "handoff") continue
      if (this.services.has(processConfig.id)) continue

      const service = release.buildProcess(processConfig, {guardianKey: `service:${processConfig.id}`, shouldRestart: () => !this.stopping})

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

      if (this.stopping) throw new Error("Rollbridge is shutting down")
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

      service.updateDefinition(nextDefinition)
    }
  }

  /**
   * Restarts singleton processes for the new release without overlapping old singleton processes.
   * @param {ReleaseGroup} release - Active release.
   * @returns {Promise<void>} Resolves when singletons have been replaced.
   */
  async replaceSingletons(release) {
    for (const processConfig of this.config.processes) {
      if (this.stopping) throw new Error("Rollbridge is shutting down")
      if (processConfig.policy !== "singleton") continue

      const previous = this.singletons.get(processConfig.id)

      if (previous) {
        await previous.stop()
        if (this.stopping) throw new Error("Rollbridge is shutting down")
      }

      const singleton = release.buildProcess(processConfig, {guardianKey: `singleton:${release.releaseId}:${processConfig.id}`})

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
   * @param {import("./config.js").RollbridgeConfig} [config] - Refreshed config governing retirement.
   * @returns {Promise<void>} Resolves once drained, stopped, and pruned.
   */
  async drainAndPrune(release, config = this.config) {
    try {
      await release.drainAndStop(config.proxy.drainTimeoutMs, config)
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

    this.stateCleanupEnabled = true
    this.persistenceEnabled = true
    this.persistState()
    this.persistTimer = setInterval(() => this.persistState(), STATE_PERSIST_INTERVAL_MS)
    this.persistTimer.unref?.()
  }

  /**
   * Persists a state snapshot (status plus recent events) to statePath, atomically and
   * fire-and-forget unless the caller awaits the returned write. A failed write is logged.
   * @param {{throwOnError?: boolean}} [options] - Whether a write failure rejects the returned promise.
   * @returns {Promise<void> | undefined} The queued write, or undefined when persistence is disabled.
   */
  persistState({throwOnError = false} = {}) {
    if (!this.statePath || !this.persistenceEnabled || this.stopping) return

    const statePath = this.statePath
    const status = /** @type {Record<string, JsonValue>} */ (secretSafeStateValue(this.status()))
    const events = secretSafeStateValue(this.eventLog.recent())
    const snapshot = {
      ...status,
      events,
      persistedAt: new Date().toISOString(),
      ...(this.guardianIdentity ? {recovery: {
        configDigest: this.ownerRecoveryConfigDigest(),
        format: 1,
        guardian: this.guardianIdentity,
        reconnectGraceMs: this.config.ownerRecovery?.reconnectGraceMs
      }} : {})
    }

    // Serialize writes (and track the tail) so shutdown can wait for an in-flight write before
    // clearing the file — otherwise a write started before shutdown could recreate it afterward.
    this.pendingWrite = Promise.resolve(this.pendingWrite)
      .catch(() => {})
      .then(() => writeState(statePath, snapshot))
      .catch((error) => {
        this.logger("state persist failed", {error: error instanceof Error ? error.message : String(error)})
        if (throwOnError) throw error
      })

    return this.pendingWrite
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

    this.stateCleanupEnabled = true
    const orphans = liveProcesses(await readState(this.statePath))

    // Keep them for status() so `rollbridge status` reflects still-running children after a
    // restart, not just the startup log below.
    this.orphans = orphans

    for (const orphan of orphans) {
      this.logger("orphaned managed process detected", {pid: orphan.pid, processId: orphan.id, releaseId: orphan.releaseId})
    }

    if (orphans.length > 0) {
      this.logger("orphaned processes from a previous daemon", {count: orphans.length, hint: "a previous daemon did not shut down cleanly; verify these pids and stop any leftovers"})
    }
  }

  /**
   * Stops proxy, control socket, and child processes.
   * @param {{completionSocket?: net.Socket, waitForControlConnections?: boolean}} [options] - Shutdown connection behavior.
   * @returns {Promise<void>} Resolves when owned resources are stopped (and, by default, control connections close).
   */
  async shutdown({completionSocket, waitForControlConnections = true} = {}) {
    if (!this.shutdownPromise) this.shutdownPromise = this.performShutdown(completionSocket)

    await this.shutdownPromise
    if (waitForControlConnections && this.controlClosePromise) await this.controlClosePromise
  }

  /**
   * Relinquishes stable listeners promptly while retaining draining children under
   * this daemon until their normal stop contract completes.
   * @param {{attestation: string, completionSocket?: net.Socket}} options - Attested handoff request.
   * @returns {Promise<void>} Resolves once a replacement can exclusively bind listeners.
   */
  async retireOwner({attestation, completionSocket}) {
    if (this.retirementPromise) return await this.retirementPromise
    this.retirementPromise = this.performOwnerRetirement(attestation, completionSocket)
    return await this.retirementPromise
  }

  /**
   * @param {string} attestation - Replacement boot attestation.
   * @param {net.Socket | undefined} completionSocket - Requesting handoff connection.
   * @returns {Promise<void>} Resolves after quiesce and listener release.
   */
  async performOwnerRetirement(attestation, completionSocket) {
    this.stopping = true
    if (this.persistTimer) {
      clearInterval(this.persistTimer)
      this.persistTimer = undefined
    }
    this.persistenceEnabled = false
    if (this.pendingWrite) await this.pendingWrite
    this.stateCleanupEnabled = false
    this.controlClosePromise = this.closeServer(this.controlServer)
    for (const socket of this.controlSockets) if (socket !== completionSocket) socket.destroy()
    await Promise.all([
      ...[...this.services.values()].map((processInstance) => processInstance.quiesce()),
      ...[...this.singletons.values()].map((processInstance) => processInstance.quiesce()),
      ...[...this.startingReleases].map((release) => release.quiesce()),
      ...[...this.releases.values()].map((release) => release.quiesce())
    ])
    await this.removeControlSocket()
    void this.closeServer(this.proxyServer)
    void Promise.allSettled([
      ...[...this.services.values()].map((processInstance) => processInstance.stop()),
      ...[...this.singletons.values()].map((processInstance) => processInstance.stop()),
      ...[...this.startingReleases].map((release) => release.stop()),
      ...[...this.releases.values()].map((release) => release.stop())
    ])
    this.logger("external owner retired", {attestation, status: "draining"})
  }

  /**
   * @param {net.Socket | undefined} completionSocket - Requester retained for the final response.
   * @returns {Promise<void>} Retires listeners and cleans up every daemon-owned resource.
   */
  async performShutdown(completionSocket) {
    this.stopping = true
    const cleanupErrors = /** @type {Error[]} */ ([])

    // server.close() stops new connections synchronously. Unlink immediately afterward so a
    // replacement can bind as soon as cleanup completes; existing connections remain usable for
    // the shutdown completion/error response.
    this.controlClosePromise = this.closeServer(this.controlServer)

    for (const socket of this.controlSockets) {
      if (socket !== completionSocket) socket.destroy()
    }

    await captureShutdownError(cleanupErrors, "control socket unlink", () => this.removeControlSocket())

    if (this.persistTimer) {
      clearInterval(this.persistTimer)
      this.persistTimer = undefined
    }

    await captureShutdownError(cleanupErrors, "proxy close", async () => this.proxy.close())
    const dependentStopResults = await Promise.allSettled([
      ...[...this.singletons.values()].map((processInstance) => processInstance.stop()),
      ...[...this.startingReleases].map((release) => release.stop()),
      ...[...this.releases.values()].map((release) => release.stop())
    ])
    const serviceStopResults = await Promise.allSettled([...this.services.values()].map((processInstance) => processInstance.stop()))
    const stopResults = [...dependentStopResults, ...serviceStopResults]
    const guardian = this.guardian
    if (guardian) await captureShutdownError(cleanupErrors, "process guardian shutdown", () => guardian.shutdown())
    await captureShutdownError(cleanupErrors, "proxy server close", () => this.closeServer(this.proxyServer))

    // Wait for any in-flight write first so it can't recreate or overwrite the final state (no
    // new writes start: stopping is set and the persist timer is cleared above). Prior-daemon
    // orphans are not owned by this daemon, so retain their records until they are confirmed gone.
    await captureShutdownError(cleanupErrors, "persistent state cleanup", async () => {
      if (!this.statePath || !this.stateCleanupEnabled) return
      if (this.pendingWrite) await this.pendingWrite
      const orphans = this.orphans.filter((orphan) => isProcessAlive(orphan.pid))

      if (orphans.length > 0) {
        await writeState(this.statePath, {activeReleaseId: null, orphans, releases: [], services: [], singletons: []})
      } else {
        await clearState(this.statePath)
      }
    })

    const stopErrors = stopResults.filter((result) => result.status === "rejected").map((result) => result.reason)

    if (stopErrors.length > 0) {
      cleanupErrors.push(new AggregateError(stopErrors, `Shutdown failed to stop ${stopErrors.length} owned resource${stopErrors.length === 1 ? "" : "s"}.`))
    }

    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, cleanupErrors.map((error) => error.message).join("; "))
  }

  /** @returns {Promise<void>} Removes the configured control socket path. */
  async removeControlSocket() {
    if (!this.controlSocketOwned) return

    await fs.rm(this.config.control.path, {force: true})
    this.controlSocketOwned = false
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
    // Re-check liveness and prune the dead permanently, so the list self-clears as the operator
    // stops the leftovers (e.g. via `rollbridge recover`). Pruning (not just filtering) matters:
    // a cleared orphan must not reappear if the OS later recycles its pid for an unrelated process.
    this.orphans = this.orphans.filter((orphan) => isProcessAlive(orphan.pid))

    return {
      activeReleaseId: this.activeRelease ? this.activeRelease.releaseId : null,
      application: this.config.application,
      bootstrap: this.bootstrap ? {...this.bootstrap} : undefined,
      control: {...this.config.control},
      daemonRuntime: this.runtime ? {...this.runtime} : undefined,
      ownerRecovery: this.guardian ? {configDigest: this.ownerRecoveryConfigDigest()} : undefined,
      orphans: [...this.orphans],
      proxy: {
        host: this.config.proxy.host,
        port: this.proxyPort ?? this.config.proxy.port,
        upstreamHost: this.config.proxy.upstreamHost
      },
      releaseReferences: [...this.releases.values()]
        .filter((release) => release.state === "active" || release.state === "draining")
        .map((release) => ({releaseId: release.releaseId, releasePath: release.releasePath})),
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
 * @param {string} line - Raw control line.
 * @returns {boolean} Whether the line requests shutdown and needs a terminal response connection.
 */
function isShutdownControlLine(line) {
  try {
    const command = JSON.parse(line)

    return Boolean(command && typeof command === "object" && ["retire-owner", "shutdown"].includes(command.command))
  } catch {
    return false
  }
}

/**
 * Runs one shutdown cleanup step and records a labeled failure without skipping later cleanup.
 * @param {Error[]} errors - Accumulated cleanup errors.
 * @param {string} label - Non-secret cleanup step name.
 * @param {() => Promise<void>} operation - Cleanup operation.
 * @returns {Promise<void>} Resolves after the operation succeeds or its failure is recorded.
 */
async function captureShutdownError(errors, label, operation) {
  try {
    await operation()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    errors.push(new Error(`${label} failed: ${reason}`, {cause: error}))
  }
}

const SECRET_BEARING_STATE_KEYS = new Set(["children", "command", "cwd", "env", "environment", "logs", "output"])

/**
 * Removes process definitions and captured output from a value before it reaches statePath.
 * The live status/events APIs retain those diagnostics in memory; persistent state is only a
 * secret-safe recovery aid and must not become a second process log or configuration store.
 * @param {JsonValue} value - JSON value to sanitize.
 * @returns {JsonValue} A secret-safe copy.
 */
function secretSafeStateValue(value) {
  if (Array.isArray(value)) return value.map((entry) => secretSafeStateValue(entry))
  if (!value || typeof value !== "object") return value

  /** @type {Record<string, JsonValue>} */
  const safe = {}

  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_BEARING_STATE_KEYS.has(key)) continue
    safe[key] = secretSafeStateValue(entry)
  }

  return safe
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
 * @typedef {{alive: boolean, application?: string, activeReleaseId?: string | null, proxy?: {host: string, port: number}}} ControlSocketInspection
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

      finish(status ? {activeReleaseId: status.activeReleaseId, alive: true, application: status.application, proxy: status.proxy} : {alive: true})
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
 * @returns {{application: string, activeReleaseId: string | null, proxy: {host: string, port: number} | undefined} | undefined} Identity, or undefined when unrecognized.
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

  const proxy = "proxy" in parsed && parsed.proxy && typeof parsed.proxy === "object" && !Array.isArray(parsed.proxy) && typeof parsed.proxy.host === "string" && typeof parsed.proxy.port === "number" ? {host: parsed.proxy.host, port: parsed.proxy.port} : undefined

  return {activeReleaseId: typeof parsed.activeReleaseId === "string" ? parsed.activeReleaseId : null, application: parsed.application, proxy}
}
