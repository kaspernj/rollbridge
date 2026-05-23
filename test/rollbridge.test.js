// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"
import {sendControlCommand} from "../src/control-client.js"
import {runCli} from "../src/cli.js"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const binPath = path.join(currentDir, "..", "bin", "rollbridge")
const dependentAppPath = path.join(currentDir, "fixtures", "dependent-app.js")
const dummyAppPath = path.join(currentDir, "fixtures", "dummy-app.js")
const serviceAppPath = path.join(currentDir, "fixtures", "service-app.js")
const singletonAppPath = path.join(currentDir, "fixtures", "singleton-app.js")

test("deploy switches new HTTP traffic while old WebSockets drain", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    assert.equal(await fetchText(daemon, "/release"), "v1")

    const websocket = await openWebSocket(daemon)

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    assert.equal(await fetchText(daemon, "/release"), "v2")

    const drainingRelease = statusRelease(daemon, "v1")
    assert.equal(drainingRelease.state, "draining")
    assert.equal(drainingRelease.connections.websocket, 1)

    websocket.close()
    await waitFor(async () => statusRelease(daemon, "v1").state === "stopped")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("failed health check leaves the previous release active", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "good", releasePath: fixture.root, revision: "good"})

    await assert.rejects(
      () => daemon.deploy({releaseId: "bad", releasePath: fixture.root, revision: "bad"}),
      /Health check failed/
    )

    assert.equal(await fetchText(daemon, "/release"), "good")
    assert.equal(daemon.status().activeReleaseId, "good")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("wildcard proxy bind host targets release processes through loopback", async () => {
  const fixture = await createFixture({proxyHost: "0.0.0.0"})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const status = daemon.status()
    const release = statusRelease(daemon, "v1")

    assert.ok(daemon.activeRelease, "expected active release")
    assert.equal(status.proxy.host, "0.0.0.0")
    assert.equal(status.proxy.upstreamHost, "127.0.0.1")
    assert.equal(daemon.activeRelease.proxyTarget().target, `http://127.0.0.1:${release.ports.web}`)
    assert.equal(await fetchText(daemon, "/release"), "v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("failed release startup logs process output before cleanup", async () => {
  const fixture = await createFixture({webCommand: `${JSON.stringify(process.execPath)} -e "console.log('startup stdout'); console.error('startup stderr'); const http = require('node:http'); http.createServer((_request, response) => { response.writeHead(500); response.end('bad') }).listen(Number(process.env.ROLLBRIDGE_PORT), '127.0.0.1')"`, webHealthTimeoutMs: 500})
  /** @type {Array<{data?: Record<string, import("../src/json.js").JsonValue>, message: string}>} */
  const logs = []
  const daemon = new RollbridgeDaemon({
    config: fixture.config,
    logger: (message, data = {}) => logs.push({data, message})
  })

  await daemon.start()

  try {
    await assert.rejects(
      () => daemon.deploy({releaseId: "bad", releasePath: fixture.root, revision: "bad"}),
      /Health check failed/
    )

    const processStatusLog = logs.find((entry) => entry.message === "release startup process status" && entry.data?.processId === "web")

    assert.ok(processStatusLog, "expected failed web process diagnostics to be logged")
    assert.ok(processStatusLog.data, "expected diagnostic data")
    assert.ok(Array.isArray(processStatusLog.data.logs), "expected retained process output in diagnostics")
    assert.ok(processStatusLog.data.logs.some((entry) => typeof entry === "object" && entry && "line" in entry && entry.line === "startup stdout"))
    assert.ok(processStatusLog.data.logs.some((entry) => typeof entry === "object" && entry && "line" in entry && entry.line === "startup stderr"))
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("singleton processes restart without overlap during deploy", async () => {
  const fixture = await createFixture({includeSingleton: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await waitFor(async () => (await processEvents(fixture.singletonLogPath)).some((event) => event.event === "start" && event.releaseId === "v1"))

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    await waitFor(async () => {
      const events = await processEvents(fixture.singletonLogPath)

      return events.some((event) => event.event === "stop" && event.releaseId === "v1") &&
        events.some((event) => event.event === "start" && event.releaseId === "v2")
    })

    const status = daemon.status()

    assert.equal(status.singletons.length, 1)
    assert.equal(status.singletons[0].process.state, "running")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("a failed singleton replacement surfaces the error after stopping the old singleton", async () => {
  // The singleton's working directory is per-release; only the v1 directory exists, so
  // the v2 replacement cannot spawn (ENOENT on cwd) and its start() rejects.
  const fixture = await createFixture({includeSingleton: true, singletonCwd: "{{releasePath}}/{{releaseId}}"})
  const daemon = await startDaemon(fixture.config)

  await fs.mkdir(path.join(fixture.root, "v1"))

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await waitFor(async () => (await processEvents(fixture.singletonLogPath)).some((event) => event.event === "start" && event.releaseId === "v1"))

    // The new release's singleton fails to start, so the deploy surfaces the error.
    await assert.rejects(() => daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"}))

    // The old singleton is stopped before the new one is started, so two copies never
    // overlap — even when the replacement then fails.
    await waitFor(async () => (await processEvents(fixture.singletonLogPath)).some((event) => event.event === "stop" && event.releaseId === "v1"))

    const status = daemon.status()

    // Traffic switches before singletons are replaced, so the new release is already active,
    // but its singleton is left failed with no replacement running.
    assert.equal(status.activeReleaseId, "v2")
    assert.equal(status.singletons.length, 1)
    assert.equal(status.singletons[0].process.state, "failed")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("service processes start before releases and restart with the latest deploy template", async () => {
  const fixture = await createFixture({includeService: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await waitFor(async () => (await processEvents(fixture.serviceLogPath)).some((event) => event.event === "start" && event.releaseId === "v1"))

    const firstServiceStatus = daemon.status().services[0].process

    assert.ok(firstServiceStatus.pid, "service should have a pid")
    assert.match(firstServiceStatus.command, /v1/)

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    const secondServiceStatus = daemon.status().services[0].process

    assert.equal(secondServiceStatus.pid, firstServiceStatus.pid)
    assert.match(secondServiceStatus.command, /v2/)

    process.kill(-Number(secondServiceStatus.pid), "SIGTERM")
    await waitFor(async () => {
      const events = await processEvents(fixture.serviceLogPath)

      return events.some((event) => event.event === "start" && event.releaseId === "v2")
    })
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("control socket accepts deploy and status commands", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await sendControlCommand({
      command: {
        command: "deploy",
        releaseId: "control-v1",
        releasePath: fixture.root,
        revision: "control-v1"
      },
      path: fixture.config.control.path
    })

    const status = await sendControlCommand({
      command: {command: "status"},
      path: fixture.config.control.path
    })

    assert.equal(status.activeReleaseId, "control-v1")
    assert.equal(await fetchText(daemon, "/release"), "control-v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("starting a second daemon on a live control socket reports the running daemon", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const second = new RollbridgeDaemon({config: fixture.config, logger: () => {}})

    await assert.rejects(
      () => second.prepareControlSocketPath(),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /A Rollbridge daemon for application "rollbridge-test" is already running/)
        assert.match(error.message, /active release: v1/)
        assert.match(error.message, /rollbridge shutdown/)

        return true
      }
    )

    // The original daemon keeps its socket and still answers control commands.
    const status = await sendControlCommand({command: {command: "status"}, path: fixture.config.control.path})
    assert.equal(status.application, "rollbridge-test")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("a control socket held by a non-Rollbridge process reports a generic conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const socketPath = path.join(root, "busy.sock")
  const connections = /** @type {Set<import("node:net").Socket>} */ (new Set())
  const stranger = net.createServer((socket) => {
    // Accept connections but never answer, so the probe falls through to its timeout.
    connections.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => connections.delete(socket))
  })

  await new Promise((resolve) => stranger.listen(socketPath, () => resolve(undefined)))

  const config = normalizeConfig({
    application: "rollbridge-test",
    control: {path: socketPath},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0}
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  try {
    await assert.rejects(
      () => daemon.prepareControlSocketPath(),
      /The control socket .* is already in use by another process/
    )
  } finally {
    for (const socket of connections) socket.destroy()
    await new Promise((resolve) => stranger.close(() => resolve(undefined)))
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("applies the configured control socket permission mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const config = normalizeConfig({
    application: "rollbridge-test",
    control: {mode: "660", path: socketPath},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0}
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  try {
    const stats = await fs.stat(socketPath)

    assert.equal(stats.mode & 0o777, 0o660)
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("deploy can ensure the daemon before sending the release command", async () => {
  const fixture = await createFixture()
  const configPath = await writeConfigFile(fixture.config, fixture.root)
  const logPath = path.join(fixture.root, "daemon.log")
  const pidPath = path.join(fixture.root, "daemon.pid")

  try {
    await runCli([
      "node",
      binPath,
      "deploy",
      "--ensure-daemon",
      "--config",
      configPath,
      "--release-path",
      fixture.root,
      "--release-id",
      "ensured-v1",
      "--daemon-log-path",
      logPath,
      "--daemon-pid-path",
      pidPath
    ])

    const status = await sendControlCommand({
      command: {command: "status"},
      path: fixture.config.control.path
    })

    const proxy = /** @type {{port: number}} */ (status.proxy)

    assert.equal(status.activeReleaseId, "ensured-v1")
    assert.match(await fs.readFile(pidPath, "utf8"), /\d+/)
    assert.equal(await fetchTextFromPort(proxy.port, "/release"), "ensured-v1")
  } finally {
    try {
      await sendControlCommand({
        command: {command: "shutdown"},
        path: fixture.config.control.path
      })
    } catch (_error) {
      // The daemon may have failed before it accepted commands.
    }

    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

/**
 * @param {{includeService?: boolean, includeSingleton?: boolean, proxyHost?: string, singletonCwd?: string, webCommand?: string, webDependsOnService?: boolean, webHealthTimeoutMs?: number}} [options] - Fixture options.
 * @returns {Promise<{config: import("../src/config.js").RollbridgeConfig, root: string, serviceLogPath: string, singletonLogPath: string}>} Fixture data.
 */
async function createFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const serviceLogPath = path.join(root, "service.log")
  const singletonLogPath = path.join(root, "singleton.log")
  /** @type {Array<Record<string, import("../src/json.js").JsonValue>>} */
  const processes = []

  if (options.includeService) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(serviceAppPath)} --release={{releaseId}}`,
      env: {
        ROLLBRIDGE_SERVICE_LOG: serviceLogPath
      },
      id: "beacon",
      policy: "service",
      port: {from: 0, to: 0},
      restartDelayMs: 50
    })
  }

  processes.push({
    command: options.webCommand || (options.webDependsOnService
      ? `${JSON.stringify(process.execPath)} ${JSON.stringify(dependentAppPath)}`
      : `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`),
    health: {
      intervalMs: 50,
      path: "/ping",
      timeoutMs: options.webHealthTimeoutMs || 3000
    },
    id: "web",
    policy: "proxied",
    port: {from: 0, to: 0}
  })

  if (options.includeSingleton) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(singletonAppPath)}`,
      ...(options.singletonCwd ? {cwd: options.singletonCwd} : {}),
      env: {
        ROLLBRIDGE_SINGLETON_LOG: singletonLogPath
      },
      id: "jobs-main",
      policy: "singleton"
    })
  }

  const config = normalizeConfig({
    application: "rollbridge-test",
    control: {
      path: path.join(root, "rollbridge.sock")
    },
    processes,
    proxy: {
      drainTimeoutMs: 1000,
      forceStopTimeoutMs: 500,
      healthPath: "/ping",
      healthTimeoutMs: 3000,
      host: options.proxyHost || "127.0.0.1",
      port: 0
    }
  })

  return {config, root, serviceLogPath, singletonLogPath}
}

/**
 * @param {import("../src/config.js").RollbridgeConfig} config - Config.
 * @returns {Promise<RollbridgeDaemon>} Started daemon.
 */
async function startDaemon(config) {
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  return daemon
}

/**
 * @param {RollbridgeDaemon} daemon - Daemon.
 * @param {string} pathName - Path.
 * @returns {Promise<string>} Response text.
 */
async function fetchText(daemon, pathName) {
  return await fetchTextFromPort(Number(daemon.getProxyPort()), pathName)
}

/**
 * @param {number} port - Port.
 * @param {string} pathName - Path.
 * @returns {Promise<string>} Response text.
 */
async function fetchTextFromPort(port, pathName) {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`)

  assert.equal(response.status, 200)

  return (await response.text()).trim()
}

/**
 * @param {RollbridgeDaemon} daemon - Daemon.
 * @returns {Promise<WebSocket>} Open WebSocket.
 */
async function openWebSocket(daemon) {
  const websocket = new WebSocket(`ws://127.0.0.1:${daemon.getProxyPort()}/socket`)

  await new Promise((resolve, reject) => {
    websocket.addEventListener("open", () => resolve(undefined), {once: true})
    websocket.addEventListener("error", () => reject(new Error("WebSocket open failed")), {once: true})
  })

  return websocket
}

/**
 * @param {RollbridgeDaemon} daemon - Daemon.
 * @param {string} releaseId - Release id.
 * @returns {import("../src/release-group.js").ReleaseStatus} Release status.
 */
function statusRelease(daemon, releaseId) {
  const status = daemon.status()
  const release = status.releases.find((candidate) => candidate.releaseId === releaseId)

  assert.ok(release, `Release ${releaseId} should be present`)

  return release
}

/**
 * @param {string} logPath - Log path.
 * @returns {Promise<Array<{event: string, pid: number, releaseId: string}>>} Events.
 */
async function processEvents(logPath) {
  try {
    const text = await fs.readFile(logPath, "utf8")

    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return []
    }

    throw error
  }
}

/**
 * @param {import("../src/config.js").RollbridgeConfig} config - Config.
 * @param {string} root - Fixture root.
 * @returns {Promise<string>} Written config path.
 */
async function writeConfigFile(config, root) {
  const configPath = path.join(root, "rollbridge.js")

  // CommonJS so the module loads from a temp dir (no package.json) on any supported Node version.
  await fs.writeFile(configPath, `module.exports = ${JSON.stringify(config, null, 2)}\n`)

  return configPath
}

/**
 * @param {() => Promise<boolean> | boolean} callback - Probe callback.
 * @returns {Promise<void>} Resolves when callback returns true.
 */
async function waitFor(callback) {
  const deadline = Date.now() + 3000

  while (Date.now() < deadline) {
    if (await callback()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error("Timed out waiting for condition")
}
