// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"
import {sendControlCommand} from "../src/control-client.js"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const dummyAppPath = path.join(currentDir, "fixtures", "dummy-app.js")
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

test("singleton processes restart without overlap during deploy", async () => {
  const fixture = await createFixture({includeSingleton: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await waitFor(async () => (await singletonEvents(fixture.singletonLogPath)).some((event) => event.event === "start" && event.releaseId === "v1"))

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    await waitFor(async () => {
      const events = await singletonEvents(fixture.singletonLogPath)

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

/**
 * @param {{includeSingleton?: boolean}} [options] - Fixture options.
 * @returns {Promise<{config: import("../src/config.js").RollbridgeConfig, root: string, singletonLogPath: string}>} Fixture data.
 */
async function createFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const singletonLogPath = path.join(root, "singleton.log")
  /** @type {Array<Record<string, import("../src/json.js").JsonValue>>} */
  const processes = [
    {
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`,
      health: {
        intervalMs: 50,
        path: "/ping",
        timeoutMs: 3000
      },
      id: "web",
      policy: "proxied",
      port: {from: 0, to: 0}
    }
  ]

  if (options.includeSingleton) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(singletonAppPath)}`,
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
      host: "127.0.0.1",
      port: 0
    }
  })

  return {config, root, singletonLogPath}
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
  const response = await fetch(`http://127.0.0.1:${daemon.getProxyPort()}${pathName}`)

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
async function singletonEvents(logPath) {
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
