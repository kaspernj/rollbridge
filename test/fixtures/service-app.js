// @ts-check

import fs from "node:fs"
import http from "node:http"

const logPath = requiredEnv("ROLLBRIDGE_SERVICE_LOG")
const port = Number(requiredEnv("ROLLBRIDGE_PORT"))
const releaseId = process.env.ROLLBRIDGE_RELEASE_ID || "unknown"

writeEvent("start")

const server = http.createServer((_request, response) => {
  response.writeHead(200, {"Content-Type": "application/json"})
  response.end(JSON.stringify({releaseId}))
})

process.on("SIGTERM", () => {
  writeEvent("stop")
  server.close(() => process.exit(0))
})

server.listen(port, "127.0.0.1")

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
