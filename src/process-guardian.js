// @ts-check

import fsSync from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import crypto from "node:crypto"
import {spawn} from "node:child_process"
import {isDeepStrictEqual} from "node:util"
import path from "node:path"
import GuardianClient from "./guardian-client.js"
import ManagedProcess from "./managed-process.js"

const OWNER_RESTART_RETRY_MS = 1000

/** @typedef {import("node:child_process").ChildProcess["signalCode"]} ChildExitSignal */

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
 * @property {string} [mutationId] - Owner mutation lease id.
 * @property {string} [operation] - Owner mutation diagnostic name.
 * @property {number} [incumbentPid] - Exact legacy daemon PID crossed by the bridge.
 * @property {number} [ownerPid] - Exact claimant process PID.
 * @property {import("./json.js").JsonValue} [recoverySnapshot] - Public bridge recovery snapshot.
 * @property {string} [statePath] - Exact public recovery state path.
 * @property {import("./json.js").JsonValue} [authority] - Expected current authority.
 * @property {import("./json.js").JsonValue} [nextAuthority] - Requested replacement authority.
 * @property {import("./managed-process.js").ManagedProcessStartReason} [reason] - Start reason.
 * @property {string} token - Authentication token.
 */

const [socketPath] = process.argv.slice(2)

if (!socketPath || !process.send) throw new Error("process-guardian requires socket path and a private bootstrap channel")

const bootstrap = await new Promise((resolve, reject) => {
  process.once("disconnect", () => reject(new Error("Guardian bootstrap channel closed before authentication capability arrived")))
  process.once("message", (message) => {
    if (!message || typeof message !== "object" || !("token" in message) || typeof message.token !== "string" || !message.token) {
      reject(new Error("Guardian bootstrap authentication capability is invalid"))
      return
    }
    resolve(message)
  })
})
const token = bootstrap.token
const legacyGuardian = bootstrap.legacyGuardian ? new GuardianClient(bootstrap.legacyGuardian) : undefined

if (legacyGuardian) await legacyGuardian.connect()

/** @type {Map<string, {desired: boolean, process: ManagedProcess, provenance: string}>} */
const processes = new Map()
/** @type {Set<net.Socket>} */
const clients = new Set()
/** @type {net.Socket | undefined} */
let ownerClient
/** @type {number | undefined} */
let ownerClientPid
/** @type {net.Socket | undefined} */
let replacementClient
/** @type {number | undefined} */
let replacementOwnerPid
/** @type {string | undefined} */
let replacementId
/** @type {string | undefined} */
let committedReplacementId
/** @type {import("./json.js").JsonValue | undefined} */
let replacementAuthority
/** @type {import("./json.js").JsonValue | undefined} */
let replacementOwnerState
/** @type {import("./json.js").JsonValue | undefined} */
let ownerState = bootstrap.ownerState
let ownerRevision = ownerState === undefined ? 0 : 1
/** @type {number | undefined} */
let replacementRevision
const legacyKeys = legacyGuardian ? legacyOwnerKeys(ownerState) : new Set()
let legacyBoundaryCrossed = false
/** @type {net.Socket | undefined} */
let ownerMutationClient
/** @type {string | undefined} */
let ownerMutationId
/** @type {net.Socket | undefined} */
let retiringClient
/** @type {string | undefined} */
let retiringReplacementId
let shuttingDown = false
/** @type {net.Socket | undefined} */
let shutdownClient
let shutdownFinalizing = false
/** @type {Promise<void> | undefined} */
let serverClosed
/** @type {import("node:child_process").ChildProcess | undefined} */
let ownerRestartChild
/** @type {ReturnType<typeof setTimeout> | undefined} */
let ownerRestartTimer
/** @type {ReturnType<typeof setTimeout> | undefined} */
let ownerRestartStartupTimer
/** @type {number | undefined} */
let ownerRestartRetryDelayMs
/** @type {{authority: import("./json.js").JsonValue, ownerPid: number | undefined, reject: (error: Error) => void, resolve: (value: {claimed: boolean}) => void, socket: net.Socket, timer: ReturnType<typeof setTimeout>}[]} */
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
      const incompleteRestartChild = ownerRestartChild?.pid === ownerClientPid ? ownerRestartChild : undefined

      ownerClient = undefined
      ownerClientPid = undefined
      if (replacementClient && replacementOwnerState) commitReplacement()
      else {
        if (incompleteRestartChild) {
          reportOwnerRestartFailure(ownerRecoveryDefinition(), {code: "OWNER_DISCONNECTED"})
          killDetachedProcessGroup(incompleteRestartChild)
          clearOwnerRestartTracking(incompleteRestartChild)
          ownerRestartRetryDelayMs = OWNER_RESTART_RETRY_MS
        }
        if (replacementClient) abortReplacement("Committed owner disconnected before replacement candidate was ready", false)
        if (!shuttingDown) {
          grantNextOwner()
          const retryDelayMs = ownerRestartRetryDelayMs

          ownerRestartRetryDelayMs = undefined
          scheduleOwnerRestart(retryDelayMs)
        }
      }
    }
    if (ownerMutationClient === socket) {
      ownerMutationClient = undefined
      ownerMutationId = undefined
    }
    if (retiringClient === socket) finalizeReplacementRetirement()
    if (replacementClient === socket) {
      replacementClient = undefined
      replacementId = undefined
      replacementAuthority = undefined
      replacementOwnerState = undefined
      replacementOwnerPid = undefined
      if (legacyGuardian && !legacyBoundaryCrossed && !ownerClient && !committedReplacementId) {
        legacyGuardian.disconnect()
        shuttingDown = true
        beginSuccessfulShutdown(socket)
      } else if (ownerClient && !ownerClient.destroyed) {
        ownerClient.write(`${JSON.stringify({event: "replacement-aborted"})}\n`)
      } else {
        scheduleOwnerRestart()
      }
    }
    if (shutdownClient === socket) void finishShutdown()
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
    if (!socket.destroyed) socket.write(`${JSON.stringify({error: error instanceof Error ? error.message : String(error), id: request?.id})}\n`)
  }
}

/**
 * @param {GuardianRequest} request - Authenticated request.
 * @param {net.Socket} socket - Requesting client.
 * @returns {Promise<import("./json.js").JsonValue>} Command result.
 */
async function execute(request, socket) {
  if (shuttingDown) throw new Error("Process guardian is shutting down")

  if (request.command === "capabilities") return {daemonRecovery: 1}

  if (request.command === "claim-owner") {
    if (ownerState !== undefined && !isDeepStrictEqual(request.authority, ownerAuthority(ownerState))) {
      throw new Error("Owner recovery authority does not match the guardian's committed authority")
    }
    if (!ownerClient) {
      acceptOwnerClaim(request.ownerPid)
      ownerClient = socket
      ownerClientPid = request.ownerPid
      return {claimed: true}
    }
    if (ownerClient === socket) return {claimed: true}

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = claimWaiters.findIndex((waiter) => waiter.socket === socket)
        if (index >= 0) claimWaiters.splice(index, 1)
        reject(new Error("Durable owner is already claimed by another matching daemon"))
      }, request.graceMs ?? 30000)

      claimWaiters.push({authority: request.authority ?? null, ownerPid: request.ownerPid, reject, resolve, socket, timer})
    })
  }

  if (request.command === "retire-owner") {
    requireOwner(socket, request.command)
    if (replacementClient) throw new Error("Committed owner cannot retire while an owner replacement is prepared")
    for (const entry of processes.values()) entry.desired = false
    void Promise.allSettled([...processes.values()].map((entry) => entry.process.stop()))
    ownerClient = undefined
    ownerClientPid = undefined
    ownerMutationClient = undefined
    ownerMutationId = undefined
    ownerRevision += 1
    grantNextOwner()
    return {retired: true}
  }

  if (request.command === "owner-ready") {
    requireOwner(socket, request.command)
    if (!request.ownerPid || request.ownerPid !== ownerClientPid) throw new Error("Guardian owner readiness PID does not match the claimed owner")
    const recovery = ownerRecoveryDefinition()
    const pidPath = recovery?.command.pidPath

    if (ownerRestartChild && ownerRestartChild.pid !== request.ownerPid) throw new Error("Guardian owner readiness does not match the tracked recovery child")
    if (pidPath) {
      let temporaryDirectory

      fsSync.mkdirSync(path.dirname(pidPath), {recursive: true})
      try {
        temporaryDirectory = fsSync.mkdtempSync(path.join(path.dirname(pidPath), `.${path.basename(pidPath)}.`))
        const temporaryPath = path.join(temporaryDirectory, "pid")

        fsSync.writeFileSync(temporaryPath, `${request.ownerPid}\n`, {flag: "wx"})
        fsSync.renameSync(temporaryPath, pidPath)
      } finally {
        if (temporaryDirectory) fsSync.rmSync(temporaryDirectory, {force: true, recursive: true})
      }
    }
    if (ownerRestartChild) {
      clearOwnerRestartTracking(ownerRestartChild)
    }
    ownerRestartRetryDelayMs = undefined
    return {ready: true}
  }

  if (request.command === "abandon-legacy-upgrade") {
    if (!legacyGuardian) throw new Error("Guardian is not a legacy upgrade coordinator")
    if (legacyBoundaryCrossed) throw new Error("Guardian cannot abandon a legacy upgrade after crossing the disruptive boundary")
    if (ownerClient || committedReplacementId) throw new Error("Committed guardian authority cannot abandon its legacy backend")
    if (replacementClient && replacementClient !== socket) throw new Error("Only the prepared replacement can abandon the legacy upgrade")
    if (replacementClient) abortReplacement("Legacy guardian upgrade candidate abandoned before the disruptive boundary")
    legacyGuardian.disconnect()
    shuttingDown = true
    beginSuccessfulShutdown(socket)
    return {abandoned: true}
  }

  if (request.command === "cross-legacy-upgrade-boundary") {
    requireReplacement(socket, request)
    if (!legacyGuardian) throw new Error("Guardian is not a legacy upgrade coordinator")
    if (legacyBoundaryCrossed) throw new Error("Guardian already crossed the legacy disruptive boundary")
    if (!request.incumbentPid || !Number.isSafeInteger(request.incumbentPid) || request.incumbentPid <= 0) throw new Error("Legacy disruptive boundary requires the exact incumbent PID")
    if (!request.statePath || !path.isAbsolute(request.statePath)) throw new Error("Legacy disruptive boundary requires an absolute state path")
    if (request.statePath !== ownerStatePath(ownerState)) throw new Error("Legacy disruptive boundary state path does not match the committed owner config")
    assertBridgeRecoverySnapshot(request.recoverySnapshot)
    const temporaryPath = `${request.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    const previousState = fsSync.readFileSync(request.statePath)

    try {
      fsSync.writeFileSync(temporaryPath, `${JSON.stringify(request.recoverySnapshot, null, 2)}\n`, {flag: "wx", mode: 0o600})
      fsSync.renameSync(temporaryPath, request.statePath)
      try {
        process.kill(request.incumbentPid, "SIGKILL")
        legacyBoundaryCrossed = true
      } catch (error) {
        fsSync.writeFileSync(temporaryPath, previousState, {flag: "wx", mode: 0o600})
        fsSync.renameSync(temporaryPath, request.statePath)
        throw error
      }
    } finally {
      fsSync.rmSync(temporaryPath, {force: true})
    }
    return {crossed: true}
  }

  if (request.command === "publish-owner-state") {
    requireOwner(socket, request.command)
    if (request.ownerState === undefined) throw new Error("Guardian owner publication requires ownerState")
    ownerState = request.ownerState
    ownerRevision += 1
    committedReplacementId = undefined
    return {published: true}
  }

  if (request.command === "owner-state") {
    requireOwner(socket, request.command)
    if (!ownerState) throw new Error("Committed owner has not published transferable state")
    return {ownerState}
  }

  if (request.command === "replacement-status") {
    return {committedReplacementId: committedReplacementId ?? null, ownerClaimed: Boolean(ownerClient), retirementPending: Boolean(retiringClient)}
  }

  if (request.command === "begin-owner-mutation") {
    requireOwner(socket, request.command)
    if (replacementClient) throw new Error(`Owner mutation ${request.operation || "operation"} is fenced while an owner replacement is prepared`)
    if (ownerMutationClient) throw new Error("Another owner mutation is already in progress")
    ownerMutationClient = socket
    ownerMutationId = crypto.randomUUID()
    return {mutationId: ownerMutationId}
  }

  if (request.command === "end-owner-mutation") {
    requireOwner(socket, request.command)
    if (ownerMutationClient !== socket || request.mutationId !== ownerMutationId) throw new Error("Owner mutation lease does not match the active mutation")
    ownerMutationClient = undefined
    ownerMutationId = undefined
    return {ended: true}
  }

  if (request.command === "prepare-owner-replacement") {
    if (socket === ownerClient) throw new Error("Committed owner cannot prepare itself as a replacement")
    if (replacementClient && replacementClient !== socket) throw new Error("Another owner replacement candidate is already prepared")
    if (ownerMutationClient) throw new Error("Owner replacement cannot prepare while an owner mutation is in progress")
    if (!ownerState) throw new Error("Committed owner has not published transferable state")
    const currentAuthority = ownerAuthority(ownerState)
    const resumesCommittedAuthority = !ownerClient && isDeepStrictEqual(currentAuthority, request.nextAuthority)

    if (!resumesCommittedAuthority && !isDeepStrictEqual(currentAuthority, request.authority)) {
      throw new Error("Owner replacement authority fence does not match the guardian's committed authority")
    }
    if (request.nextAuthority === undefined) throw new Error("Owner replacement requires the requested authority")
    if (!ownerClient) {
      cancelOwnerRestart()
      const supersededRestartChild = ownerRestartChild

      clearOwnerRestartTracking()
      if (supersededRestartChild) killDetachedProcessGroup(supersededRestartChild)
    }
    if (!replacementId) replacementId = crypto.randomUUID()
    replacementClient = socket
    replacementOwnerPid = request.ownerPid
    replacementAuthority = request.nextAuthority
    replacementRevision = ownerRevision
    if (ownerClient && !ownerClient.destroyed) ownerClient.write(`${JSON.stringify({event: "replacement-prepared", replacementId})}\n`)
    return {ownerState, replacementId}
  }

  if (request.command === "stage-owner-replacement") {
    requireReplacement(socket, request)
    if (replacementRevision !== ownerRevision) throw new Error("Guardian owner state changed after prepare; abort the stale candidate before preparing again")
    if (request.ownerState === undefined || !isDeepStrictEqual(ownerAuthority(request.ownerState), replacementAuthority)) {
      throw new Error("Prepared replacement state does not match the requested authority")
    }
    replacementOwnerState = request.ownerState
    if (!ownerClient) commitReplacement()
    return {committed: ownerClient === socket}
  }

  if (request.command === "abort-owner-replacement") {
    requireReplacement(socket, request)
    abortReplacement("Replacement candidate aborted the prepared transaction")
    return {aborted: true}
  }

  if (request.command === "commit-retired-owner-replacement") {
    requireReplacement(socket, request)
    if (!replacementOwnerState) throw new Error("Retired owner replacement transaction is not staged")
    if (!isDeepStrictEqual(ownerAuthority(ownerState), replacementAuthority)) throw new Error("Retired owner replacement requires unchanged owner authority")
    const controlPath = ownerControlPath(ownerState)

    try {
      await fs.lstat(controlPath)
      throw new Error(`Retired owner control socket ${controlPath} still exists`)
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
    }
    commitReplacement()
    finalizeReplacementRetirement()
    return {committed: true}
  }

  if (request.command === "commit-owner-replacement") {
    requireOwner(socket, request.command)
    if (!replacementClient || request.replacementId !== replacementId || !replacementOwnerState) throw new Error("Owner replacement transaction is not the prepared ready candidate")
    commitReplacement()
    return {committed: true}
  }

  if (request.command === "validate-owner-replacement") {
    requireOwner(socket, request.command)
    if (!replacementClient || request.replacementId !== replacementId) throw new Error("Owner replacement transaction is not the prepared candidate")
    return {valid: true}
  }

  if (request.command === "finalize-owner-replacement") {
    if (retiringClient !== socket || request.replacementId !== retiringReplacementId) throw new Error("Owner replacement retirement finalization requires the committed incumbent transaction")
    finalizeReplacementRetirement()
    return {finalized: true}
  }

  if (request.command === "shutdown") {
    requireOwner(socket, request.command)
    shuttingDown = true
    try {
      const results = await Promise.allSettled([...processes.values()].map((entry) => entry.process.stop()))
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason)

      if (errors.length > 0) throw new AggregateError(errors, `Guardian failed to stop ${errors.length} owned process${errors.length === 1 ? "" : "es"}: ${errors.map((error) => errorMessage(error instanceof Error ? error : String(error))).join("; ")}`)
      if (legacyGuardian) await legacyGuardian.shutdown()
      beginSuccessfulShutdown(socket)
      return {stopped: true}
    } catch (error) {
      shutdownClient = undefined
      shuttingDown = false
      throw error
    }
  }

  if (request.command === "inventory") {
    return [...processes.entries()].map(([key, entry]) => ({key, provenance: entry.provenance, status: entry.process.status()}))
  }

  if (request.command === "remove") {
    requireOwner(socket, request.command)
    if (!request.key || !request.provenance) throw new Error("Guardian remove requires key and provenance")
    const existing = processes.get(request.key)

    if (!existing) throw new Error(`Guardian process ${request.key} is not registered`)
    if (existing.provenance !== request.provenance) throw new Error(`Guardian provenance mismatch for ${request.key}`)
    existing.desired = false
    await existing.process.stop()
    processes.delete(request.key)
    ownerRevision += 1
    return {removed: true}
  }

  if (request.command === "register") {
    if (!request.key || !request.definition || !request.provenance) throw new Error("Guardian register requires key, definition, and provenance")
    const existing = processes.get(request.key)

    if (existing) {
      if (existing.provenance !== request.provenance) throw new Error(`Guardian provenance mismatch for ${request.key}`)
      return existing.process.status()
    }

    const recoversLegacyProcess = Boolean(legacyGuardian && legacyKeys.has(request.key))

    if (!recoversLegacyProcess) requireOwner(socket, request.command)

    const record = /** @type {{desired: boolean, process?: ManagedProcess, provenance: string}} */ ({desired: true, provenance: request.provenance})
    const definition = request.definition
    const managedDefinition = {
      ...definition,
      logger: (/** @type {string} */ message, /** @type {Record<string, import("./json.js").JsonValue>} */ data = {}) => {
        ownerRevision += 1
        broadcast({event: "process", key: request.key, message, data, status: managedProcess.status()})
      },
      shouldRestart: () => record.desired
    }
    const managedProcess = legacyGuardian
      ? legacyGuardian.process(request.key, managedDefinition)
      : new ManagedProcess(managedDefinition)

    if (recoversLegacyProcess && "recover" in managedProcess && typeof managedProcess.recover === "function") await managedProcess.recover()

    record.process = managedProcess
    processes.set(request.key, /** @type {{desired: boolean, process: ManagedProcess, provenance: string}} */ (record))
    if (!recoversLegacyProcess) ownerRevision += 1
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

  ownerRevision += 1

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

/**
 * @param {string} reason - Abort diagnostic.
 * @param {boolean} [scheduleRecovery] - Whether this call owns recovery scheduling.
 */
function abortReplacement(reason, scheduleRecovery = true) {
  if (replacementClient && !replacementClient.destroyed) replacementClient.write(`${JSON.stringify({event: "replacement-aborted", reason})}\n`)
  if (ownerClient && !ownerClient.destroyed) ownerClient.write(`${JSON.stringify({event: "replacement-aborted", reason})}\n`)
  replacementClient = undefined
  replacementId = undefined
  replacementAuthority = undefined
  replacementOwnerState = undefined
  replacementOwnerPid = undefined
  replacementRevision = undefined
  if (scheduleRecovery && !ownerClient) scheduleOwnerRestart()
}

/** Atomically promotes the prepared client and its complete transferable state. */
function commitReplacement() {
  if (!replacementClient || !replacementId || !replacementOwnerState) throw new Error("Owner replacement candidate is not ready")
  const previousOwner = ownerClient
  const committedClient = replacementClient
  const committedId = replacementId

  cancelOwnerRestart()
  const supersededRestartChild = ownerRestartChild

  clearOwnerRestartTracking()
  if (supersededRestartChild) killDetachedProcessGroup(supersededRestartChild)
  for (const waiter of claimWaiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error("Durable owner authority changed while the claim was queued"))
  }
  ownerClient = committedClient
  ownerClientPid = replacementOwnerPid
  ownerRestartRetryDelayMs = undefined
  ownerState = replacementOwnerState
  ownerRevision += 1
  committedReplacementId = committedId
  replacementClient = undefined
  replacementId = undefined
  replacementAuthority = undefined
  replacementOwnerState = undefined
  replacementOwnerPid = undefined
  replacementRevision = undefined
  if (previousOwner && !previousOwner.destroyed) {
    retiringClient = previousOwner
    retiringReplacementId = committedId
  } else {
    publishReplacementCommitted(committedClient, committedId)
  }
}

/** Completes publication only after the incumbent has retired its listeners. */
function finalizeReplacementRetirement() {
  const committedClient = ownerClient
  const committedId = retiringReplacementId
  const previousOwner = retiringClient

  retiringClient = undefined
  retiringReplacementId = undefined
  if (!committedClient || !committedId) return
  publishReplacementCommitted(committedClient, committedId)
  if (previousOwner && !previousOwner.destroyed) previousOwner.write(`${JSON.stringify({event: "replacement-retired", replacementId: committedId})}\n`)
}

/**
 * @param {net.Socket} committedClient - New owner channel.
 * @param {string} committedId - Replacement transaction id.
 */
function publishReplacementCommitted(committedClient, committedId) {
  if (!committedClient.destroyed) committedClient.write(`${JSON.stringify({event: "replacement-committed", replacementId: committedId})}\n`)
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

/**
 * @param {import("./json.js").JsonValue | undefined} state - Committed transferable state.
 * @returns {string} Exact incumbent public control path.
 */
function ownerControlPath(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) || !("snapshot" in state)) throw new Error("Guardian owner state is missing its committed snapshot")
  const snapshot = state.snapshot

  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !("control" in snapshot)) throw new Error("Guardian owner snapshot is missing its control identity")
  const control = snapshot.control

  if (!control || typeof control !== "object" || Array.isArray(control) || !("path" in control) || typeof control.path !== "string") throw new Error("Guardian owner snapshot has an invalid control identity")
  return control.path
}

/**
 * @param {import("./json.js").JsonValue | undefined} state - Committed transferable state.
 * @returns {string} Exact configured public state path.
 */
function ownerStatePath(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) || !("config" in state)) throw new Error("Guardian owner state is missing its committed config")
  const config = state.config

  if (!config || typeof config !== "object" || Array.isArray(config) || !("statePath" in config) || typeof config.statePath !== "string") throw new Error("Guardian owner config is missing its state path")
  return config.statePath
}

/** @param {import("./json.js").JsonValue | undefined} snapshot - Candidate public recovery snapshot. */
function assertBridgeRecoverySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !("recovery" in snapshot)) throw new Error("Legacy disruptive boundary requires a recovery snapshot")
  const recovery = snapshot.recovery

  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery) || !("guardian" in recovery)) throw new Error("Legacy disruptive boundary recovery snapshot is missing its guardian")
  const guardian = recovery.guardian

  if (!guardian || typeof guardian !== "object" || Array.isArray(guardian) || guardian.socketPath !== socketPath || guardian.token !== token) {
    throw new Error("Legacy disruptive boundary recovery snapshot does not identify this guardian")
  }
}

/**
 * Stops accepting connections and closes every authority channel except the response caller.
 * @param {net.Socket} caller - Shutdown requester retained until it receives the response.
 */
function beginSuccessfulShutdown(caller) {
  shutdownClient = caller
  serverClosed = new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve(undefined)
    })
  })

  for (const client of clients) {
    if (client !== caller) client.destroy()
  }
  if (caller.destroyed) void finishShutdown()
}

/** Completes shutdown after the caller has received success and closed its side. */
async function finishShutdown() {
  if (shutdownFinalizing) return
  shutdownFinalizing = true
  for (const client of clients) client.destroy()
  await serverClosed
  await fs.rm(socketPath, {force: true})
}

/** @param {Record<string, import("./json.js").JsonValue>} event - Event payload. */
function broadcast(event) {
  const line = `${JSON.stringify(event)}\n`

  for (const client of clients) if (!client.destroyed) client.write(line)
}

/** @returns {void} Grants the next queued owner claim. */
function grantNextOwner() {
  let next = claimWaiters.shift()

  while (next && ownerState !== undefined && !isDeepStrictEqual(next.authority, ownerAuthority(ownerState))) {
    clearTimeout(next.timer)
    next.reject(new Error("Owner recovery authority changed while the claim was queued"))
    next = claimWaiters.shift()
  }

  if (!next) return
  clearTimeout(next.timer)
  acceptOwnerClaim(next.ownerPid)
  ownerClient = next.socket
  ownerClientPid = next.ownerPid
  next.resolve({claimed: true})
  for (const waiter of claimWaiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error("Durable owner was claimed by another matching daemon"))
  }
}

/** @param {number} [delayMs] - Explicit retry delay, otherwise the accepted reconnect grace. */
function scheduleOwnerRestart(delayMs) {
  if (shuttingDown || ownerClient || replacementClient || ownerRestartChild || ownerRestartTimer) return
  const recovery = ownerRecoveryDefinition()

  if (!recovery) return
  ownerRestartTimer = setTimeout(() => {
    ownerRestartTimer = undefined
    if (shuttingDown || ownerClient || replacementClient || ownerRestartChild) return
    const currentRecovery = ownerRecoveryDefinition()

    if (!currentRecovery) return
    let stdoutFd
    let stderrFd
    let child

    try {
      if (currentRecovery.command.logPath) {
        fsSync.mkdirSync(path.dirname(currentRecovery.command.logPath), {recursive: true})
        stdoutFd = fsSync.openSync(currentRecovery.command.logPath, "a")
        stderrFd = fsSync.openSync(currentRecovery.command.logPath, "a")
      }
      child = spawn(currentRecovery.command.executable, currentRecovery.command.args, {
        cwd: currentRecovery.command.cwd,
        detached: true,
        env: currentRecovery.command.env,
        stdio: currentRecovery.command.logPath ? ["ignore", stdoutFd, stderrFd] : ["ignore", "inherit", "inherit"]
      })
    } catch (error) {
      reportOwnerRestartFailure(currentRecovery, restartFailure(error instanceof Error ? error : String(error)))
      scheduleOwnerRestart(OWNER_RESTART_RETRY_MS)
      return
    } finally {
      if (stdoutFd !== undefined) fsSync.closeSync(stdoutFd)
      if (stderrFd !== undefined) fsSync.closeSync(stderrFd)
    }

    ownerRestartChild = child
    let settled = false
    const retry = (/** @type {{code: string, exitCode?: number | null, signal?: ChildExitSignal}} */ failure) => {
      if (settled || ownerRestartChild !== child) return
      settled = true
      killDetachedProcessGroup(child)
      reportOwnerRestartFailure(currentRecovery, failure)
      clearOwnerRestartTracking(child)
      ownerRestartRetryDelayMs = OWNER_RESTART_RETRY_MS
      if (ownerClient && ownerClientPid === child.pid) ownerClient.destroy()
      else {
        ownerRestartRetryDelayMs = undefined
        scheduleOwnerRestart(OWNER_RESTART_RETRY_MS)
      }
    }

    ownerRestartStartupTimer = setTimeout(() => {
      if (ownerRestartChild !== child) return
      retry({code: "STARTUP_TIMEOUT"})
    }, currentRecovery.startupTimeoutMs)
    ownerRestartStartupTimer.unref()
    child.once("error", (error) => retry(restartFailure(error)))
    child.once("exit", (code, signal) => retry({code: "EARLY_EXIT", exitCode: code, signal}))
    child.unref()
  }, delayMs ?? recovery.reconnectGraceMs)
  ownerRestartTimer.unref()
}

/** Cancels recovery for a superseded owner command. */
function cancelOwnerRestart() {
  if (!ownerRestartTimer) return
  clearTimeout(ownerRestartTimer)
  ownerRestartTimer = undefined
}

/**
 * Accepts an exact claimant and retires any different in-flight recovery child.
 * @param {number | undefined} ownerPid - Exact claimant process PID.
 */
function acceptOwnerClaim(ownerPid) {
  cancelOwnerRestart()
  const child = ownerRestartChild

  if (!child || child.pid === ownerPid) return
  clearOwnerRestartTracking(child)
  killDetachedProcessGroup(child)
}

/**
 * Clears recovery-child startup tracking without disturbing a committed retired listener owner.
 * @param {import("node:child_process").ChildProcess} [expectedChild] - Optional exact child fence.
 * @returns {boolean} Whether matching tracking was cleared.
 */
function clearOwnerRestartTracking(expectedChild) {
  if (expectedChild && ownerRestartChild !== expectedChild) return false
  if (ownerRestartStartupTimer) clearTimeout(ownerRestartStartupTimer)
  ownerRestartStartupTimer = undefined
  ownerRestartChild = undefined
  return true
}

/**
 * Records an owner restart failure without exposing the private command or environment.
 * @param {{command: {cwd?: string, logPath?: string, pidPath?: string}} | undefined} recovery - Accepted recovery definition.
 * @param {{code: string, exitCode?: number | null, signal?: ChildExitSignal}} failure - Secret-safe startup failure.
 */
function reportOwnerRestartFailure(recovery, failure) {
  const diagnostic = `${JSON.stringify({at: new Date().toISOString(), ...failure, message: "guardian failed to restart daemon"})}\n`

  if (recovery?.command.logPath) {
    try {
      fsSync.appendFileSync(recovery.command.logPath, diagnostic)
      return
    } catch (logError) {
      process.stderr.write(`${JSON.stringify({at: new Date().toISOString(), code: errorCode(logError instanceof Error ? logError : String(logError)), message: "guardian failed to write daemon restart diagnostic"})}\n`)
      return
    }
  }
  process.stderr.write(diagnostic)
}

/**
 * Terminates a detached recovery candidate and all descendants in its process group.
 * @param {import("node:child_process").ChildProcess} child - Exact detached process-group leader.
 */
function killDetachedProcessGroup(child) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch (error) {
    const failure = error instanceof Error ? error : String(error)

    if (errorCode(failure) === "ESRCH") return
    child.kill("SIGKILL")
    process.stderr.write(`${JSON.stringify({at: new Date().toISOString(), code: errorCode(failure), message: "guardian failed to kill daemon restart process group"})}\n`)
  }
}

/**
 * @param {Error | string} error - Spawn failure.
 * @returns {{code: string}} Secret-safe failure.
 */
function restartFailure(error) {
  return {code: errorCode(error)}
}

/**
 * @param {Error | string} error - Error-like value.
 * @returns {string} Stable non-secret error code.
 */
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error && (typeof error.code === "string" || typeof error.code === "number")) return String(error.code)
  return "UNKNOWN"
}

/**
 * @returns {{command: {args: string[], cwd: string, env: Record<string, string>, executable: string, logPath?: string, pidPath?: string}, reconnectGraceMs: number, startupTimeoutMs: number} | undefined} Recovery definition.
 */
function ownerRecoveryDefinition() {
  if (!ownerState || typeof ownerState !== "object" || Array.isArray(ownerState) || !("recovery" in ownerState)) return
  const recovery = ownerState.recovery

  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery) || !("command" in recovery) || !("reconnectGraceMs" in recovery)) {
    throw new Error("Guardian owner recovery definition is incomplete")
  }
  return /** @type {{command: {args: string[], cwd: string, env: Record<string, string>, executable: string, logPath?: string, pidPath?: string}, reconnectGraceMs: number, startupTimeoutMs: number}} */ (recovery)
}

/**
 * @param {Error | string} error - Error-like value.
 * @returns {string} Error message.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Derives only exact process keys present in a committed pre-split durable snapshot.
 * @param {import("./json.js").JsonValue | undefined} state - Seeded owner state.
 * @returns {Set<string>} Exact legacy registrations eligible for recovery.
 */
function legacyOwnerKeys(state) {
  const keys = new Set()

  if (!state || typeof state !== "object" || Array.isArray(state) || !("snapshot" in state)) return keys
  const snapshot = state.snapshot

  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return keys
  if (Array.isArray(snapshot.releases)) {
    for (const release of snapshot.releases) {
      if (!release || typeof release !== "object" || Array.isArray(release) || typeof release.releaseId !== "string" || !Array.isArray(release.processes)) continue
      for (const processStatus of release.processes) {
        if (processStatus && typeof processStatus === "object" && !Array.isArray(processStatus) && typeof processStatus.id === "string") keys.add(`release:${release.releaseId}:${processStatus.id}`)
      }
    }
  }
  if (Array.isArray(snapshot.services)) {
    for (const service of snapshot.services) {
      if (service && typeof service === "object" && !Array.isArray(service) && typeof service.id === "string") keys.add(`service:${service.id}`)
    }
  }
  if (typeof snapshot.activeReleaseId === "string" && Array.isArray(snapshot.singletons)) {
    for (const singleton of snapshot.singletons) {
      if (singleton && typeof singleton === "object" && !Array.isArray(singleton) && typeof singleton.id === "string") keys.add(`singleton:${snapshot.activeReleaseId}:${singleton.id}`)
    }
  }
  return keys
}
