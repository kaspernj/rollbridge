// @ts-check

import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import {waitForHealth} from "../src/health.js"

/**
 * Starts a health server that records when it first receives a probe.
 * @returns {Promise<{firstProbeDelay: () => number, port: number, close: () => Promise<void>}>} Server handle.
 */
async function startHealthServer() {
  const start = Date.now()
  let firstProbeAt = 0
  const server = http.createServer((request, response) => {
    if (firstProbeAt === 0) firstProbeAt = Date.now()

    response.writeHead(200, {"Content-Type": "text/plain"})
    response.end("ok")
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)))

  const address = server.address()

  return {
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
    firstProbeDelay: () => firstProbeAt - start,
    port: address && typeof address === "object" ? address.port : 0
  }
}

test("waitForHealth delays the first probe by startDelayMs", async () => {
  const server = await startHealthServer()

  try {
    await waitForHealth({
      health: {intervalMs: 25, path: "/ping", startDelayMs: 200, timeoutMs: 2000},
      host: "127.0.0.1",
      port: server.port
    })

    assert.ok(server.firstProbeDelay() >= 180, `expected first probe to be delayed ~200ms, was ${server.firstProbeDelay()}ms`)
  } finally {
    await server.close()
  }
})

test("waitForHealth probes immediately when startDelayMs is 0", async () => {
  const server = await startHealthServer()

  try {
    await waitForHealth({
      health: {intervalMs: 25, path: "/ping", startDelayMs: 0, timeoutMs: 2000},
      host: "127.0.0.1",
      port: server.port
    })

    assert.ok(server.firstProbeDelay() < 150, `expected an immediate first probe, was ${server.firstProbeDelay()}ms`)
  } finally {
    await server.close()
  }
})
