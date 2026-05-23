// @ts-check

import {inspectControlSocket} from "./daemon.js"
import {clearState, isProcessAlive, liveProcesses, readState} from "./state-store.js"

// How long to confirm a SIGKILL'd group has actually exited before reporting it un-stoppable.
const KILL_CONFIRM_TIMEOUT_MS = 500

/**
 * @typedef {{id: string, pid: number, releaseId: string | null}} OrphanProcess
 * @typedef {{error: string}} RecoverError
 * @typedef {{cleared: boolean, forced: boolean, orphans: OrphanProcess[], remaining: OrphanProcess[]}} RecoverReport
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
 * @param {(pid: number, timeoutMs: number) => Promise<boolean>} [args.stopGroup] - Stops a process group and resolves to whether it is gone afterward (defaults to the real implementation; injectable for tests).
 * @returns {Promise<RecoverResult>} The orphans found and whether they were stopped, or an error.
 */
export async function recoverOrphans({config, force, stopGroup = stopProcessGroup}) {
  if (config.statePath === undefined) {
    return {error: "No statePath is configured; set statePath in the config to enable recovery."}
  }

  if (await daemonIsRunning(config.control.path)) {
    return {error: `A daemon (or another process) is using ${config.control.path}; stop it before recovering — recover is for cleaning up after a crash.`}
  }

  const orphans = liveProcesses(await readState(config.statePath))

  if (!force) return {cleared: false, forced: false, orphans, remaining: []}

  /** @type {OrphanProcess[]} */
  const remaining = []

  for (const orphan of orphans) {
    const stopped = await stopGroup(orphan.pid, config.proxy.forceStopTimeoutMs)

    if (!stopped) remaining.push(orphan)
  }

  // Only clear the state file once every orphan is confirmed gone; otherwise keep it so the
  // operator can still find and retry the survivors on the next run.
  if (remaining.length === 0) await clearState(config.statePath)

  return {cleared: remaining.length === 0, forced: true, orphans, remaining}
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
