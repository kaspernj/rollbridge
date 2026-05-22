// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test, {after, before} from "node:test"
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"
import {sendControlCommand} from "../src/control-client.js"

let root = ""
let socketPath = ""
let daemon = /** @type {RollbridgeDaemon | undefined} */ (undefined)

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-control-"))
  socketPath = path.join(root, "rollbridge.sock")

  const config = normalizeConfig({
    application: "rollbridge-control-test",
    control: {path: socketPath},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0}
  })

  daemon = new RollbridgeDaemon({config, logger: () => {}})
  await daemon.start()
})

after(async () => {
  if (daemon) await daemon.shutdown()
  await fs.rm(root, {force: true, recursive: true})
})

/**
 * Writes a single raw line to the control socket and returns the parsed response.
 * @param {string} rawLine - Exact line to send (no trailing newline).
 * @returns {Promise<Record<string, import("../src/json.js").JsonValue>>} Parsed response.
 */
async function sendRawControlLine(rawLine) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ""

    socket.setEncoding("utf8")
    socket.once("error", reject)
    socket.on("data", (chunk) => {
      buffer += chunk

      const newlineIndex = buffer.indexOf("\n")

      if (newlineIndex < 0) return

      socket.end()
      resolve(JSON.parse(buffer.slice(0, newlineIndex)))
    })
    socket.once("connect", () => socket.write(`${rawLine}\n`))
  })
}

test("malformed JSON returns an error response without crashing the daemon", async () => {
  const response = await sendRawControlLine("this is not json")

  assert.equal(response.status, "error")
  assert.match(String(response.error), /JSON/)

  // The daemon stays up and still answers valid commands afterwards.
  const status = await sendControlCommand({command: {command: "status"}, path: socketPath})

  assert.equal(status.application, "rollbridge-control-test")
})

test("non-object JSON is rejected as an invalid control command", async () => {
  const response = await sendRawControlLine("123")

  assert.equal(response.status, "error")
  assert.equal(response.error, "Control command must be an object")
})

test("an unknown control command returns a clear error", async () => {
  const response = await sendRawControlLine(JSON.stringify({command: "bogus"}))

  assert.equal(response.status, "error")
  assert.equal(response.error, "Unknown command: bogus")
})

test("a known command missing a required field returns a field error", async () => {
  const response = await sendRawControlLine(JSON.stringify({command: "deploy"}))

  assert.equal(response.status, "error")
  assert.equal(response.error, "releasePath is required")
})
