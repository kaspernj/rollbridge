// @ts-check

import fs from "node:fs/promises"

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 */

let tempCounter = 0

/**
 * Atomically writes a daemon state snapshot to a file (write to a unique temp file, then
 * rename), so a reader never sees a partially written file and concurrent writes don't race
 * a shared temp path.
 * @param {string} path - State file path.
 * @param {JsonValue} state - State snapshot to persist.
 * @returns {Promise<void>} Resolves once written.
 */
export async function writeState(path, state) {
  tempCounter += 1

  const tempPath = `${path}.${process.pid}.${tempCounter}.tmp`

  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`)
  await fs.rename(tempPath, path)
}

/**
 * Reads a previously persisted state snapshot.
 * @param {string} path - State file path.
 * @returns {Promise<JsonValue | undefined>} The parsed snapshot, or undefined when missing or unparseable.
 */
export async function readState(path) {
  let contents

  try {
    contents = await fs.readFile(path, "utf8")
  } catch {
    return undefined
  }

  try {
    return JSON.parse(contents)
  } catch {
    return undefined
  }
}

/**
 * Removes a state file, ignoring a missing file.
 * @param {string} path - State file path.
 * @returns {Promise<void>} Resolves once removed.
 */
export async function clearState(path) {
  await fs.rm(path, {force: true})
}

/**
 * @param {number} pid - Process id to probe.
 * @returns {boolean} True when a process with this pid exists (alive).
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    // EPERM means the process exists but is owned by another user — still alive.
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM")
  }
}

/**
 * Finds managed processes recorded in a persisted snapshot whose pids are still alive — the
 * orphans left by a daemon that did not shut down cleanly. Advisory (a recycled pid can be a
 * false positive); returns an empty list for a missing or unexpectedly shaped snapshot.
 * @param {JsonValue | undefined} state - A persisted state snapshot (from {@link readState}).
 * @param {(pid: number) => boolean} [alive] - Process-liveness probe (defaults to {@link isProcessAlive}).
 * @returns {{id: string, pid: number, releaseId: string | null}[]} Live persisted processes.
 */
export function liveProcesses(state, alive = isProcessAlive) {
  if (!state) return []

  const live = /** @type {{id: string, pid: number, releaseId: string | null}[]} */ ([])

  try {
    const snapshot = /** @type {import("./daemon.js").DaemonStatus} */ (state)

    for (const release of snapshot.releases) {
      for (const process of release.processes) {
        if (typeof process.pid === "number" && alive(process.pid)) live.push({id: process.id, pid: process.pid, releaseId: release.releaseId})
      }
    }

    for (const {id, process} of [...snapshot.services, ...snapshot.singletons]) {
      if (typeof process.pid === "number" && alive(process.pid)) live.push({id, pid: process.pid, releaseId: null})
    }
  } catch {
    return []
  }

  return live
}
