// @ts-check

import fs from "node:fs"

const logPath = requiredEnv("ROLLBRIDGE_SINGLETON_LOG")
const releaseId = process.env.ROLLBRIDGE_RELEASE_ID || "unknown"

writeEvent("start")

process.on("SIGTERM", () => {
  writeEvent("stop")
  setTimeout(() => process.exit(0), 50)
})

setInterval(() => {}, 1000)

/**
 * @param {"start" | "stop"} event - Event.
 * @returns {void}
 */
function writeEvent(event) {
  fs.appendFileSync(logPath, `${JSON.stringify({event, pid: process.pid, releaseId})}\n`)
}

/**
 * @param {string} key - Environment variable name.
 * @returns {string} Environment variable value.
 */
function requiredEnv(key) {
  const value = process.env[key]

  if (!value) throw new Error(`${key} is required`)

  return value
}
