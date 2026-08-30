// @ts-check

import fs from "node:fs/promises"
import net from "node:net"

const [socketPath, backendPath, mode = "partial"] = process.argv.slice(2)

if (!socketPath || !backendPath || !process.send) throw new Error("partial process-guardian requires frontend and backend sockets plus a private bootstrap channel")

const token = await new Promise((resolve, reject) => {
  process.once("disconnect", () => reject(new Error("Partial guardian bootstrap channel closed before authentication capability arrived")))
  process.once("message", (message) => {
    if (!message || typeof message !== "object" || !("token" in message) || typeof message.token !== "string" || !message.token) {
      reject(new Error("Partial guardian bootstrap authentication capability is invalid"))
      return
    }
    resolve(message.token)
  })
})

const clients = new Set()
const server = net.createServer((frontend) => {
  const backend = net.createConnection(backendPath)
  let frontendBuffer = ""
  let backendBuffer = ""

  clients.add(frontend)
  frontend.setEncoding("utf8")
  backend.setEncoding("utf8")
  frontend.on("error", () => frontend.destroy())
  backend.on("error", () => backend.destroy())
  frontend.once("close", () => {
    clients.delete(frontend)
    backend.destroy()
  })
  backend.once("close", () => frontend.destroy())
  frontend.on("data", (chunk) => {
    frontendBuffer += chunk
    let newline = frontendBuffer.indexOf("\n")

    while (newline >= 0) {
      const line = frontendBuffer.slice(0, newline)
      const request = JSON.parse(line)

      frontendBuffer = frontendBuffer.slice(newline + 1)
      if (request.token !== token) {
        frontend.write(`${JSON.stringify({error: "Guardian authentication failed", id: request.id})}\n`)
      } else if (request.command === "owner-replacement-capabilities") {
        const result = mode === "malformed-capability"
          ? {protocol: "owner-replacement", version: 1}
          : undefined

        frontend.write(`${JSON.stringify(result
          ? {id: request.id, result}
          : {error: "Guardian owner-replacement-capabilities requires a process key", id: request.id})}\n`)
      } else if (request.command === "commit-retired-owner-replacement") {
        frontend.write(`${JSON.stringify({
          error: request.key
            ? "Guardian commit-retired-owner-replacement requires the committed owner"
            : "Guardian commit-retired-owner-replacement requires a process key",
          id: request.id
        })}\n`)
      } else {
        if (mode === "wrong-provenance" && request.command === "register") {
          request.provenance = `${request.provenance}-tampered`
          backend.write(`${JSON.stringify(request)}\n`)
        } else {
          backend.write(`${line}\n`)
        }
      }
      newline = frontendBuffer.indexOf("\n")
    }
  })
  backend.on("data", (chunk) => {
    backendBuffer += chunk
    let newline = backendBuffer.indexOf("\n")

    while (newline >= 0) {
      const line = backendBuffer.slice(0, newline)

      backendBuffer = backendBuffer.slice(newline + 1)
      frontend.write(`${line}\n`)
      newline = backendBuffer.indexOf("\n")
    }
  })
})

server.on("error", (error) => {
  if (process.send) process.send({error: error.message})
  else throw error
})
server.listen(socketPath, async () => {
  await fs.chmod(socketPath, 0o600)
  process.send?.({ready: true})
  process.disconnect?.()
})

const shutdown = () => {
  for (const client of clients) client.destroy()
  server.close(() => {
    void fs.rm(socketPath, {force: true}).finally(() => process.exit(0))
  })
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
