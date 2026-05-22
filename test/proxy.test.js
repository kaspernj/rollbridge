// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const dummyAppPath = path.join(currentDir, "fixtures", "dummy-app.js")

/**
 * @param {string} root - Fixture root used for the control socket.
 * @param {number} restartDelayMs - Delay before a crashed process is restarted.
 * @returns {import("../src/config.js").RollbridgeConfig} Normalized config with one proxied web process.
 */
function buildConfig(root, restartDelayMs) {
  return normalizeConfig({
    application: "rollbridge-proxy-test",
    control: {path: path.join(root, "rollbridge.sock")},
    processes: [
      {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`,
        health: {intervalMs: 50, path: "/ping", timeoutMs: 3000},
        id: "web",
        policy: "proxied",
        port: {from: 0, to: 0},
        restartDelayMs
      }
    ],
    proxy: {drainTimeoutMs: 1000, forceStopTimeoutMs: 500, healthPath: "/ping", healthTimeoutMs: 3000, host: "127.0.0.1", port: 0}
  })
}

/**
 * @param {RollbridgeDaemon} daemon - Daemon.
 * @param {string} pathName - Request path.
 * @returns {Promise<Response>} Proxy response.
 */
async function proxyFetch(daemon, pathName) {
  return await fetch(`http://127.0.0.1:${daemon.getProxyPort()}${pathName}`)
}

/**
 * @param {RollbridgeDaemon} daemon - Daemon.
 * @param {string} releaseId - Active release id.
 * @returns {number} The web process pid reported by status.
 */
function webPid(daemon, releaseId) {
  const release = daemon.status().releases.find((candidate) => candidate.releaseId === releaseId)

  assert.ok(release, `Release ${releaseId} should be present`)

  const web = release.processes.find((candidate) => candidate.id === "web")

  assert.ok(web && typeof web.pid === "number", "web process should report a pid")

  return web.pid
}

/**
 * @param {() => Promise<boolean> | boolean} callback - Probe.
 * @returns {Promise<void>} Resolves once the probe returns true.
 */
async function waitFor(callback) {
  const deadline = Date.now() + 3000

  while (Date.now() < deadline) {
    if (await callback()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error("Timed out waiting for condition")
}

test("proxy returns 502 while the active release web process is down", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-proxy-"))
  const daemon = new RollbridgeDaemon({config: buildConfig(root, 60000), logger: () => {}})

  await daemon.start()

  try {
    await daemon.deploy({releaseId: "v1", releasePath: root, revision: "v1"})
    assert.equal((await proxyFetch(daemon, "/release")).status, 200)

    // Kill the web process group so the active release exits unexpectedly; restart is held off for 60s.
    process.kill(-webPid(daemon, "v1"), "SIGKILL")

    let lastStatus = 0

    await waitFor(async () => {
      lastStatus = (await proxyFetch(daemon, "/release")).status

      return lastStatus === 502
    })

    assert.equal(lastStatus, 502)
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("proxy recovers once the crashed web process restarts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-proxy-"))
  const daemon = new RollbridgeDaemon({config: buildConfig(root, 100), logger: () => {}})

  await daemon.start()

  try {
    await daemon.deploy({releaseId: "v1", releasePath: root, revision: "v1"})
    assert.equal((await proxyFetch(daemon, "/release")).status, 200)

    process.kill(-webPid(daemon, "v1"), "SIGKILL")

    // After the crash the process restarts on the same port and the proxy serves traffic again.
    await waitFor(async () => (await proxyFetch(daemon, "/release")).status === 200)
    assert.equal((await proxyFetch(daemon, "/release")).status, 200)
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})
