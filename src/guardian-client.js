// @ts-check

import crypto from "node:crypto"
import {spawn} from "node:child_process"
import net from "node:net"
import {fileURLToPath} from "node:url"
import ManagedProcess from "./managed-process.js"

const guardianPath = fileURLToPath(new URL("./process-guardian.js", import.meta.url))

export default class GuardianClient {
  /** @param {{pid?: number, socketPath: string, token: string}} identity - Durable guardian identity. */
  constructor({pid, socketPath, token}) {
    this.pid = pid
    this.socketPath = socketPath
    this.token = token
    this.socket = /** @type {net.Socket | undefined} */ (undefined)
    this.buffer = ""
    this.nextId = 0
    this.pending = /** @type {Map<number, {command: string, reject: (error: Error) => void, resolve: (value: import("./json.js").JsonValue) => void}>} */ (new Map())
    this.idleWaiters = /** @type {(() => void)[]} */ ([])
    this.guardianExitPromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.processes = /** @type {Map<string, GuardianProcess>} */ (new Map())
  }

  /** Launches a new detached guardian and connects to it after its bind acknowledgement. */
  async launch() {
    const child = spawn(process.execPath, [guardianPath, this.socketPath], {detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"]})

    this.pid = child.pid
    this.guardianExitPromise = new Promise((resolve) => child.once("exit", () => resolve(undefined)))

    await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => reject(new Error(`Process guardian exited before readiness with status ${code}`)))
      child.once("message", (message) => {
        if (message && typeof message === "object" && "error" in message) reject(new Error(String(message.error)))
        else resolve(undefined)
      })
      child.send({token: this.token}, (error) => {
        if (error) reject(error)
      })
    })
    if (child.connected) await new Promise((resolve) => child.once("disconnect", () => resolve(undefined)))
    child.unref()
    await this.connect()
  }

  /** Connects to an existing guardian. */
  async connect() {
    if (this.socket && !this.socket.destroyed) return
    const socket = net.createConnection(this.socketPath)

    socket.setEncoding("utf8")
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    socket.on("data", (chunk) => this.onData(String(chunk)))
    socket.once("close", () => {
      for (const {command, reject} of this.pending.values()) reject(new Error(`Process guardian connection closed while awaiting ${command}`))
      this.pending.clear()
      this.resolveIdleWaiters()
    })
    this.socket = socket
  }

  /**
   * @param {string} key - Stable process identity.
   * @param {ConstructorParameters<typeof ManagedProcess>[0]} definition - Process definition.
   * @returns {GuardianProcess} Remote managed process.
   */
  process(key, definition) {
    const processInstance = new GuardianProcess({client: this, definition, key})

    this.processes.set(key, processInstance)
    return processInstance
  }

  /**
   * @param {Record<string, import("./json.js").JsonValue>} command - Command.
   * @returns {Promise<import("./json.js").JsonValue>} Guardian response.
   */
  async request(command) {
    if (!this.socket || this.socket.destroyed) throw new Error("Process guardian is not connected")
    this.nextId += 1
    const id = this.nextId
    const response = new Promise((resolve, reject) => this.pending.set(id, {command: String(command.command), reject, resolve}))

    this.socket.write(`${JSON.stringify({...command, id, token: this.token})}\n`)
    return await response
  }

  /** Stops the guardian after every owned process has stopped. */
  async shutdown() {
    if (this.pending.size > 0) {
      await new Promise((resolve) => {
        this.idleWaiters.push(() => { resolve(undefined) })
      })
    }
    await this.request({command: "shutdown"})
    const socket = this.socket

    if (!socket || socket.destroyed) throw new Error("Process guardian disconnected before shutdown acknowledgement")
    const closed = new Promise((resolve) => socket.once("close", () => resolve(undefined)))

    socket.end()
    await closed
  }

  /** Waits for a guardian launched by this client to exit. */
  async guardianExit() {
    if (!this.guardianExitPromise) throw new Error("Guardian exit is observable only from the launching client")
    await this.guardianExitPromise
  }

  /** @param {number} graceMs - Event-driven handoff grace while the prior owner disconnects. */
  async claimOwner(graceMs) {
    await this.request({command: "claim-owner", graceMs})
  }

  /** @returns {Promise<{key: string, provenance: string, status: import("./managed-process.js").ManagedProcessStatus}[]>} Exact guardian-owned inventory. */
  async inventory() {
    return /** @type {{key: string, provenance: string, status: import("./managed-process.js").ManagedProcessStatus}[]} */ (await this.request({command: "inventory"}))
  }

  /**
   * Stops and forgets one exact guardian-owned registration.
   * @param {string} key - Stable guardian registration key.
   * @param {string} provenance - Exact expected process-definition provenance.
   */
  async remove(key, provenance) {
    await this.request({command: "remove", key, provenance})
    this.processes.delete(key)
  }

  /** Stops guardian registrations absent from the reconstructed durable snapshot. */
  async reconcileInventory() {
    const unexpected = (await this.inventory()).filter((entry) => !this.processes.has(entry.key))
    const results = await Promise.allSettled(unexpected.map((entry) => this.remove(entry.key, entry.provenance)))
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason)

    if (errors.length > 0) {
      throw new AggregateError(errors, `Guardian inventory reconciliation failed for ${errors.length} registration${errors.length === 1 ? "" : "s"}: ${errors.map((error) => errorMessage(error instanceof Error ? error : String(error))).join("; ")}`)
    }
  }

  /** Disconnects a fenced startup loser without changing guardian-owned processes. */
  disconnect() {
    this.socket?.destroy()
  }

  /** Resolves shutdown barriers after every earlier request settles. */
  resolveIdleWaiters() {
    if (this.pending.size > 0) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  /** @param {string} chunk - Protocol bytes. */
  onData(chunk) {
    this.buffer += chunk
    let newline = this.buffer.indexOf("\n")

    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      const message = JSON.parse(line)

      this.buffer = this.buffer.slice(newline + 1)
      if (message.event) {
        this.processes.get(message.key)?.onGuardianEvent(message)
      } else {
        const pending = this.pending.get(message.id)

        this.pending.delete(message.id)
        this.resolveIdleWaiters()
        if (message.error) pending?.reject(new Error(message.error))
        else pending?.resolve(message.result)
      }
      newline = this.buffer.indexOf("\n")
    }
  }
}

class GuardianProcess extends ManagedProcess {
  /** @param {{client: GuardianClient, definition: ConstructorParameters<typeof ManagedProcess>[0], key: string}} args - Remote process args. */
  constructor({client, definition, key}) {
    super(definition)
    this.client = client
    this.key = key
    this.definition = serializableDefinition(definition)
    this.provenance = crypto.createHash("sha256").update(JSON.stringify(this.definition)).digest("hex")
    this.cachedStatus = super.status()
    this.registration = /** @type {Promise<void> | undefined} */ (undefined)
    this.pendingUpdate = Promise.resolve()
  }

  async ensureRegistered() {
    if (!this.registration) {
      this.registration = this.client.request({command: "register", definition: this.definition, key: this.key, provenance: this.provenance})
        .then((status) => { this.cachedStatus = asProcessStatus(status) })
    }
    await this.registration
  }

  /** Reconnects to an already registered guardian process without changing its desired state. */
  async recover() {
    await this.ensureRegistered()
  }

  async start(reason = "deploy") {
    await this.ensureRegistered()
    await this.pendingUpdate
    this.cachedStatus = asProcessStatus(await this.client.request({command: "start", key: this.key, reason}))
  }

  /** @param {import("./managed-process.js").ManagedProcessDefinition} definition - Updated definition. */
  updateDefinition(definition) {
    const previousProvenance = this.provenance
    const registration = this.ensureRegistered()

    super.updateDefinition(definition)
    this.definition = serializableDefinition(this)
    this.provenance = crypto.createHash("sha256").update(JSON.stringify(this.definition)).digest("hex")
    this.pendingUpdate = registration.then(async () => {
      this.cachedStatus = asProcessStatus(await this.client.request({command: "update", definition: this.definition, key: this.key, previousProvenance, provenance: this.provenance}))
    })
  }

  async quiesce() {
    await this.ensureRegistered()
    await this.pendingUpdate
    this.cachedStatus = asProcessStatus(await this.client.request({command: "quiesce", key: this.key}))
  }

  async quiesceStrict() {
    await this.quiesce()
  }

  async stop(options = {}) {
    await this.ensureRegistered()
    await this.pendingUpdate
    this.cachedStatus = asProcessStatus(await this.client.request({command: "stop", key: this.key, options}))
  }

  status() {
    return this.cachedStatus
  }

  /** @param {Record<string, import("./json.js").JsonValue>} event - Guardian event. */
  onGuardianEvent(event) {
    if (event.status) this.cachedStatus = asProcessStatus(event.status)
    if (event.message === "process started") this.emit("started")
    if (event.message === "process exited") this.emit("exit", event.data)
    this.logger(typeof event.message === "string" ? event.message : "guardian process status", event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : {})
  }
}

/**
 * @param {ConstructorParameters<typeof ManagedProcess>[0] | ManagedProcess} definition - Managed definition.
 * @returns {Record<string, import("./json.js").JsonValue>} Serializable definition.
 */
function serializableDefinition(definition) {
  return {
    command: definition.command,
    cwd: definition.cwd,
    env: definition.env,
    id: definition.id,
    lifecycle: definition.lifecycle,
    memory: definition.memory,
    outputLines: definition.outputLines,
    restart: definition.restart,
    restartDelayMs: definition.restartDelayMs,
    stopSignal: definition.stopSignal,
    stopTimeoutMs: definition.stopTimeoutMs
  }
}

/**
 * @param {import("./json.js").JsonValue} value - Protocol value.
 * @returns {import("./managed-process.js").ManagedProcessStatus} Process status.
 */
function asProcessStatus(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * @param {Error | string} error - Error-like value.
 * @returns {string} Error message.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
