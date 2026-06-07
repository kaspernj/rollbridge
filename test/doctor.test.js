// @ts-check

import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {once} from "node:events"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"
import {runEnvironmentChecks, runReleaseChecks} from "../src/doctor.js"
import {writeState} from "../src/state-store.js"
import {runCli} from "../src/cli.js"

/**
 * @param {object} args - Options.
 * @param {string} args.controlPath - Control socket path.
 * @param {number} args.proxyPort - Proxy port.
 * @param {string} [args.statePath] - State file path.
 * @returns {import("../src/config.js").RollbridgeConfig} Normalized config.
 */
function buildConfig({controlPath, proxyPort, statePath}) {
  return normalizeConfig({
    application: "doctor-test",
    control: {path: controlPath},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: proxyPort},
    ...(statePath ? {statePath} : {})
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

test("runEnvironmentChecks checks the state path directory and reports no orphans when none exist", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))

  try {
    const checks = await runEnvironmentChecks(buildConfig({controlPath: path.join(root, "rollbridge.sock"), proxyPort: await freePort(), statePath: path.join(root, "state.json")}))

    assert.equal(checkNamed(checks, "state path directory").ok, true)
    assert.equal(checkNamed(checks, "orphaned processes").ok, true)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runEnvironmentChecks omits state checks when no statePath is configured", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))

  try {
    const checks = await runEnvironmentChecks(buildConfig({controlPath: path.join(root, "rollbridge.sock"), proxyPort: await freePort()}))

    assert.ok(!checks.some((check) => check.name === "state path directory"))
    assert.ok(!checks.some((check) => check.name === "orphaned processes"))
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runEnvironmentChecks does not flag orphans while a daemon is running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const statePath = path.join(root, "state.json")
  const config = buildConfig({controlPath: path.join(root, "rollbridge.sock"), proxyPort: await freePort(), statePath})
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  try {
    const checks = await runEnvironmentChecks(config)
    const orphanCheck = checkNamed(checks, "orphaned processes")

    // A running daemon's persisted pids are its own managed processes, not orphans.
    assert.equal(orphanCheck.ok, true)
    assert.match(orphanCheck.detail, /a daemon is running/)
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runEnvironmentChecks reports orphaned processes left in the state file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const statePath = path.join(root, "state.json")
  const leftover = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"})

  await once(leftover, "spawn")

  try {
    await writeState(statePath, {
      activeReleaseId: "v1",
      releases: [{processes: [{id: "worker", pid: leftover.pid}], releaseId: "v1"}],
      services: [],
      singletons: []
    })

    const checks = await runEnvironmentChecks(buildConfig({controlPath: path.join(root, "rollbridge.sock"), proxyPort: await freePort(), statePath}))
    const orphanCheck = checkNamed(checks, "orphaned processes")

    assert.equal(orphanCheck.ok, false)
    assert.match(orphanCheck.detail, new RegExp(`worker \\(pid ${leftover.pid}\\)`))
  } finally {
    leftover.kill("SIGKILL")
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runEnvironmentChecks reports a missing control socket directory", async () => {
  const checks = await runEnvironmentChecks(buildConfig({controlPath: "/rollbridge-doctor-missing-dir/rollbridge.sock", proxyPort: await freePort()}))
  const directoryCheck = checkNamed(checks, "control socket directory")

  assert.equal(directoryCheck.ok, false)
  assert.match(directoryCheck.detail, /missing or not writable/)
})

test("runEnvironmentChecks passes when the running Rollbridge daemon holds the socket and port", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const config = buildConfig({controlPath: path.join(root, "rollbridge.sock"), proxyPort: await freePort()})
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  try {
    const checks = await runEnvironmentChecks(config)
    const socketCheck = checkNamed(checks, "control socket")

    assert.equal(socketCheck.ok, true)
    assert.match(socketCheck.detail, /Rollbridge daemon for "doctor-test" is running/)
    assert.equal(checkNamed(checks, "proxy port").ok, true)
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runEnvironmentChecks fails when the running daemon does not own the configured proxy port", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const config = buildConfig({controlPath: path.join(root, "rollbridge.sock"), proxyPort: await freePort()})
  const changedConfigPort = await freePort()
  const changedConfig = buildConfig({controlPath: config.control.path, proxyPort: changedConfigPort})
  const server = net.createServer()
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()
  await new Promise((resolve) => server.listen(changedConfigPort, "127.0.0.1", () => resolve(undefined)))

  try {
    const checks = await runEnvironmentChecks(changedConfig)

    assert.equal(checkNamed(checks, "control socket").ok, true)
    assert.equal(checkNamed(checks, "proxy port").ok, false)
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

/**
 * @param {object} args - Options.
 * @param {string} args.root - Temp root directory (holds the control socket).
 * @param {import("../src/json.js").JsonValue[]} args.processes - Process definitions to validate.
 * @returns {import("../src/config.js").RollbridgeConfig} Normalized config.
 */
function releaseConfig({processes, root}) {
  return normalizeConfig({
    application: "doctor-release-test",
    control: {path: path.join(root, "rollbridge.sock")},
    processes,
    proxy: {host: "127.0.0.1", port: 8182}
  })
}

test("runReleaseChecks passes for an existing release with resolvable templates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const releasePath = path.join(root, "release")

  await fs.mkdir(path.join(releasePath, "backend"), {recursive: true})

  try {
    const config = releaseConfig({processes: [{command: "run web --port {{port}} --release {{releaseId}}", cwd: "{{releasePath}}/backend", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}], root})
    const checks = await runReleaseChecks(config, {releasePath})

    assert.equal(checkNamed(checks, "release path").ok, true)
    assert.equal(checkNamed(checks, "process templates").ok, true)
    assert.equal(checkNamed(checks, "process working directories").ok, true)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runReleaseChecks flags a command that references an undefined template variable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const releasePath = path.join(root, "release")

  await fs.mkdir(releasePath, {recursive: true})

  try {
    const config = releaseConfig({processes: [{command: "run web --secret {{missingVar}}", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}], root})
    const templates = checkNamed(await runReleaseChecks(config, {releasePath}), "process templates")

    assert.equal(templates.ok, false)
    assert.match(templates.detail, /web:.*missingVar/)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runReleaseChecks reports a missing process working directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const releasePath = path.join(root, "release")

  // The release directory exists, but the process's rendered cwd subdirectory does not.
  await fs.mkdir(releasePath, {recursive: true})

  try {
    const config = releaseConfig({processes: [{command: "run web", cwd: "{{releasePath}}/backend", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}], root})
    const checks = await runReleaseChecks(config, {releasePath})

    assert.equal(checkNamed(checks, "release path").ok, true)

    const directories = checkNamed(checks, "process working directories")

    assert.equal(directories.ok, false)
    assert.match(directories.detail, /web .*backend/)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runReleaseChecks reports a missing release path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))

  try {
    const config = releaseConfig({processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}], root})
    const checks = await runReleaseChecks(config, {releasePath: path.join(root, "does-not-exist")})

    assert.equal(checkNamed(checks, "release path").ok, false)
  } finally {
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

test("doctor --json emits structured checks", async () => {
  const okRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const okConfig = {
    application: "doctor-json-test",
    control: {path: path.join(okRoot, "rollbridge.sock")},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: await freePort()}
  }

  await fs.writeFile(path.join(okRoot, "rollbridge.js"), `module.exports = ${JSON.stringify(okConfig)}\n`)

  const badRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))

  await fs.writeFile(path.join(badRoot, "rollbridge.js"), "module.exports = {application: \"x\", proxy: {port: 8182}, processes: []}\n")

  try {
    const passing = JSON.parse(await captureCli(["node", "rollbridge", "doctor", "--json", "-c", path.join(okRoot, "rollbridge.js")]))

    assert.equal(passing.ok, true)
    assert.ok(passing.checks.some((/** @type {{name: string, ok: boolean}} */ check) => check.name === "proxy port" && check.ok === true))
    assert.notEqual(process.exitCode, 1)

    const failing = JSON.parse(await captureCli(["node", "rollbridge", "doctor", "--json", "-c", path.join(badRoot, "rollbridge.js")]))

    assert.equal(failing.ok, false)
    assert.ok(failing.checks.some((/** @type {{name: string, ok: boolean}} */ check) => check.name === "config" && check.ok === false))
    assert.equal(process.exitCode, 1)
  } finally {
    process.exitCode = 0
    await fs.rm(okRoot, {force: true, recursive: true})
    await fs.rm(badRoot, {force: true, recursive: true})
  }
})

test("doctor --release-path adds release checks, passing or failing on the working directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-doctor-"))
  const releasePath = path.join(root, "release")

  await fs.mkdir(path.join(releasePath, "backend"), {recursive: true})

  const rawConfig = {
    application: "doctor-release-cli",
    control: {path: path.join(root, "rollbridge.sock")},
    processes: [{command: "run web --port {{port}}", cwd: "{{releasePath}}/backend", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: await freePort()}
  }

  await fs.writeFile(path.join(root, "rollbridge.js"), `module.exports = ${JSON.stringify(rawConfig)}\n`)

  try {
    const passing = await captureCli(["node", "rollbridge", "doctor", "-c", path.join(root, "rollbridge.js"), "--release-path", releasePath])

    assert.match(passing, /✓ release path:/)
    assert.match(passing, /✓ process templates:/)
    assert.match(passing, /✓ process working directories:/)
    assert.match(passing, /All checks passed\./)
    assert.notEqual(process.exitCode, 1)

    // A release without the rendered backend directory fails the working-directories check.
    const emptyRelease = path.join(root, "empty-release")

    await fs.mkdir(emptyRelease, {recursive: true})

    const failing = await captureCli(["node", "rollbridge", "doctor", "-c", path.join(root, "rollbridge.js"), "--release-path", emptyRelease])

    assert.match(failing, /✗ process working directories:/)
    assert.equal(process.exitCode, 1)
  } finally {
    process.exitCode = 0
    await fs.rm(root, {force: true, recursive: true})
  }
})
