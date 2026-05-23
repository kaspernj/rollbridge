// @ts-check

import {inspectControlSocket} from "./daemon.js"
import {clearState, isProcessAlive, liveProcesses, readState} from "./state-store.js"

/**
 * @typedef {{id: string, pid: number, releaseId: string | null}} OrphanProcess
 * @typedef {{error: string} | {orphans: OrphanProcess[], stopped: boolean}} RecoverResult
 */

/**
 * Cleans up orphaned managed processes left by a crashed daemon. Reads the persisted state
 * (config.statePath) and finds managed processes whose pids are still alive. By default it
 * only reports them; with `force` it stops each one's process group (SIGTERM, then SIGKILL
 * after the configured timeout) and clears the stale state file.
 *
 * Refuses to run while a daemon (or another process) holds the control socket — those pids
 * belong to a live daemon, not a crash. A recycled pid can be a false positive, so review the
 * dry-run list before using `force`.
 * @param {object} args - Options.
 * @param {import("./config.js").RollbridgeConfig} args.config - Normalized config.
 * @param {boolean} args.force - Whether to actually stop the orphans (otherwise list them).
 * @returns {Promise<RecoverResult>} The orphans found and whether they were stopped, or an error.
 */
export async function recoverOrphans({config, force}) {
  if (config.statePath === undefined) {
    return {error: "No statePath is configured; set statePath in the config to enable recovery."}
  }

  if (await daemonIsRunning(config.control.path)) {
    return {error: `A daemon (or another process) is using ${config.control.path}; stop it before recovering — recover is for cleaning up after a crash.`}
  }

  const orphans = liveProcesses(await readState(config.statePath))

  if (!force) return {orphans, stopped: false}

  for (const orphan of orphans) {
    await stopProcessGroup(orphan.pid, config.proxy.forceStopTimeoutMs)
  }

  await clearState(config.statePath)

  return {orphans, stopped: true}
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
 * @returns {Promise<void>} Resolves once stopped (or already gone).
 */
async function stopProcessGroup(pid, timeoutMs) {
  if (!signalGroup(pid, "SIGTERM")) return

  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  signalGroup(pid, "SIGKILL")
}

/**
 * @param {number} pid - Process-group leader pid.
 * @param {"SIGTERM" | "SIGKILL"} signal - Signal to send to the group.
 * @returns {boolean} True when the signal was delivered.
 */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)

    return true
  } catch {
    // ESRCH: already gone. EPERM: owned by another user — can't stop it.
    return false
  }
}
