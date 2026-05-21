// @ts-check

import crypto from "node:crypto"
import http from "node:http"

const port = Number(process.env.ROLLBRIDGE_PORT)
const releaseId = process.env.ROLLBRIDGE_RELEASE_ID || "unknown"
const healthFails = releaseId.includes("bad")
const sockets = new Set()

const server = http.createServer((request, response) => {
  if (request.url === "/ping") {
    if (healthFails) {
      response.writeHead(500, {"Content-Type": "application/json"})
      response.end(JSON.stringify({message: "bad release"}))
      return
    }

    response.writeHead(200, {"Content-Type": "application/json"})
    response.end(JSON.stringify({message: "Pong", releaseId}))
    return
  }

  if (request.url === "/release") {
    response.writeHead(200, {"Content-Type": "text/plain; charset=utf-8"})
    response.end(`${releaseId}\n`)
    return
  }

  response.writeHead(404, {"Content-Type": "text/plain; charset=utf-8"})
  response.end("Not found\n")
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

process.on("SIGTERM", () => {
  server.close(() => process.exit(0))

  if (sockets.size === 0) {
    setTimeout(() => process.exit(0), 10)
  }
})

server.listen(port, "127.0.0.1")
