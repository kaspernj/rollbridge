// @ts-check

import fs from "node:fs/promises"
import net from "node:net"
import {inspectControlSocket} from "./daemon.js"
import {clearState, isProcessAlive, liveProcesses, readState} from "./state-store.js"

// How long to confirm a SIGKILL'd group has actually exited before reporting it un-stoppable.
const KILL_CONFIRM_TIMEOUT_MS = 500

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {{id: string, pid: number, releaseId: string | null}} OrphanProcess
 * @typedef {{error: string}} RecoverError
 * @typedef {{archived: boolean, archivePath?: string, cleared: boolean, deadGuardianState: boolean, forced: boolean, orphans: OrphanProcess[], remaining: OrphanProcess[]}} RecoverReport
 * @typedef {RecoverError | RecoverReport} RecoverResult
 */

/**
 * Cleans up orphaned managed processes left by a crashed daemon. Reads the persisted state
 * (config.statePath) and finds managed processes whose pids are still alive. By default it
 * only reports them; with `force` it stops each one's process group (SIGTERM, then SIGKILL
 * after the configured timeout) and clears the stale state file.
 *
 * When `force` leaves any orphan still running (for example a process owned by another user
 * that can't be signaled), the state file is **kept** so the operator can investigate and
 * re-run recovery — the survivors are returned in `remaining` and `cleared` stays false.
 *
 * Refuses to run while a daemon (or another process) holds the control socket — those pids
 * belong to a live daemon, not a crash. A recycled pid can be a false positive, so review the
 * dry-run list before using `force`.
 * @param {object} args - Options.
 * @param {import("./config.js").RollbridgeConfig} args.config - Normalized config.
 * @param {boolean} args.force - Whether to actually stop the orphans (otherwise list them).
 * @param {(socketPath: string) => Promise<boolean | undefined>} [args.probeUnixListener] - Probes whether a Unix socket has a live listener (defaults to the real probe; injectable for tests).
 * @param {(pid: number, timeoutMs: number) => Promise<boolean>} [args.stopGroup] - Stops a process group and resolves to whether it is gone afterward (defaults to the real implementation; injectable for tests).
 * @returns {Promise<RecoverResult>} The orphans found and whether they were stopped, or an error.
 */
export async function recoverOrphans({config, force, probeUnixListener = probeUnixListenerAt, stopGroup = stopProcessGroup}) {
  if (config.statePath === undefined) {
    return {error: "No statePath is configured; set statePath in the config to enable recovery."}
  }

  if (await daemonIsRunning(config.control.path)) {
    return {error: `A daemon (or another process) is using ${config.control.path}; stop it before recovering — recover is for cleaning up after a crash.`}
  }

  const state = await readState(config.statePath)
  const deadGuardianState = await stateNamesDeadGuardian(state, probeUnixListener)
  const orphans = liveProcesses(state)

  if (!force) return {archived: false, cleared: false, deadGuardianState, forced: false, orphans, remaining: []}

  /** @type {OrphanProcess[]} */
  const remaining = []

  for (const orphan of orphans) {
    const stopped = await stopGroup(orphan.pid, config.proxy.forceStopTimeoutMs)

    if (!stopped) remaining.push(orphan)
  }

  // Keep the state file while any orphan survives so the operator can still find and retry it.
  if (remaining.length > 0) {
    return {archived: false, cleared: false, deadGuardianState, forced: true, orphans, remaining}
  }

  // With every orphan gone, a conclusively dead guardian identity is the documented dead-end
  // case: archive the state under a timestamped evidence name (bytes preserved verbatim) and
  // move the dead socket metadata aside, so the next deploy can boot a fresh generation.
  // See the TensorBuzz production runbook docs/production-rollbridge-recovery.md.
  if (deadGuardianState) {
    const archivePath = deadGuardianArchivePath(config.statePath)
    const guardianSocketPath = stateGuardianIdentity(state)?.socketPath

    if (guardianSocketPath !== undefined) {
      try {
        await fs.rename(guardianSocketPath, `${guardianSocketPath}.dead-guardian-${archiveStamp()}`)
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
      }
    }

    await fs.rename(config.statePath, archivePath)

    return {archived: true, archivePath, cleared: false, deadGuardianState, forced: true, orphans, remaining: []}
  }

  await clearState(config.statePath)

  return {archived: false, cleared: true, deadGuardianState, forced: true, orphans, remaining: []}
}

/**
 * @param {string} socketPath - Control socket path.
 * @returns {Promise<boolean>} True when a process is live on the socket (or it can't be probed).
 */
async function daemonIsRunning(socketPath) {
  try {
    return (await inspectControlSocket(socketPath)).alive
  } catch {
    // Can't tell — be conservative and refuse to stop processes.
    return true
  }
}

/**
 * Stops a detached process group: SIGTERM, then SIGKILL if it outlives the timeout.
 * @param {number} pid - Process-group leader pid (the detached spawn's pid).
 * @param {number} timeoutMs - Grace period before SIGKILL.
 * @returns {Promise<boolean>} True once the process is gone; false if it is still alive afterward (for example owned by another user, so it can't be signaled).
 */
async function stopProcessGroup(pid, timeoutMs) {
  const term = sendSignal(pid, "SIGTERM")

  if (term === "gone") return true
  if (term === "denied") return false

  if (await waitForExit(pid, timeoutMs)) return true

  const kill = sendSignal(pid, "SIGKILL")

  if (kill === "gone") return true
  if (kill === "denied") return false

  return waitForExit(pid, KILL_CONFIRM_TIMEOUT_MS)
}

/**
 * Polls until the pid is no longer alive or the timeout elapses.
 * @param {number} pid - Process pid to watch.
 * @param {number} timeoutMs - How long to wait for it to exit.
 * @returns {Promise<boolean>} True once the process is gone, false if it is still alive at the deadline.
 */
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return !isProcessAlive(pid)
}

/**
 * Sends a signal to a detached process group, classifying the outcome.
 * @param {number} pid - Process-group leader pid.
 * @param {"SIGTERM" | "SIGKILL"} signal - Signal to send to the group.
 * @returns {"denied" | "gone" | "sent"} `gone` when the group no longer exists (ESRCH), `denied` when it can't be signaled (for example EPERM), otherwise `sent`.
 */
function sendSignal(pid, signal) {
  try {
    process.kill(-pid, signal)

    return "sent"
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return "gone"

    // EPERM (owned by another user) or anything else: we could not deliver the signal.
    return "denied"
  }
}

/**
 * @param {JsonValue} state - Persisted state.
 * @returns {{pid?: number, socketPath: string} | undefined} The persisted guardian identity when present and shaped as expected.
 */
function stateGuardianIdentity(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined

  const recovery = /** @type {Record<string, JsonValue>} */ (state).recovery

  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return undefined

  const guardian = /** @type {Record<string, JsonValue>} */ (recovery).guardian

  if (!guardian || typeof guardian !== "object" || Array.isArray(guardian)) return undefined

  const socketPath = /** @type {Record<string, JsonValue>} */ (guardian).socketPath

  if (typeof socketPath !== "string" || socketPath === "") return undefined

  const pid = /** @type {Record<string, JsonValue>} */ (guardian).pid

  return {pid: typeof pid === "number" ? pid : undefined, socketPath}
}

/**
 * Whether the state conclusively names a dead guardian: its recorded pid is gone (when present)
 * and nothing is listening on its Unix socket. Any ambiguity returns false so only a conclusive
 * proof may archive the state.
 * @param {JsonValue} state - Persisted state.
 * @param {(socketPath: string) => Promise<boolean | undefined>} probeUnixListener - Listener probe.
 * @returns {Promise<boolean>} True only on a conclusive dead-guardian proof.
 */
async function stateNamesDeadGuardian(state, probeUnixListener) {
  const guardian = stateGuardianIdentity(state)

  if (!guardian) return false
  if (guardian.pid !== undefined && isProcessAlive(guardian.pid)) return false

  return (await probeUnixListener(guardian.socketPath)) === false
}

/**
 * Probes whether anything is listening on a Unix socket path.
 * @param {string} socketPath - Socket path.
 * @returns {Promise<boolean | undefined>} True when a listener accepted the connection, false when conclusively nothing listens (refused or missing), undefined when the probe was inconclusive.
 */
function probeUnixListenerAt(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath)
    let settled = false

    /** @param {boolean | undefined} result - Probe result. */
    const finish = (result) => {
      if (settled) return

      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    const timer = setTimeout(() => finish(undefined), 1000)

    socket.once("connect", () => finish(true))
    socket.once("error", (error) => {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined

      finish(code === "ECONNREFUSED" || code === "ENOENT" ? false : undefined)
    })
  })
}

/**
 * @returns {string} A UTC archive stamp in the established evidence-name shape (for example 20261013T1102Z).
 */
function archiveStamp() {
  return `${new Date().toISOString().slice(0, 16).replace(/[-:]/g, "")}Z`
}

/**
 * @param {string} statePath - State file path.
 * @returns {string} Timestamped archive path preserving the state bytes as evidence.
 */
function deadGuardianArchivePath(statePath) {
  const stamp = archiveStamp()
  const suffix = statePath.endsWith(".json") ? ".json" : ""

  return `${statePath.slice(0, statePath.length - suffix.length)}.dead-guardian-${stamp}${suffix}`
}
