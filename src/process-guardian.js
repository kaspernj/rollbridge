// @ts-check

import fs from "node:fs/promises"
import net from "node:net"
import crypto from "node:crypto"
import {isDeepStrictEqual} from "node:util"
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
 * @property {import("./json.js").JsonValue} [ownerState] - Private owner transfer state.
 * @property {string} [replacementId] - Prepared replacement transaction id.
 * @property {import("./json.js").JsonValue} [authority] - Expected current authority.
 * @property {import("./json.js").JsonValue} [nextAuthority] - Requested replacement authority.
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
/** @type {net.Socket | undefined} */
let replacementClient
/** @type {string | undefined} */
let replacementId
/** @type {string | undefined} */
let committedReplacementId
/** @type {import("./json.js").JsonValue | undefined} */
let replacementAuthority
/** @type {import("./json.js").JsonValue | undefined} */
let replacementOwnerState
/** @type {import("./json.js").JsonValue | undefined} */
let ownerState
/** @type {{reject: (error: Error) => void, resolve: (value: {claimed: boolean}) => void, socket: net.Socket, timer: ReturnType<typeof setTimeout>}[]} */
const claimWaiters = []

const server = net.createServer((socket) => {
  clients.add(socket)
  socket.setEncoding("utf8")
  // An abruptly killed daemon can reset its private guardian connection. Keep the
  // durable guardian alive; the close handler below releases only that owner claim.
  socket.on("error", () => socket.destroy())
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
      if (replacementClient && replacementOwnerState) commitReplacement()
      else {
        if (replacementClient) abortReplacement("Committed owner disconnected before replacement candidate was ready")
        grantNextOwner()
      }
    }
    if (replacementClient === socket) {
      replacementClient = undefined
      replacementId = undefined
      replacementAuthority = undefined
      replacementOwnerState = undefined
      if (ownerClient && !ownerClient.destroyed) ownerClient.write(`${JSON.stringify({event: "replacement-aborted"})}\n`)
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
      if (ownerState !== undefined && !isDeepStrictEqual(request.authority, ownerAuthority(ownerState))) {
        throw new Error("Owner recovery authority does not match the guardian's committed authority")
      }
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

  if (request.command === "publish-owner-state") {
    requireOwner(socket, request.command)
    if (request.ownerState === undefined) throw new Error("Guardian owner publication requires ownerState")
    ownerState = request.ownerState
    committedReplacementId = undefined
    return {published: true}
  }

  if (request.command === "owner-state") {
    requireOwner(socket, request.command)
    if (!ownerState) throw new Error("Committed owner has not published transferable state")
    return {ownerState}
  }

  if (request.command === "replacement-status") {
    return {committedReplacementId: committedReplacementId ?? null, ownerClaimed: Boolean(ownerClient)}
  }

  if (request.command === "prepare-owner-replacement") {
    if (socket === ownerClient) throw new Error("Committed owner cannot prepare itself as a replacement")
    if (replacementClient && replacementClient !== socket) throw new Error("Another owner replacement candidate is already prepared")
    if (!ownerState) throw new Error("Committed owner has not published transferable state")
    const currentAuthority = ownerAuthority(ownerState)
    const resumesCommittedAuthority = !ownerClient && isDeepStrictEqual(currentAuthority, request.nextAuthority)

    if (!resumesCommittedAuthority && !isDeepStrictEqual(currentAuthority, request.authority)) {
      throw new Error("Owner replacement authority fence does not match the guardian's committed authority")
    }
    if (request.nextAuthority === undefined) throw new Error("Owner replacement requires the requested authority")
    if (!replacementId) replacementId = crypto.randomUUID()
    replacementClient = socket
    replacementAuthority = request.nextAuthority
    return {ownerState, replacementId}
  }

  if (request.command === "stage-owner-replacement") {
    requireReplacement(socket, request)
    if (request.ownerState === undefined || !isDeepStrictEqual(ownerAuthority(request.ownerState), replacementAuthority)) {
      throw new Error("Prepared replacement state does not match the requested authority")
    }
    replacementOwnerState = request.ownerState
    if (!ownerClient) commitReplacement()
    return {committed: ownerClient === socket}
  }

  if (request.command === "commit-owner-replacement") {
    requireOwner(socket, request.command)
    if (!replacementClient || request.replacementId !== replacementId || !replacementOwnerState) throw new Error("Owner replacement transaction is not the prepared ready candidate")
    commitReplacement()
    return {committed: true}
  }

  if (request.command === "shutdown") {
    requireOwner(socket, request.command)
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

    requireOwner(socket, request.command)

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

  if (request.command !== "status") requireOwner(socket, request.command)

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

/**
 * @param {net.Socket} socket - Requesting client.
 * @param {string} command - Command name.
 */
function requireOwner(socket, command) {
  if (ownerClient !== socket) throw new Error(`Guardian ${command} requires the committed owner`)
}

/** @param {string} reason - Abort diagnostic. */
function abortReplacement(reason) {
  if (replacementClient && !replacementClient.destroyed) replacementClient.write(`${JSON.stringify({event: "replacement-aborted", reason})}\n`)
  replacementClient = undefined
  replacementId = undefined
  replacementAuthority = undefined
  replacementOwnerState = undefined
}

/** Atomically promotes the prepared client and its complete transferable state. */
function commitReplacement() {
  if (!replacementClient || !replacementId || !replacementOwnerState) throw new Error("Owner replacement candidate is not ready")
  const previousOwner = ownerClient
  const committedClient = replacementClient
  const committedId = replacementId

  ownerClient = committedClient
  ownerState = replacementOwnerState
  committedReplacementId = committedId
  replacementClient = undefined
  replacementId = undefined
  replacementAuthority = undefined
  replacementOwnerState = undefined
  committedClient.write(`${JSON.stringify({event: "replacement-committed", replacementId: committedId})}\n`)
  if (previousOwner && !previousOwner.destroyed) previousOwner.write(`${JSON.stringify({event: "replacement-retired", replacementId: committedId})}\n`)
}

/**
 * @param {net.Socket} socket - Requesting client.
 * @param {GuardianRequest} request - Request.
 */
function requireReplacement(socket, request) {
  if (replacementClient !== socket || request.replacementId !== replacementId) throw new Error("Owner replacement transaction is not the prepared candidate")
}

/**
 * @param {import("./json.js").JsonValue} state - Transfer state.
 * @returns {import("./json.js").JsonValue} Embedded authority fence.
 */
function ownerAuthority(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) || !("authority" in state)) throw new Error("Guardian owner state is missing its authority fence")
  return state.authority
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
