// @ts-check

import fs from "node:fs"

const logPath = process.env.ROLLBRIDGE_SINGLETON_LOG
const releaseId = process.env.ROLLBRIDGE_RELEASE_ID || "unknown"

if (!logPath) throw new Error("ROLLBRIDGE_SINGLETON_LOG is required")

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
