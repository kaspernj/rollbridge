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
    this.pending = /** @type {Map<number, {reject: (error: Error) => void, resolve: (value: import("./json.js").JsonValue) => void}>} */ (new Map())
    this.processes = /** @type {Map<string, GuardianProcess>} */ (new Map())
    this.events = /** @type {Map<string, {reject: (error: Error) => void, resolve: (value: Record<string, import("./json.js").JsonValue>) => void}[]>} */ (new Map())
  }

  /** Launches a new detached guardian and connects to it after its bind acknowledgement. */
  async launch() {
    const child = spawn(process.execPath, [guardianPath, this.socketPath, this.token], {detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"]})

    this.pid = child.pid

    await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => reject(new Error(`Process guardian exited before readiness with status ${code}`)))
      child.once("message", (message) => {
        if (message && typeof message === "object" && "error" in message) reject(new Error(String(message.error)))
        else resolve(undefined)
      })
    })
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
      for (const {reject} of this.pending.values()) reject(new Error("Process guardian connection closed"))
      this.pending.clear()
      for (const waiters of this.events.values()) for (const {reject} of waiters) reject(new Error("Process guardian connection closed"))
      this.events.clear()
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
    const response = new Promise((resolve, reject) => this.pending.set(id, {reject, resolve}))

    this.socket.write(`${JSON.stringify({...command, id, token: this.token})}\n`)
    return await response
  }

  /** Stops the guardian after every owned process has stopped. */
  async shutdown() {
    await this.request({command: "shutdown"})
    this.socket?.end()
  }

  /**
   * @param {number} graceMs - Event-driven handoff grace while the prior owner disconnects.
   * @param {import("./json.js").JsonValue} authority - Exact owner authority.
   */
  async claimOwner(graceMs, authority) {
    await this.request({authority, command: "claim-owner", graceMs})
  }

  /** @param {import("./json.js").JsonValue} ownerState - Private transferable owner state. */
  async publishOwnerState(ownerState) {
    await this.request({command: "publish-owner-state", ownerState})
  }

  /**
   * @param {import("./json.js").JsonValue} authority - Persisted current authority.
   * @param {import("./json.js").JsonValue} nextAuthority - Requested authority.
   * @returns {Promise<{ownerState: import("./json.js").JsonValue, replacementId: string}>} Prepared transaction.
   */
  async prepareOwnerReplacement(authority, nextAuthority) {
    return /** @type {{ownerState: import("./json.js").JsonValue, replacementId: string}} */ (await this.request({authority, command: "prepare-owner-replacement", nextAuthority}))
  }

  /**
   * @param {string} replacementId - Prepared transaction.
   * @param {import("./json.js").JsonValue} ownerState - Complete candidate state.
   * @returns {Promise<{committed: boolean}>} Whether staging completed an ownerless transaction.
   */
  async stageOwnerReplacement(replacementId, ownerState) {
    return /** @type {{committed: boolean}} */ (await this.request({command: "stage-owner-replacement", ownerState, replacementId}))
  }

  /** @param {string} replacementId - Prepared transaction id. */
  async commitOwnerReplacement(replacementId) {
    await this.request({command: "commit-owner-replacement", replacementId})
  }

  /** @returns {Promise<{committedReplacementId: string | null, ownerClaimed: boolean}>} Transaction status. */
  async replacementStatus() {
    return /** @type {{committedReplacementId: string | null, ownerClaimed: boolean}} */ (await this.request({command: "replacement-status"}))
  }

  /** @returns {Promise<import("./json.js").JsonValue>} Current private transfer state. */
  async ownerState() {
    const result = /** @type {{ownerState: import("./json.js").JsonValue}} */ (await this.request({command: "owner-state"}))

    return result.ownerState
  }

  /**
   * @param {string} event - Guardian event name.
   * @returns {Promise<Record<string, import("./json.js").JsonValue>>} Next event payload.
   */
  waitForEvent(event) {
    return new Promise((resolve, reject) => {
      const waiters = this.events.get(event) || []

      waiters.push({reject, resolve})
      this.events.set(event, waiters)
    })
  }

  /** Disconnects a fenced startup loser without changing guardian-owned processes. */
  disconnect() {
    this.socket?.destroy()
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
        if (message.event === "process" || message.event === "status") this.processes.get(message.key)?.onGuardianEvent(message)
        const waiter = this.events.get(message.event)?.shift()

        if (waiter) waiter.resolve(message)
      } else {
        const pending = this.pending.get(message.id)

        this.pending.delete(message.id)
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
