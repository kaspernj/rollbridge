// @ts-check

import net from "node:net"
import {describe, expect, test} from "@velocious/testing"
import {findAvailablePort} from "../src/port-allocator.js"

describe("port-allocator", () => {

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
    const allocation = findAvailablePort({host, range, usedPorts: new Set([reservedPort])})

    await expect(allocation).rejects.toBeInstanceOf(Error)
    await expect(allocation).rejects.toMatchObject({message: expect.stringMatching(new RegExp(`No available ports in range ${reservedPort}-${port}`))})
    await expect(allocation).rejects.toMatchObject({message: expect.stringMatching(/2 ports on 127\.0\.0\.1/)})
    await expect(allocation).rejects.toMatchObject({message: expect.stringMatching(/1 reserved by this deploy/)})
    await expect(allocation).rejects.toMatchObject({message: expect.stringMatching(/1 already in use/)})
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

    expect(allocated).not.toBe(port)
    expect(allocated >= from && allocated <= to).toBeTruthy()
    expect(usedPorts.has(allocated)).toBeTruthy()
  } finally {
    await closeServer(server)
  }
})
})
