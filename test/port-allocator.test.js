// @ts-check

import assert from "node:assert/strict"
import net from "node:net"
import test from "node:test"
import {findAvailablePort} from "../src/port-allocator.js"

const host = "127.0.0.1"

/**
 * Binds a server to an ephemeral port so that port is occupied for the test.
 * @returns {Promise<{port: number, server: import("node:net").Server}>} Occupied port and its server.
 */
async function occupyPort() {
  const server = net.createServer()
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, host, () => {
      const address = server.address()

      resolve(address && typeof address === "object" ? address.port : 0)
    })
  })

  return {port, server}
}

/**
 * @param {import("node:net").Server} server - Server to close.
 * @returns {Promise<void>} Resolves once closed.
 */
async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve(undefined)))
}

test("findAvailablePort reports reserved and in-use counts when a range is exhausted", async () => {
  const {port, server} = await occupyPort()
  // Use the occupied port as the upper bound so the range stays within valid TCP bounds.
  const reservedPort = port - 1
  const range = {from: reservedPort, to: port}

  try {
    await assert.rejects(
      () => findAvailablePort({host, range, usedPorts: new Set([reservedPort])}),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, new RegExp(`No available ports in range ${reservedPort}-${port}`))
        assert.match(error.message, /2 ports on 127\.0\.0\.1/)
        assert.match(error.message, /1 reserved by this deploy/)
        assert.match(error.message, /1 already in use/)

        return true
      }
    )
  } finally {
    await closeServer(server)
  }
})

test("findAvailablePort skips the occupied port and records the allocated one", async () => {
  const {port, server} = await occupyPort()
  const usedPorts = /** @type {Set<number>} */ (new Set())
  // Keep the upper bound at or below 65535 while still including the occupied port.
  const from = Math.min(port, 65515)
  const to = from + 20

  try {
    const allocated = await findAvailablePort({host, range: {from, to}, usedPorts})

    assert.notEqual(allocated, port)
    assert.ok(allocated >= from && allocated <= to)
    assert.ok(usedPorts.has(allocated))
  } finally {
    await closeServer(server)
  }
})
