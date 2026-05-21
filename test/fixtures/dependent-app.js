// @ts-check

import http from "node:http"

const port = Number(requiredEnv("ROLLBRIDGE_PORT"))
const servicePort = Number(requiredEnv("ROLLBRIDGE_BEACON_PORT"))
const releaseId = process.env.ROLLBRIDGE_RELEASE_ID || "unknown"

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
