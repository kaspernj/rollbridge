// @ts-check

import fs from "node:fs/promises"

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 */

/**
 * Atomically writes a daemon state snapshot to a file (write to a temp file, then rename),
 * so a reader never sees a partially written file.
 * @param {string} path - State file path.
 * @param {JsonValue} state - State snapshot to persist.
 * @returns {Promise<void>} Resolves once written.
 */
export async function writeState(path, state) {
  const tempPath = `${path}.${process.pid}.tmp`

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
