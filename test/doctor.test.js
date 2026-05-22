// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"
import {runEnvironmentChecks} from "../src/doctor.js"
import {runCli} from "../src/cli.js"

/**
 * @param {object} args - Options.
 * @param {string} args.controlPath - Control socket path.
 * @param {number} args.proxyPort - Proxy port.
 * @returns {import("../src/config.js").RollbridgeConfig} Normalized config.
 */
function buildConfig({controlPath, proxyPort}) {
  return normalizeConfig({
    application: "doctor-test",
    control: {path: controlPath},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: proxyPort}
  })
}

/**
 * @returns {Promise<number>} A port that was free when probed.
 */
async function freePort() {
  return await new Promise((resolve) => {
    const server = net.createServer()

    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = address && typeof address === "object" ? address.port : 0

      server.close(() => resolve(port))
    })
  })
}

/**
 * @returns {Promise<{port: number, server: import("node:net").Server}>} An occupied port and its server.
 */
async function occupyPort() {
  const server = net.createServer()
  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()

      resolve(address && typeof address === "object" ? address.port : 0)
    })
  })

  return {port, server}
}

/**
 * @param {DoctorCheck[]} checks - Checks.
 * @param {string} name - Check name.
 * @returns {DoctorCheck} The matching check.
 * @typedef {import("../src/doctor.js").DoctorCheck} DoctorCheck
 */
function checkNamed(checks, name) {
  const check = checks.find((candidate) => candidate.name === name)

  assert.ok(check, `expected a "${name}" check`)

  return check
}

test("runEnvironmentChecks passes when no daemon runs, the port is free, and the directory is writable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))

  try {
    const checks = await runEnvironmentChecks(buildConfig({controlPath: path.join(root, "rollbridge.sock"), proxyPort: await freePort()}))

    assert.equal(checkNamed(checks, "control socket").ok, true)
    assert.equal(checkNamed(checks, "control socket directory").ok, true)
    assert.equal(checkNamed(checks, "proxy port").ok, true)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runEnvironmentChecks reports an unavailable proxy port", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const {port, server} = await occupyPort()

  try {
    const checks = await runEnvironmentChecks(buildConfig({controlPath: path.join(root, "rollbridge.sock"), proxyPort: port}))
    const proxyCheck = checkNamed(checks, "proxy port")

    assert.equal(proxyCheck.ok, false)
    assert.match(proxyCheck.detail, /unavailable/)
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runEnvironmentChecks reports a missing control socket directory", async () => {
  const checks = await runEnvironmentChecks(buildConfig({controlPath: "/rollbridge-doctor-missing-dir/rollbridge.sock", proxyPort: await freePort()}))
  const directoryCheck = checkNamed(checks, "control socket directory")

  assert.equal(directoryCheck.ok, false)
  assert.match(directoryCheck.detail, /missing or not writable/)
})

test("runEnvironmentChecks fails when a Rollbridge daemon already holds the socket and port", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const config = buildConfig({controlPath: path.join(root, "rollbridge.sock"), proxyPort: await freePort()})
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  try {
    const checks = await runEnvironmentChecks(config)
    const socketCheck = checkNamed(checks, "control socket")

    // A daemon already running means `rollbridge daemon` would fail to bind, so doctor must fail too.
    assert.equal(socketCheck.ok, false)
    assert.match(socketCheck.detail, /a Rollbridge daemon for "doctor-test" is already running/)
    assert.equal(checkNamed(checks, "proxy port").ok, false)
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

/**
 * Runs the CLI while capturing console output.
 * @param {string[]} argv - Process argv.
 * @returns {Promise<string>} Captured stdout and stderr lines.
 */
async function captureCli(argv) {
  const originalLog = console.log
  const originalError = console.error
  /** @type {string[]} */
  const lines = []
  const collect = (/** @type {string[]} */ ...args) => { lines.push(args.map((arg) => String(arg)).join(" ")) }

  console.log = collect
  console.error = collect

  try {
    await runCli(argv)
  } finally {
    console.log = originalLog
    console.error = originalError
  }

  return lines.join("\n")
}

test("doctor CLI passes for a valid, bindable config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const rawConfig = {
    application: "doctor-cli-test",
    control: {path: path.join(root, "rollbridge.sock")},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: await freePort()}
  }

  await fs.writeFile(path.join(root, "rollbridge.js"), `module.exports = ${JSON.stringify(rawConfig)}\n`)

  try {
    const output = await captureCli(["node", "rollbridge", "doctor", "-c", path.join(root, "rollbridge.js")])

    assert.match(output, /All checks passed\./)
    assert.notEqual(process.exitCode, 1)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("doctor CLI fails and exits non-zero for an invalid config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))

  await fs.writeFile(path.join(root, "rollbridge.js"), "module.exports = {application: \"x\", proxy: {port: 8182}, processes: []}\n")

  try {
    const output = await captureCli(["node", "rollbridge", "doctor", "-c", path.join(root, "rollbridge.js")])

    assert.equal(process.exitCode, 1)
    assert.match(output, /✗ config:/)
  } finally {
    process.exitCode = 0
    await fs.rm(root, {force: true, recursive: true})
  }
})
