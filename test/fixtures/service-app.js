// @ts-check

import fs from "node:fs"
import http from "node:http"
import path from "node:path"

const logPath = requiredEnv("ROLLBRIDGE_SERVICE_LOG")
const port = Number(requiredEnv("ROLLBRIDGE_PORT"))
const releaseId = process.env.ROLLBRIDGE_RELEASE_ID || "unknown"
const bindGatePath = process.env.ROLLBRIDGE_SERVICE_BIND_GATE
const bindWaitingPath = process.env.ROLLBRIDGE_SERVICE_BIND_WAITING
/** @type {fs.FSWatcher | undefined} */
let bindWatcher

writeEvent("start")

const server = http.createServer((_request, response) => {
  response.writeHead(200, {"Content-Type": "application/json"})
  response.end(JSON.stringify({releaseId}))
})

process.on("SIGTERM", () => {
  writeEvent("stop")
  bindWatcher?.close()
  if (server.listening) server.close(() => process.exit(0))
  else process.exit(0)
})

listenWhenReleased()

/** Starts listening immediately or after the release-local test gate opens. */
function listenWhenReleased() {
  if (!bindGatePath) {
    server.listen(port, "127.0.0.1")
    return
  }

  let bindStarted = false
  const bind = () => {
    if (bindStarted || !fs.existsSync(bindGatePath)) return
    bindStarted = true
    bindWatcher?.close()
    bindWatcher = undefined
    server.listen(port, "127.0.0.1")
  }

  bindWatcher = fs.watch(path.dirname(bindGatePath), (_event, filename) => {
    if (filename === path.basename(bindGatePath)) bind()
  })
  if (fs.existsSync(bindGatePath)) bind()
  else if (bindWaitingPath) fs.writeFileSync(bindWaitingPath, `${process.pid}\n`)
}

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
