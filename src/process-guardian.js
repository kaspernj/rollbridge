// @ts-check

import fs from "node:fs/promises"
import net from "node:net"
import ManagedProcess from "./managed-process.js"

/**
 * @typedef {object} GuardianRequest
 * @property {string} command - Operation name.
 * @property {ConstructorParameters<typeof ManagedProcess>[0]} [definition] - Managed process definition.
 * @property {number} [graceMs] - Owner reconnection grace.
 * @property {number} id - Request id.
 * @property {string} [key] - Stable process key.
 * @property {{timeoutMs?: number}} [options] - Stop options.
 * @property {string} [previousProvenance] - Expected current provenance.
 * @property {string} [provenance] - New or registered provenance.
 * @property {import("./managed-process.js").ManagedProcessStartReason} [reason] - Start reason.
 * @property {string} token - Authentication token.
 */

const [socketPath, token] = process.argv.slice(2)

if (!socketPath || !token) throw new Error("process-guardian requires socket path and token")

/** @type {Map<string, {desired: boolean, process: ManagedProcess, provenance: string}>} */
const processes = new Map()
/** @type {Set<net.Socket>} */
const clients = new Set()
/** @type {net.Socket | undefined} */
let ownerClient
/** @type {{reject: (error: Error) => void, resolve: (value: {claimed: boolean}) => void, socket: net.Socket, timer: ReturnType<typeof setTimeout>}[]} */
const claimWaiters = []

const server = net.createServer((socket) => {
  clients.add(socket)
  socket.setEncoding("utf8")
  let buffer = ""

  socket.once("close", () => {
    clients.delete(socket)
    const waiterIndex = claimWaiters.findIndex((waiter) => waiter.socket === socket)

    if (waiterIndex >= 0) {
      const [waiter] = claimWaiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.reject(new Error("Owner claimant disconnected"))
    }
    if (ownerClient === socket) {
      ownerClient = undefined
      grantNextOwner()
    }
  })
  socket.on("data", (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")

    while (newline >= 0) {
      const line = buffer.slice(0, newline)

      buffer = buffer.slice(newline + 1)
      void handleLine(socket, line)
      newline = buffer.indexOf("\n")
    }
  })
})

server.on("error", (error) => {
  if (process.send) process.send({error: error.message})
  else throw error
})

server.listen(socketPath, async () => {
  await fs.chmod(socketPath, 0o600)
  if (process.send) {
    process.send({ready: true})
    process.disconnect?.()
  }
})

/**
 * @param {net.Socket} socket - Client.
 * @param {string} line - JSON request.
 * @returns {Promise<void>} Request completion.
 */
async function handleLine(socket, line) {
  /** @type {GuardianRequest | undefined} */
  let request

  try {
    request = /** @type {GuardianRequest} */ (JSON.parse(line))
    if (request.token !== token) throw new Error("Guardian authentication failed")
    const result = await execute(request, socket)

    socket.write(`${JSON.stringify({id: request.id, result})}\n`)
  } catch (error) {
    socket.write(`${JSON.stringify({error: error instanceof Error ? error.message : String(error), id: request?.id})}\n`)
  }
}

/**
 * @param {GuardianRequest} request - Authenticated request.
 * @param {net.Socket} socket - Requesting client.
 * @returns {Promise<import("./json.js").JsonValue>} Command result.
 */
async function execute(request, socket) {
  if (request.command === "claim-owner") {
    if (!ownerClient) {
      ownerClient = socket
      return {claimed: true}
    }
    if (ownerClient === socket) return {claimed: true}

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = claimWaiters.findIndex((waiter) => waiter.socket === socket)
        if (index >= 0) claimWaiters.splice(index, 1)
        reject(new Error("Durable owner is already claimed by another matching daemon"))
      }, request.graceMs ?? 30000)

      claimWaiters.push({reject, resolve, socket, timer})
    })
  }

  if (request.command === "shutdown") {
    await Promise.allSettled([...processes.values()].map((entry) => entry.process.stop()))
    server.close()
    await fs.rm(socketPath, {force: true})
    setImmediate(() => process.exit(0))
    return {stopped: true}
  }

  if (request.command === "register") {
    if (!request.key || !request.definition || !request.provenance) throw new Error("Guardian register requires key, definition, and provenance")
    const existing = processes.get(request.key)

    if (existing) {
      if (existing.provenance !== request.provenance) throw new Error(`Guardian provenance mismatch for ${request.key}`)
      return existing.process.status()
    }

    const record = /** @type {{desired: boolean, process?: ManagedProcess, provenance: string}} */ ({desired: true, provenance: request.provenance})
    const definition = request.definition
    const managedProcess = new ManagedProcess({
      ...definition,
      logger: (message, data = {}) => broadcast({event: "process", key: request.key, message, data, status: managedProcess.status()}),
      shouldRestart: () => record.desired
    })

    record.process = managedProcess
    processes.set(request.key, /** @type {{desired: boolean, process: ManagedProcess, provenance: string}} */ (record))
    return managedProcess.status()
  }

  if (!request.key) throw new Error(`Guardian ${request.command} requires a process key`)
  const record = processes.get(request.key)

  if (!record) throw new Error(`Guardian process ${request.key} is not registered`)

  if (request.command === "start") {
    record.desired = true
    await record.process.start(request.reason)
  } else if (request.command === "quiesce") {
    record.desired = false
    await record.process.quiesceStrict()
  } else if (request.command === "stop") {
    record.desired = false
    await record.process.stop(request.options)
  } else if (request.command === "update") {
    if (!request.definition || !request.provenance) throw new Error("Guardian update requires definition and provenance")
    if (record.provenance !== request.previousProvenance) throw new Error(`Guardian provenance mismatch for ${request.key}`)
    record.process.updateDefinition({
      ...request.definition,
      lifecycle: request.definition.lifecycle || {drainTimeoutMs: 0},
      logger: record.process.logger,
      memory: request.definition.memory,
      restart: request.definition.restart || {backoffFactor: 1, maxDelayMs: 0, maxRestarts: undefined, windowMs: 0},
      shouldRestart: () => record.desired,
      stopSignal: request.definition.stopSignal || "SIGTERM"
    })
    record.provenance = request.provenance
  } else if (request.command === "status") {
    return record.process.status()
  } else {
    throw new Error(`Unknown guardian command: ${request.command}`)
  }

  const status = record.process.status()

  broadcast({event: "status", key: request.key, status})
  return status
}

/** @param {Record<string, import("./json.js").JsonValue>} event - Event payload. */
function broadcast(event) {
  const line = `${JSON.stringify(event)}\n`

  for (const client of clients) if (!client.destroyed) client.write(line)
}

/** @returns {void} Grants the next queued owner claim. */
function grantNextOwner() {
  const next = claimWaiters.shift()

  if (!next) return
  clearTimeout(next.timer)
  ownerClient = next.socket
  next.resolve({claimed: true})
  for (const waiter of claimWaiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error("Durable owner was claimed by another matching daemon"))
  }
}
