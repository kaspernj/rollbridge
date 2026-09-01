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
import {writeState} from "./state-store.js"

const OWNER_RESTART_RETRY_MS = 1000

/** @typedef {import("node:child_process").ChildProcess["signalCode"]} ChildExitSignal */

/**
 * @typedef {object} GuardianRequest
 * @property {string} command - Operation name.
 * @property {{http?: number, websocket?: number}} [connections] - Retired listener counts.
 * @property {ConstructorParameters<typeof ManagedProcess>[0]} [definition] - Managed process definition.
 * @property {number} [graceMs] - Owner reconnection grace.
 * @property {number} id - Request id.
 * @property {string} [key] - Stable process key.
 * @property {boolean} [localSource] - Whether the retired daemon physically owns the published source.
 * @property {{timeoutMs?: number}} [options] - Stop options.
 * @property {string} [previousProvenance] - Expected current provenance.
 * @property {string} [provenance] - New or registered provenance.
 * @property {string} [releaseId] - Retained release identity.
 * @property {string} [sourceId] - Stable retired-listener source identity.
 * @property {import("./json.js").JsonValue} [ownerState] - Private owner transfer state.
 * @property {string} [replacementId] - Prepared replacement transaction id.
 * @property {string} [mutationId] - Owner mutation lease id.
 * @property {string} [operation] - Owner mutation diagnostic name.
 * @property {number} [ownerPid] - Exact claimant process PID.
 * @property {import("./json.js").JsonValue} [recoverySnapshot] - Public bridge recovery snapshot.
 * @property {string} [statePath] - Exact public recovery state path.
 * @property {import("./json.js").JsonValue} [authority] - Expected current authority.
 * @property {import("./json.js").JsonValue} [nextAuthority] - Requested replacement authority.
 * @property {import("./managed-process.js").ManagedProcessStartReason} [reason] - Start reason.
 * @property {import("./managed-process.js").LifecycleRole} [lifecycleRole] - Desired generation role restored during start.
 * @property {string} token - Authentication token.
 */
/** @typedef {{listenerStateComplete: boolean, localSources: Map<string, Map<string, {http: number, websocket: number}>>, replacementId: string, successor: net.Socket}} RetiredListenerTransaction */

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
/** @type {Set<net.Socket>} */
const backpressuredClients = new Set()
/** @type {Map<net.Socket, Map<string, string>>} */
const pendingStatusEvents = new Map()
/** @type {Map<net.Socket, number>} */
const ownerUpdatesInFlight = new Map()
/** @type {Map<net.Socket, RetiredListenerTransaction>} */
const retiredListenerClients = new Map()
/** @type {Set<RetiredListenerTransaction>} */
const disconnectedOwnerSuccessors = new Set()
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
const legacyKeys = legacyGuardian ? committedOwnerProcessKeys(ownerState) : new Set()
/** @type {net.Socket | undefined} */
let ownerMutationClient
/** @type {string | undefined} */
let ownerMutationId
/** @type {net.Socket | undefined} */
let retiringClient
/** @type {string | undefined} */
let retiringReplacementId
let retiringListenerReady = false
let retirementFailed = false
/** @type {Promise<Error | undefined> | undefined} */
let legacyOwnerClaim
/** @type {import("./json.js").JsonValue | undefined} */
let legacyRecoverySnapshot
/** @type {string | undefined} */
let legacyRecoveryStatePath
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
  socket.on("drain", () => flushStatusEvents(socket))
  let buffer = ""

  socket.once("close", () => {
    const controlLessRetirement = retiredListenerClients.get(socket)

    clients.delete(socket)
    backpressuredClients.delete(socket)
    pendingStatusEvents.delete(socket)
    const waiterIndex = claimWaiters.findIndex((waiter) => waiter.socket === socket)

    if (waiterIndex >= 0) {
      const [waiter] = claimWaiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.reject(new Error("Owner claimant disconnected"))
    }
    if (ownerMutationClient === socket && ownerClient !== socket) {
      ownerMutationClient = undefined
      ownerMutationId = undefined
    }
    if (controlLessRetirement) {
      const preCommitHandoff = replacementClient && ownerClient === socket && retiringReplacementId === replacementId

      if (preCommitHandoff) {
        publishClosedLocalSources(controlLessRetirement)
        if (!controlLessRetirement.successor.destroyed) {
          controlLessRetirement.successor.write(`${JSON.stringify({event: "replacement-retirement-failed", reason: "Incumbent listener disconnected during the prepared handoff", replacementId: controlLessRetirement.replacementId})}\n`)
        }
        abortReplacement("Incumbent listener disconnected during the prepared handoff", false)
      } else if (retiringClient === socket && !controlLessRetirement.listenerStateComplete) {
        retirementFailed = true
        retiringClient = undefined
        retiringReplacementId = undefined
        if (ownerClient && !ownerClient.destroyed) {
          ownerClient.write(`${JSON.stringify({event: "replacement-retirement-failed", reason: "Retired listener disconnected before publishing complete connection state", replacementId: controlLessRetirement.replacementId})}\n`)
        }
      } else if (controlLessRetirement.listenerStateComplete) {
        publishClosedLocalSources(controlLessRetirement)
        if (retiringClient === socket) finalizeReplacementRetirement()
      }
    } else if (retiringClient === socket) finalizeReplacementRetirement()
    if (controlLessRetirement && retiredListenerClients.has(socket)) {
      for (const transaction of retiredListenerClients.values()) {
        if (transaction.successor === socket) transaction.successor = controlLessRetirement.successor
      }
      disconnectedOwnerSuccessors.delete(controlLessRetirement)
      retiredListenerClients.delete(socket)
    }
    if (ownerClient === socket && !ownerUpdatesInFlight.has(socket)) releaseClosedOwner(socket)
    if (replacementClient === socket) {
      abortReplacement("Replacement candidate disconnected before commit")
      if (legacyGuardian && !legacyOwnerClaim && !ownerClient && !committedReplacementId) {
        legacyGuardian.disconnect()
        shuttingDown = true
        beginSuccessfulShutdown(socket)
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
  let ownerUpdate = false

  try {
    request = /** @type {GuardianRequest} */ (JSON.parse(line))
    if (request.token !== token) throw new Error("Guardian authentication failed")
    if (ownerClient === socket && request.command === "update") {
      ownerUpdate = true
      ownerUpdatesInFlight.set(socket, (ownerUpdatesInFlight.get(socket) ?? 0) + 1)
    }
    const result = await execute(request, socket)

    socket.write(`${JSON.stringify({id: request.id, result})}\n`)
  } catch (error) {
    if (!socket.destroyed) socket.write(`${JSON.stringify({error: error instanceof Error ? error.message : String(error), id: request?.id})}\n`)
  } finally {
    if (ownerUpdate) completeOwnerUpdate(socket)
  }
}

/**
 * @param {GuardianRequest} request - Authenticated request.
 * @param {net.Socket} socket - Requesting client.
 * @returns {Promise<import("./json.js").JsonValue>} Command result.
 */
async function execute(request, socket) {
  if (shuttingDown) throw new Error("Process guardian is shutting down")

  if (request.command === "capabilities") return {daemonRecovery: 1, generationReactivation: 1}

  if (request.command === "owner-replacement-capabilities") {
    return {commands: ["commit-retired-owner-replacement"], protocol: "owner-replacement", version: 1}
  }

  if (request.command === "claim-owner") {
    if (retirementFailed) throw new Error("Guardian owner replacement is fenced after incomplete retired-listener state transfer")
    if (ownerState !== undefined && !isDeepStrictEqual(request.authority, ownerAuthority(ownerState))) {
      const waitsForPreparedAuthority = Boolean(ownerClient && replacementOwnerState && isDeepStrictEqual(request.authority, replacementAuthority))

      if (!waitsForPreparedAuthority) throw new Error("Owner recovery authority does not match the guardian's committed authority")
    }
    if (!ownerClient) {
      acceptOwnerClaim(request.ownerPid)
      ownerClient = socket
      ownerClientPid = request.ownerPid
      reattachRetiredListenerSuccessors(socket)
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
    clearOwnerLocalListenerSource()
    rememberDisconnectedOwnerSuccessors(socket)
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
    if (ownerClient || committedReplacementId) throw new Error("Committed guardian authority cannot abandon its legacy backend")
    if (replacementClient && replacementClient !== socket) throw new Error("Only the prepared replacement can abandon the legacy upgrade")
    if (replacementClient) abortReplacement("Legacy guardian upgrade candidate abandoned before the disruptive boundary")
    legacyGuardian.disconnect()
    shuttingDown = true
    beginSuccessfulShutdown(socket)
    return {abandoned: true}
  }

  if (request.command === "begin-legacy-owner-claim") {
    if (!legacyGuardian) throw new Error("Guardian is not a legacy upgrade coordinator")
    requireReplacement(socket, request)
    if (legacyOwnerClaim) throw new Error("Legacy guardian owner claim is already pending")
    if (replacementAuthority === undefined) throw new Error("Legacy guardian owner claim is missing replacement authority")
    if (!request.statePath || !path.isAbsolute(request.statePath)) throw new Error("Legacy guardian owner claim requires an absolute state path")
    if (request.statePath !== ownerStatePath(ownerState)) throw new Error("Legacy guardian owner claim state path does not match the committed owner config")
    assertBridgeRecoverySnapshot(request.recoverySnapshot)
    legacyRecoveryStatePath = request.statePath
    legacyRecoverySnapshot = request.recoverySnapshot
    legacyOwnerClaim = legacyGuardian.claimOwner(request.graceMs ?? 30000, replacementAuthority).then(
      () => undefined,
      (error) => error instanceof Error ? error : new Error(String(error))
    )
    return {prepared: true}
  }

  if (request.command === "complete-legacy-owner-claim") {
    if (!legacyGuardian || !legacyOwnerClaim) throw new Error("Legacy guardian owner claim was not prepared")
    requireReplacement(socket, request)
    const claimError = await legacyOwnerClaim

    if (claimError) throw claimError
    if (!legacyRecoveryStatePath || legacyRecoverySnapshot === undefined) throw new Error("Legacy guardian owner claim is missing durable recovery state")
    await writeState(legacyRecoveryStatePath, legacyRecoverySnapshot)
    return {claimed: true}
  }

  if (request.command === "publish-owner-state") {
    requireOwner(socket, request.command)
    if (request.ownerState === undefined) throw new Error("Guardian owner publication requires ownerState")
    ownerState = mergeOwnerConnectionState(ownerState, request.ownerState)
    ownerRevision += 1
    if (!retiringClient) committedReplacementId = undefined
    return {published: true}
  }

  if (request.command === "owner-state") {
    requireOwner(socket, request.command)
    if (!ownerState) throw new Error("Committed owner has not published transferable state")
    return {ownerState}
  }

  if (request.command === "replacement-status") {
    return {committedReplacementId: committedReplacementId ?? null, ownerClaimed: Boolean(ownerClient), retirementFailed, retirementPending: Boolean(retiringClient), retirementReady: retiringListenerReady}
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
    if (retirementFailed) throw new Error("Guardian owner replacement is fenced after incomplete retired-listener state transfer")
    if (retiringClient) throw new Error("Guardian owner replacement cannot prepare while listener retirement is pending")
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
    retirementFailed = false
    retiringListenerReady = false
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
    replacementOwnerState = mergeOwnerConnectionState(ownerState, request.ownerState)
    if (!ownerClient) commitReplacement()
    return {committed: ownerClient === socket}
  }

  if (request.command === "abort-owner-replacement") {
    requireReplacement(socket, request)
    abortReplacement("Replacement candidate aborted the prepared transaction")
    return {aborted: true}
  }

  if (request.command === "prepare-retired-owner-listener-handoff") {
    requireReplacement(socket, request)
    requireRetiredOwnerReplacement(request)
    await requireMissingOwnerControlPath(ownerState)
    requireReplacement(socket, request)
    if (!ownerClient || ownerClient.destroyed) throw new Error("Retired owner listener handoff requires the connected committed owner")
    if (retiringClient) throw new Error("Another owner listener retirement is already pending")
    retiringClient = ownerClient
    retiringReplacementId = /** @type {string} */ (request.replacementId)
    retiredListenerClients.set(ownerClient, {
      listenerStateComplete: false,
      localSources: new Map(),
      replacementId: /** @type {string} */ (request.replacementId),
      successor: socket
    })
    ownerClient.write(`${JSON.stringify({event: "replacement-listener-handoff-requested", replacementId: request.replacementId})}\n`)
    return {prepared: true}
  }

  if (request.command === "commit-retired-owner-replacement") {
    requireReplacement(socket, request)
    requireRetiredOwnerReplacement(request)
    await requireMissingOwnerControlPath(ownerState)
    const listener = retiringClient

    if (!listener || listener !== ownerClient || listener.destroyed || !retiringListenerReady || retiredListenerClients.get(listener)?.successor !== socket) {
      throw new Error("Retired owner replacement requires a complete prepared listener handoff")
    }
    commitReplacement()
    if (ownerClient) {
      const retirement = retiredListenerClients.get(listener)

      if (!retirement) throw new Error("Retired owner replacement lost its prepared listener handoff")
      retirement.successor = ownerClient
      listener.write(`${JSON.stringify({event: "replacement-retirement-requested", replacementId: request.replacementId})}\n`)
    }
    return {committed: true}
  }

  if (request.command === "publish-owner-connection-state") {
    const retirement = retiredListenerClients.get(socket)

    if (!retirement || retirement.replacementId !== request.replacementId) throw new Error("Owner connection state requires the exact retired listener transaction")
    if (typeof request.sourceId !== "string" || !request.sourceId || typeof request.releaseId !== "string" || !request.connections || typeof request.connections !== "object" || Array.isArray(request.connections)) {
      throw new Error("Owner connection state requires a source, release, and connection counts")
    }
    const connections = request.connections
    const http = connections.http
    const websocket = connections.websocket

    if (typeof http !== "number" || !Number.isSafeInteger(http) || http < 0 || typeof websocket !== "number" || !Number.isSafeInteger(websocket) || websocket < 0) {
      throw new Error("Owner connection state requires non-negative integer counts")
    }
    const normalized = {http, websocket}

    if (request.localSource) setRetiredLocalSource(retirement, request.sourceId, request.releaseId, normalized)
    applyOwnerConnectionState(ownerState, request.sourceId, request.releaseId, normalized)
    if (replacementOwnerState) applyOwnerConnectionState(replacementOwnerState, request.sourceId, request.releaseId, normalized)
    publishOwnerConnectionState(retirement.successor, request.sourceId, request.releaseId, normalized)
    return {published: true}
  }

  if (request.command === "complete-owner-listener-retirement") {
    if (retiredListenerClients.get(socket)?.replacementId !== request.replacementId || retiringClient !== socket) {
      throw new Error("Owner listener retirement completion requires the exact retired listener transaction")
    }
    retiringListenerReady = true
    const retirement = retiredListenerClients.get(socket)

    if (!retirement) throw new Error("Owner listener retirement completion lost its transaction")
    retirement.listenerStateComplete = true
    const successor = retirement.successor

    if (successor && !successor.destroyed) {
      successor.write(`${JSON.stringify({event: "replacement-listeners-retired", replacementId: request.replacementId})}\n`)
    }
    return {completed: true}
  }

  if (request.command === "commit-owner-replacement") {
    requireOwner(socket, request.command)
    if (!replacementClient || request.replacementId !== replacementId || !replacementOwnerState) throw new Error("Owner replacement transaction is not the prepared ready candidate")
    retiredListenerClients.set(socket, {
      listenerStateComplete: false,
      localSources: new Map(),
      replacementId: /** @type {string} */ (request.replacementId),
      successor: replacementClient
    })
    commitReplacement()
    return {committed: true}
  }

  if (request.command === "validate-owner-replacement") {
    requireOwner(socket, request.command)
    if (!replacementClient || request.replacementId !== replacementId) throw new Error("Owner replacement transaction is not the prepared candidate")
    return {valid: true}
  }

  if (request.command === "finalize-owner-replacement") {
    const incumbentRetirement = retiredListenerClients.get(socket)
    const incumbentFinalization = retiringClient === socket && (!incumbentRetirement || incumbentRetirement.listenerStateComplete)
    const candidateFinalization = ownerClient === socket && retiringListenerReady && !retirementFailed
    const alreadyFinalized = ownerClient === socket && !retiringClient && request.replacementId === committedReplacementId && !retirementFailed

    if (alreadyFinalized) return {finalized: true}
    if ((!incumbentFinalization && !candidateFinalization) || request.replacementId !== retiringReplacementId) {
      throw new Error("Owner replacement retirement finalization requires the committed listener transaction")
    }
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
    // Only process keys inventoried from the legacy guardian remain delegated to it.
    // New release processes must be owned by the current guardian so current lifecycle
    // fields (including activation timeouts) are enforced instead of downgraded by an
    // older guardian protocol implementation.
    const managedProcess = recoversLegacyProcess && legacyGuardian
      ? legacyGuardian.process(request.key, managedDefinition)
      : new ManagedProcess(managedDefinition)

    managedProcess.on("log", (entry) => {
      broadcast({entry, event: "process-log", key: request.key})
    })
    if (recoversLegacyProcess && "recover" in managedProcess && typeof managedProcess.recover === "function") await managedProcess.recover()

    record.process = managedProcess
    processes.set(request.key, /** @type {{desired: boolean, process: ManagedProcess, provenance: string}} */ (record))
    if (!recoversLegacyProcess) ownerRevision += 1
    return managedProcess.status()
  }

  const record = requireProcess(request)

  if (request.command !== "status") requireOwner(socket, request.command)

  if (request.command === "start") {
    record.desired = true
    await record.process.start(request.reason, request.lifecycleRole)
  } else if (request.command === "activate") {
    await record.process.activateStrict()
  } else if (request.command === "reactivate" || request.command === "reactivate-with-command") {
    await record.process.reactivateStrict()
    record.desired = true
  } else if (request.command === "quiesce") {
    record.desired = false
    await record.process.quiesceStrict()
  } else if (request.command === "requiesce") {
    record.desired = false
    await record.process.requiesceStrict()
  } else if (request.command === "set-lifecycle-role") {
    if (request.lifecycleRole !== "active" && request.lifecycleRole !== "candidate" && request.lifecycleRole !== "retired") throw new Error("Guardian lifecycle role is invalid")
    await record.process.setLifecycleRole(request.lifecycleRole)
  } else if (request.command === "stop") {
    record.desired = false
    await record.process.stop(request.options)
  } else if (request.command === "update") {
    if (!request.definition || !request.provenance) throw new Error("Guardian update requires definition and provenance")
    if (record.provenance !== request.previousProvenance) throw new Error(`Guardian provenance mismatch for ${request.key}`)
    await record.process.updateDefinition({
      ...request.definition,
      lifecycle: request.definition.lifecycle || {drainTimeoutMs: 0},
      logger: record.process.logger,
      memory: request.definition.memory,
      restart: request.definition.restart || {backoffFactor: 1, maxDelayMs: 0, maxRestarts: undefined, windowMs: 0},
      shouldRestart: () => record.desired,
      stopSignal: request.definition.stopSignal || "SIGTERM"
    })
    record.provenance = request.provenance
    if (request.ownerState !== undefined) {
      ownerState = mergeOwnerConnectionState(ownerState, request.ownerState)
      committedReplacementId = undefined
    }
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
 * Releases authority only after every accepted request from the disconnected owner settles.
 * @param {net.Socket} socket - Disconnected owner socket.
 */
function releaseClosedOwner(socket) {
  if (ownerClient !== socket) return
  const incompleteRestartChild = ownerRestartChild?.pid === ownerClientPid ? ownerRestartChild : undefined

  clearOwnerLocalListenerSource()
  rememberDisconnectedOwnerSuccessors(socket)
  ownerClient = undefined
  ownerClientPid = undefined
  if (ownerMutationClient === socket) {
    ownerMutationClient = undefined
    ownerMutationId = undefined
  }
  if (replacementClient && replacementOwnerState) commitReplacement()
  else {
    if (incompleteRestartChild) {
      reportOwnerRestartFailure(ownerRecoveryDefinition(), {code: "OWNER_DISCONNECTED"})
      killDetachedProcessGroup(incompleteRestartChild)
      clearOwnerRestartTracking(incompleteRestartChild)
      ownerRestartRetryDelayMs = OWNER_RESTART_RETRY_MS
    }
    if (replacementClient) abortReplacement("Committed owner disconnected before replacement candidate was ready", false)
    if (retirementFailed) return
    if (!shuttingDown) {
      grantNextOwner()
      const retryDelayMs = ownerRestartRetryDelayMs

      ownerRestartRetryDelayMs = undefined
      scheduleOwnerRestart(retryDelayMs)
    }
  }
}

/**
 * Completes one accepted owner update and applies a deferred disconnect boundary.
 * @param {net.Socket} socket - Requesting owner socket.
 */
function completeOwnerUpdate(socket) {
  const remaining = (ownerUpdatesInFlight.get(socket) ?? 1) - 1

  if (remaining > 0) {
    ownerUpdatesInFlight.set(socket, remaining)
    return
  }
  ownerUpdatesInFlight.delete(socket)
  if (socket.destroyed) releaseClosedOwner(socket)
}

/**
 * @param {string} reason - Abort diagnostic.
 * @param {boolean} [scheduleRecovery] - Whether this call owns recovery scheduling.
 */
function abortReplacement(reason, scheduleRecovery = true) {
  const abortedReplacementId = replacementId

  if (replacementClient && !replacementClient.destroyed) replacementClient.write(`${JSON.stringify({event: "replacement-aborted", reason})}\n`)
  if (ownerClient && !ownerClient.destroyed) ownerClient.write(`${JSON.stringify({event: "replacement-aborted", reason})}\n`)
  if (retiringClient && retiringClient === ownerClient && retiringReplacementId === abortedReplacementId) {
    const retirement = retiredListenerClients.get(retiringClient)

    if (retirement) disconnectedOwnerSuccessors.delete(retirement)
    retiredListenerClients.delete(retiringClient)
    retiringClient = undefined
    retiringReplacementId = undefined
    retiringListenerReady = false
    retirementFailed = false
  }
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
  const restartChildIsIncumbent = Boolean(previousOwner && supersededRestartChild?.pid === ownerClientPid)

  clearOwnerRestartTracking()
  if (supersededRestartChild && !restartChildIsIncumbent) killDetachedProcessGroup(supersededRestartChild)
  ownerClient = committedClient
  ownerClientPid = replacementOwnerPid
  ownerRestartRetryDelayMs = undefined
  ownerState = replacementOwnerState
  ownerRevision += 1
  committedReplacementId = committedId
  for (const waiter of claimWaiters.splice(0)) {
    if (isDeepStrictEqual(waiter.authority, ownerAuthority(ownerState))) {
      claimWaiters.push(waiter)
    } else {
      clearTimeout(waiter.timer)
      waiter.reject(new Error("Durable owner authority changed while the claim was queued"))
    }
  }
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
  retiringListenerReady = false
  retirementFailed = false
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
 * @param {GuardianRequest} request - Keyed guardian request.
 * @returns {{desired: boolean, process: ManagedProcess, provenance: string}} Exact registered process.
 */
function requireProcess(request) {
  if (!request.key) throw new Error(`Guardian ${request.command} requires a process key`)
  const record = processes.get(request.key)

  if (!record) throw new Error(`Guardian process ${request.key} is not registered`)
  return record
}

/**
 * @param {RetiredListenerTransaction} retirement - Retired listener transaction.
 * @param {string} sourceId - Physically-owned source.
 * @param {string} releaseId - Retained release.
 * @param {{http: number, websocket: number}} connections - Exact live counts.
 */
function setRetiredLocalSource(retirement, sourceId, releaseId, connections) {
  const releases = retirement.localSources.get(sourceId) || new Map()

  if (connections.http + connections.websocket === 0) releases.delete(releaseId)
  else releases.set(releaseId, connections)
  if (releases.size === 0) retirement.localSources.delete(sourceId)
  else retirement.localSources.set(sourceId, releases)
}

/**
 * @param {net.Socket | undefined} firstSuccessor - First daemon that inherited the source.
 * @param {string} sourceId - Stable listener source.
 * @param {string} releaseId - Retained release.
 * @param {{http: number, websocket: number}} connections - Exact live counts.
 * @param {Set<net.Socket>} [delivered] - Successors that already received this update.
 */
function publishOwnerConnectionState(firstSuccessor, sourceId, releaseId, connections, delivered = new Set()) {
  let successor = firstSuccessor

  while (successor && !delivered.has(successor)) {
    delivered.add(successor)
    if (!successor.destroyed) {
      successor.write(`${JSON.stringify({connections, event: "owner-connection-state", releaseId, sourceId})}\n`)
    }
    successor = retiredListenerClients.get(successor)?.successor
  }
}

/** @param {RetiredListenerTransaction} retirement - Disconnected completed listener. */
function publishClosedLocalSources(retirement) {
  for (const [sourceId, releases] of retirement.localSources) {
    for (const releaseId of releases.keys()) {
      const connections = {http: 0, websocket: 0}
      const delivered = /** @type {Set<net.Socket>} */ (new Set())

      applyOwnerConnectionState(ownerState, sourceId, releaseId, connections)
      if (replacementOwnerState) {
        applyOwnerConnectionState(replacementOwnerState, sourceId, releaseId, connections)
        publishOwnerConnectionState(replacementClient, sourceId, releaseId, connections, delivered)
      }
      publishOwnerConnectionState(retirement.successor, sourceId, releaseId, connections, delivered)
    }
  }
}

/**
 * @param {import("./json.js").JsonValue | undefined} state - Candidate or committed private owner state.
 * @param {string} sourceId - Stable listener source.
 * @param {string} releaseId - Retained release.
 * @param {{http: number, websocket: number}} connections - Exact live counts.
 */
function applyOwnerConnectionState(state, sourceId, releaseId, connections) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Guardian owner connection state requires transferable owner state")
  const transferable = /** @type {{listenerConnectionSources?: Record<string, Record<string, {http: number, websocket: number}>>}} */ (state)
  const sources = transferable.listenerConnectionSources || {}
  const releases = sources[sourceId] || {}

  if (connections.http + connections.websocket === 0) {
    delete releases[releaseId]
  } else {
    releases[releaseId] = connections
  }
  if (Object.keys(releases).length === 0) delete sources[sourceId]
  else sources[sourceId] = releases
  transferable.listenerConnectionSources = sources
}

/** Clears the physically-owned source before another daemon reconstructs committed state. */
function clearOwnerLocalListenerSource() {
  if (!ownerState || typeof ownerState !== "object" || Array.isArray(ownerState)) return
  const transferable = /** @type {{listenerConnectionSources?: Record<string, Record<string, {http: number, websocket: number}>>, listenerSourceId?: string}} */ (ownerState)
  const sourceId = transferable.listenerSourceId

  if (!sourceId) return
  for (const releaseId of Object.keys(transferable.listenerConnectionSources?.[sourceId] || {})) {
    const connections = {http: 0, websocket: 0}

    applyOwnerConnectionState(ownerState, sourceId, releaseId, connections)
    if (replacementOwnerState) {
      applyOwnerConnectionState(replacementOwnerState, sourceId, releaseId, connections)
      publishOwnerConnectionState(replacementClient, sourceId, releaseId, connections)
    }
  }
}

/**
 * Preserves guardian-confirmed source updates while accepting the publisher's own local source.
 * @param {import("./json.js").JsonValue | undefined} previousState - Current guardian state.
 * @param {import("./json.js").JsonValue} nextState - Incoming owner publication.
 * @returns {import("./json.js").JsonValue} Publication with guardian source state merged in.
 */
function mergeOwnerConnectionState(previousState, nextState) {
  if (!nextState || typeof nextState !== "object" || Array.isArray(nextState)) throw new Error("Guardian owner publication requires transferable owner state")
  const next = /** @type {{listenerConnectionSources?: Record<string, Record<string, {http: number, websocket: number}>>, listenerSourceId?: string}} */ (nextState)
  const publishesSources = next.listenerConnectionSources !== undefined
  const localSourceId = next.listenerSourceId

  if (!previousState || typeof previousState !== "object" || Array.isArray(previousState) || !localSourceId) return nextState
  const previous = /** @type {{listenerConnectionSources?: Record<string, Record<string, {http: number, websocket: number}>>}} */ (previousState)
  const sources = /** @type {Record<string, Record<string, {http: number, websocket: number}>>} */ ({})
  const localReleases = next.listenerConnectionSources?.[localSourceId]

  if (localReleases && Object.keys(localReleases).length > 0) sources[localSourceId] = localReleases
  for (const [sourceId, releases] of Object.entries(previous.listenerConnectionSources || {})) {
    if (sourceId !== localSourceId) sources[sourceId] = releases
  }
  if (publishesSources || Object.keys(sources).length > 0) next.listenerConnectionSources = sources
  return nextState
}

/** @param {GuardianRequest} request - Staged same-authority listener handoff request. */
function requireRetiredOwnerReplacement(request) {
  requireProcess(request)
  if (!committedOwnerProcessKeys(ownerState).has(/** @type {string} */ (request.key))) {
    throw new Error(`Guardian process ${request.key} does not belong to the committed owner`)
  }
  if (!replacementOwnerState) throw new Error("Retired owner replacement transaction is not staged")
  if (!isDeepStrictEqual(ownerAuthority(ownerState), replacementAuthority)) throw new Error("Retired owner replacement requires unchanged owner authority")
}

/** @param {import("./json.js").JsonValue | undefined} state - Committed transferable state. */
async function requireMissingOwnerControlPath(state) {
  const controlPath = ownerControlPath(state)

  try {
    await fs.lstat(controlPath)
    throw new Error(`Retired owner control socket ${controlPath} still exists`)
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
  }
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
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !("recovery" in snapshot)) throw new Error("Legacy guardian owner claim requires a recovery snapshot")
  const recovery = snapshot.recovery

  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery) || !("guardian" in recovery)) throw new Error("Legacy guardian owner claim recovery snapshot is missing its guardian")
  const guardian = recovery.guardian

  if (!guardian || typeof guardian !== "object" || Array.isArray(guardian) || guardian.socketPath !== socketPath || guardian.token !== token) {
    throw new Error("Legacy guardian owner claim recovery snapshot does not identify this guardian")
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

  for (const client of clients) {
    if (client.destroyed) continue
    if (backpressuredClients.has(client)) {
      if (typeof event.key === "string") {
        const pending = pendingStatusEvents.get(client) || new Map()

        if (event.event === "process-log") {
          const record = processes.get(event.key)

          if (record) pending.set(event.key, `${JSON.stringify({event: "status", key: event.key, status: record.process.status()})}\n`)
        } else {
          pending.set(event.key, line)
        }
        pendingStatusEvents.set(client, pending)
      }
      continue
    }
    if (!client.write(line)) backpressuredClients.add(client)
  }
}

/**
 * Flushes one latest status-bearing event per process after socket backpressure clears.
 * @param {net.Socket} client - Drained guardian client socket.
 */
function flushStatusEvents(client) {
  backpressuredClients.delete(client)
  const pending = pendingStatusEvents.get(client)

  if (!pending || client.destroyed) return
  for (const [key, line] of pending) {
    pending.delete(key)
    if (!client.write(line)) {
      backpressuredClients.add(client)
      break
    }
  }
  if (pending.size === 0) pendingStatusEvents.delete(client)
}

/** @param {net.Socket} owner - Disconnected or retiring committed owner. */
function rememberDisconnectedOwnerSuccessors(owner) {
  for (const transaction of retiredListenerClients.values()) {
    if (transaction.successor === owner) disconnectedOwnerSuccessors.add(transaction)
  }
}

/** @param {net.Socket} successor - Newly claimed recovery owner. */
function reattachRetiredListenerSuccessors(successor) {
  for (const transaction of disconnectedOwnerSuccessors) transaction.successor = successor
  disconnectedOwnerSuccessors.clear()
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
  reattachRetiredListenerSuccessors(next.socket)
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
 * Derives only exact process keys serialized by committed private owner state.
 * @param {import("./json.js").JsonValue | undefined} state - Committed owner state.
 * @returns {Set<string>} Exact committed registrations eligible as owner proof.
 */
function committedOwnerProcessKeys(state) {
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
  const singletonReleaseIds = "singletonReleaseIds" in state && state.singletonReleaseIds && typeof state.singletonReleaseIds === "object" && !Array.isArray(state.singletonReleaseIds)
    ? state.singletonReleaseIds
    : {}

  if (Array.isArray(snapshot.singletons)) {
    for (const singleton of snapshot.singletons) {
      if (!singleton || typeof singleton !== "object" || Array.isArray(singleton) || typeof singleton.id !== "string") continue
      const releaseId = singleton.id in singletonReleaseIds && typeof singletonReleaseIds[singleton.id] === "string"
        ? singletonReleaseIds[singleton.id]
        : snapshot.activeReleaseId

      if (typeof releaseId === "string") keys.add(`singleton:${releaseId}:${singleton.id}`)
    }
  }
  return keys
}
