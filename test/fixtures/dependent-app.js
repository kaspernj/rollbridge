// @ts-check

import http from "node:http"
import crypto from "node:crypto"

const port = Number(requiredEnv("ROLLBRIDGE_PORT"))
const servicePort = Number(requiredEnv("ROLLBRIDGE_BEACON_PORT"))
const releaseId = process.env.ROLLBRIDGE_RELEASE_ID || "unknown"
const sockets = new Set()

await waitForService()

const server = http.createServer((request, response) => {
  if (request.url === "/ping") {
    response.writeHead(200, {"Content-Type": "application/json"})
    response.end(JSON.stringify({message: "Pong", releaseId}))
    return
  }

  response.writeHead(200, {"Content-Type": "text/plain; charset=utf-8"})
  response.end(`${releaseId}\n`)
})

process.on("SIGTERM", () => {
  server.close(() => process.exit(0))

  if (sockets.size === 0) {
    setTimeout(() => process.exit(0), 10)
  }
})

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"]

  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
    return
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64")

  sockets.add(socket)
  socket.once("close", () => sockets.delete(socket))
  socket.on("data", () => {
    socket.end()
  })
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"))
})

server.listen(port, "127.0.0.1")

/** @returns {Promise<void>} Resolves when the service responds. */
async function waitForService() {
  const deadline = Date.now() + 3000

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${servicePort}/ping`)

      if (response.ok) return
    } catch (_error) {
      // The dependency may still be binding its port.
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error("Service did not become ready")
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
