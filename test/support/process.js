// @ts-check

import fs from "node:fs"

/**
 * Reports whether an exact fixture process can still run. Linux keeps exited children in
 * procfs until they are reaped, so kill(2) alone cannot distinguish a zombie from a live process.
 * @param {number} pid - Exact fixture process PID.
 * @returns {boolean} Whether the process can still run.
 */
export function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false
    throw error
  }

  if (process.platform !== "linux") return true

  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]

    return state !== "Z" && state !== "X"
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

/**
 * @param {number} pid - Exact fixture process PID.
 * @param {number} [timeoutMs] - Bounded exit wait.
 */
export async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs

  while (isProcessRunning(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  if (isProcessRunning(pid)) throw new Error(`Timed out waiting for process ${pid} to exit`)
}
