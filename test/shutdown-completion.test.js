// @ts-check

import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {once} from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import {normalizeConfig} from "../src/config.js"
import {sendControlCommand} from "../src/control-client.js"
import RollbridgeDaemon from "../src/daemon.js"
import {isProcessAlive} from "../src/state-store.js"

const dummyAppPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "dummy-app.js")

test("shutdown response waits for endpoint and owned-process cleanup before immediate replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-shutdown-completion-"))
  const socketPath = path.join(root, "control.sock")
  const unrelatedSocketPath = path.join(root, "unrelated.sock")
  const gatePath = path.join(root, "shutdown.fifo")
  const stoppingPath = path.join(root, "stopping")
  const gate = spawn("mkfifo", [gatePath])

  assert.equal((await once(gate, "exit"))[0], 0)

  const config = buildConfig(socketPath, {
    companion: {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      id: "worker",
      lifecycle: {drainTimeoutMs: 0, quietCommand: `printf stopping > ${JSON.stringify(stoppingPath)}; read released < ${JSON.stringify(gatePath)}`},
      policy: "companion"
    }
  })
  const unrelatedConfig = buildConfig(unrelatedSocketPath)
  const daemon = new RollbridgeDaemon({config, logger: () => {}})
  const unrelated = new RollbridgeDaemon({config: unrelatedConfig, logger: () => {}})
  let replacement
  let gateReleased = false

  try {
    await daemon.start()
    await unrelated.start()
    await daemon.deploy({releaseId: "v1", releasePath: root, revision: "v1"})

    const workerPid = daemon.activeRelease?.getProcess("worker")?.pid

    assert.equal(typeof workerPid, "number")

    const stopping = waitForFile(stoppingPath)
    let shutdownResolved = false
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: socketPath})
      .then((response) => {
        shutdownResolved = true
        return response
      })

    await stopping

    let oldEndpointAccepted = true

    try {
      await sendControlCommand({command: {command: "status"}, path: socketPath})
    } catch {
      oldEndpointAccepted = false
    }

    const resolvedDuringStop = shutdownResolved
    const processAliveDuringStop = isProcessAlive(/** @type {number} */ (workerPid))

    await fs.writeFile(gatePath, "continue\n")
    gateReleased = true

    const response = await shutdown

    assert.equal(shutdownResolved, true)
    assert.equal(resolvedDuringStop, false, "shutdown must not acknowledge while an owned process is still stopping")
    assert.equal(oldEndpointAccepted, false, "the targeted endpoint must stop accepting new commands before cleanup")
    assert.equal(processAliveDuringStop, true, "the fixture must hold shutdown while its owned process is alive")
    assert.deepEqual(response, {message: "shutdown", status: "success"})
    await assert.rejects(() => fs.stat(socketPath), {code: "ENOENT"})
    assert.equal(isProcessAlive(/** @type {number} */ (workerPid)), false)

    // A different daemon remains reachable; shutdown is scoped to the targeted control endpoint.
    assert.equal((await sendControlCommand({command: {command: "status"}, path: unrelatedSocketPath})).application, "shutdown-unrelated")

    // Replacement starts immediately, with no polling or retry between truthful ACK and bind.
    replacement = new RollbridgeDaemon({config, logger: () => {}})
    await replacement.start()
    assert.equal((await sendControlCommand({command: {command: "status"}, path: socketPath})).application, "shutdown-target")
  } finally {
    if (!gateReleased) {
      await fs.writeFile(gatePath, "continue\n").catch(() => {})
    }
    if (replacement) await replacement.shutdown()
    await daemon.shutdown()
    await unrelated.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("shutdown reports cleanup failure and still retires the targeted endpoint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-shutdown-failure-"))
  const socketPath = path.join(root, "control.sock")
  const statePath = path.join(root, "state-directory")

  await fs.mkdir(statePath)

  const config = normalizeConfig({
    ...rawConfig(socketPath),
    statePath
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  try {
    await daemon.start()

    await assert.rejects(
      () => sendControlCommand({command: {command: "shutdown"}, path: socketPath}),
      /directory|EISDIR/i
    )
    await assert.rejects(() => fs.stat(socketPath), {code: "ENOENT"})
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("shutdown does not turn an owned-resource stop rejection into success", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-shutdown-stop-failure-"))
  const socketPath = path.join(root, "control.sock")
  const config = buildConfig(socketPath)
  const daemon = new RollbridgeDaemon({config, logger: () => {}})
  let restoreStop

  try {
    await daemon.start()
    await daemon.deploy({releaseId: "v1", releasePath: root, revision: "v1"})

    const release = daemon.activeRelease

    assert.ok(release)
    const originalStop = release.stop.bind(release)

    restoreStop = originalStop
    release.stop = async () => { throw new Error("owned release stop failed") }

    await assert.rejects(
      () => sendControlCommand({command: {command: "shutdown"}, path: socketPath}),
      /Shutdown failed to stop 1 owned resource/
    )
  } finally {
    if (restoreStop) await restoreStop()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("shutdown of an already-stopped endpoint fails explicitly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-shutdown-missing-"))
  const socketPath = path.join(root, "missing.sock")

  try {
    await assert.rejects(
      () => sendControlCommand({command: {command: "shutdown"}, path: socketPath}),
      (error) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    )
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

/**
 * @param {string} socketPath - Control socket path.
 * @param {{companion?: Record<string, import("../src/json.js").JsonValue>}} [options] - Optional companion process.
 * @returns {import("../src/config.js").RollbridgeConfig} Normalized config.
 */
function buildConfig(socketPath, {companion} = {}) {
  return normalizeConfig({
    ...rawConfig(socketPath),
    ...(companion ? {processes: [companion, ...rawConfig(socketPath).processes]} : {})
  })
}

/**
 * @param {string} socketPath - Control socket path.
 * @returns {{application: string, control: {path: string}, processes: Record<string, import("../src/json.js").JsonValue>[], proxy: {forceStopTimeoutMs: number, host: string, port: number}}} Raw config.
 */
function rawConfig(socketPath) {
  return {
    application: socketPath.endsWith("unrelated.sock") ? "shutdown-unrelated" : "shutdown-target",
    control: {path: socketPath},
    processes: [{
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`,
      health: {intervalMs: 25, path: "/ping", timeoutMs: 3000},
      id: "web",
      policy: "proxied",
      port: {from: 0, to: 0}
    }],
    proxy: {forceStopTimeoutMs: 1000, host: "127.0.0.1", port: 0}
  }
}

/**
 * @param {string} filePath - File to await without polling.
 * @returns {Promise<void>} Resolves when the file appears.
 */
async function waitForFile(filePath) {
  const watcher = fs.watch(path.dirname(filePath))

  try {
    for await (const event of watcher) {
      if (event.filename === path.basename(filePath)) return
    }
  } finally {
    await watcher.return?.()
  }

  throw new Error(`Watcher ended before ${filePath} appeared`)
}
