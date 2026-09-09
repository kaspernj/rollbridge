// @ts-check

import {spawn} from "node:child_process"
import {once} from "node:events"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import {describe, expect, test} from "@velocious/testing"
import {fileURLToPath} from "node:url"
import {normalizeConfig} from "../src/config.js"
import {sendControlCommand} from "../src/control-client.js"
import RollbridgeDaemon from "../src/daemon.js"
import {isProcessAlive, readState} from "../src/state-store.js"

describe("shutdown-completion", () => {

const dummyAppPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "dummy-app.js")

test("shutdown response waits for endpoint and owned-process cleanup before immediate replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-shutdown-completion-"))
  const socketPath = path.join(root, "control.sock")
  const unrelatedSocketPath = path.join(root, "unrelated.sock")
  const gatePath = path.join(root, "shutdown.fifo")
  const stoppingPath = path.join(root, "stopping")
  const gate = spawn("mkfifo", [gatePath])

  expect((await once(gate, "exit"))[0]).toBe(0)

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
  let idleTarget = /** @type {net.Socket | undefined} */ (undefined)
  let idleUnrelated = /** @type {net.Socket | undefined} */ (undefined)
  let replacement
  let gateReleased = false

  try {
    await daemon.start()
    await unrelated.start()
    idleTarget = net.createConnection(socketPath)
    idleUnrelated = net.createConnection(unrelatedSocketPath)
    await Promise.all([once(idleTarget, "connect"), once(idleUnrelated, "connect")])
    await daemon.deploy({releaseId: "v1", releasePath: root, revision: "v1"})

    const workerPid = daemon.activeRelease?.getProcess("worker")?.pid

    expect(typeof workerPid).toBe("number")

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
    const idleTargetClosedDuringStop = idleTarget.destroyed
    const idleUnrelatedClosedDuringStop = idleUnrelated.destroyed

    // Ensure the RED path cannot leave an idle client handle blocking test cleanup.
    idleTarget.destroy()

    await fs.writeFile(gatePath, "continue\n")
    gateReleased = true

    const response = await shutdown

    expect(shutdownResolved).toBe(true)
    // Shutdown must not acknowledge while an owned process is still stopping.
    expect(resolvedDuringStop).toBe(false)
    // The targeted endpoint must stop accepting new commands before cleanup.
    expect(oldEndpointAccepted).toBe(false)
    // The fixture must hold shutdown while its owned process is alive.
    expect(processAliveDuringStop).toBe(true)
    // An idle accepted client must be closed when the targeted endpoint retires.
    expect(idleTargetClosedDuringStop).toBe(true)
    // An unrelated daemon's accepted clients must remain untouched.
    expect(idleUnrelatedClosedDuringStop).toBe(false)
    expect(response).toEqual({message: "shutdown", status: "success"})
    await expect(fs.stat(socketPath)).rejects.toMatchObject({code: "ENOENT"})
    expect(isProcessAlive(/** @type {number} */ (workerPid))).toBe(false)

    // A different daemon remains reachable; shutdown is scoped to the targeted control endpoint.
    expect((await sendControlCommand({command: {command: "status"}, path: unrelatedSocketPath})).application).toBe("shutdown-unrelated")

    // Replacement starts immediately, with no polling or retry between truthful ACK and bind.
    replacement = new RollbridgeDaemon({config, logger: () => {}})
    await replacement.start()
    expect((await sendControlCommand({command: {command: "status"}, path: socketPath})).application).toBe("shutdown-target")
  } finally {
    if (!gateReleased) {
      await fs.writeFile(gatePath, "continue\n").catch(() => {})
    }
    idleTarget?.destroy()
    idleUnrelated?.destroy()
    if (replacement) await replacement.shutdown()
    await daemon.shutdown()
    await unrelated.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("shutdown keeps daemon services alive until release-owned dependents stop", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-shutdown-service-order-"))
  const socketPath = path.join(root, "control.sock")
  const processCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`
  const config = buildConfig(socketPath, {
    companion: {command: processCommand, gracefulStopMs: "indefinite", id: "worker", policy: "companion"},
    service: {command: processCommand, id: "coordinator", policy: "service"}
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})
  /** @type {() => void} */
  let releaseWorker = () => {}
  const workerGate = new Promise((resolve) => { releaseWorker = () => resolve(undefined) })
  let serviceStopStarted = false

  try {
    await daemon.start()
    await daemon.deploy({releaseId: "v1", releasePath: root, revision: "v1"})

    const release = daemon.activeRelease
    const coordinator = daemon.services.get("coordinator")

    if (!release) throw new Error("Missing required fixture: release")
    if (!coordinator) throw new Error("Missing required fixture: coordinator")

    const originalReleaseStop = release.stop.bind(release)
    const originalCoordinatorStop = coordinator.stop.bind(coordinator)
    let signalReleaseStopStarted = () => {}
    const releaseStopStarted = new Promise((resolve) => { signalReleaseStopStarted = () => resolve(undefined) })

    release.stop = async () => {
      signalReleaseStopStarted()
      await workerGate
      await originalReleaseStop()
    }
    coordinator.stop = async () => {
      serviceStopStarted = true
      await originalCoordinatorStop()
    }

    const shutdown = daemon.shutdown()

    await releaseStopStarted
    const serviceStoppedWhileWorkerWasDraining = serviceStopStarted
    releaseWorker()
    await shutdown

    // A worker must retain access to daemon services throughout its drain.
    expect(serviceStoppedWhileWorkerWasDraining).toBe(false)
  } finally {
    releaseWorker()
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("external-owner retirement releases listeners before a long-draining companion exits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-retirement-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const gatePath = path.join(root, "retire.fifo")
  const stoppingPath = path.join(root, "stopping")
  const gate = spawn("mkfifo", [gatePath])
  expect((await once(gate, "exit"))[0]).toBe(0)
  const config = buildConfig(socketPath, {companion: {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    id: "worker",
    lifecycle: {drainCommand: `read released < ${JSON.stringify(gatePath)}`, drainTimeoutMs: 60000, quietCommand: `printf stopping > ${JSON.stringify(stoppingPath)}`},
    policy: "companion"
  }})
  const daemon = new RollbridgeDaemon({config, logger: () => {}})
  let replacement

  try {
    await daemon.start()
    await daemon.deploy({releaseId: "old", releasePath: root, revision: "old"})
    const retirement = sendControlCommand({command: {attestation: `sha256:${"a".repeat(64)}`, command: "retire-owner"}, path: socketPath})
    const response = await retirement
    expect(response).toEqual({message: "owner retired", status: "success"})
    // Old worker must stop accepting work before listener takeover.
    expect(await fs.readFile(stoppingPath, "utf8")).toBe("stopping")

    replacement = new RollbridgeDaemon({config, logger: () => {}})
    await replacement.start({reportOrphans: false})
    expect((await sendControlCommand({command: {command: "status"}, path: socketPath})).application).toBe("shutdown-target")
    // Intentional retired companions are not replacement orphans.
    expect(replacement.status().orphans).toEqual([])
    expect(daemon.status().releases[0].processes[0].state).toBe("quiesced")
  } finally {
    await fs.writeFile(gatePath, "done\n").catch(() => {})
    if (replacement) await replacement.shutdown()
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("a retired owner cannot clear replacement state during late shutdown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-retired-owner-state-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const statePath = path.join(root, "state.json")
  const config = normalizeConfig({...rawConfig(socketPath), statePath})
  const retired = new RollbridgeDaemon({config, logger: () => {}})
  let replacement

  try {
    await retired.start()
    await retired.deploy({releaseId: "retired", releasePath: root, revision: "retired"})
    if (retired.pendingWrite) await retired.pendingWrite
    await retired.retireOwner({attestation: `sha256:${"a".repeat(64)}`})

    replacement = new RollbridgeDaemon({config, logger: () => {}})
    await replacement.start({reportOrphans: false})
    await replacement.deploy({releaseId: "replacement", releasePath: root, revision: "replacement"})
    if (replacement.pendingWrite) await replacement.pendingWrite

    const replacementState = /** @type {{activeReleaseId: string} | undefined} */ (await readState(statePath))

    expect(replacementState?.activeReleaseId).toBe("replacement")

    await retired.shutdown()

    const stateAfterRetiredShutdown = /** @type {{activeReleaseId: string} | undefined} */ (await readState(statePath))

    // Late shutdown of the retired owner must preserve replacement state.
    expect(stateAfterRetiredShutdown?.activeReleaseId).toBe("replacement")
  } finally {
    if (replacement) await replacement.shutdown()
    await retired.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("control socket unlink failure is reported only after owned cleanup completes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-shutdown-unlink-failure-"))
  const socketPath = path.join(root, "control.sock")
  const statePath = path.join(root, "state.json")
  const config = normalizeConfig({...rawConfig(socketPath), statePath})
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  try {
    await daemon.start()
    await daemon.deploy({releaseId: "v1", releasePath: root, revision: "v1"})
    if (daemon.pendingWrite) await daemon.pendingWrite

    const webPid = daemon.activeRelease?.getProcess("web")?.pid
    const proxyPort = daemon.getProxyPort()

    expect(typeof webPid).toBe("number")
    expect(typeof proxyPort).toBe("number")

    daemon.removeControlSocket = async () => { throw new Error("injected unlink failure") }

    await expect(sendControlCommand({command: {command: "shutdown"}, path: socketPath})).rejects.toThrow(/control socket unlink failed: injected unlink failure/)

    // Unlink failure must not strand an owned process.
    expect(isProcessAlive(/** @type {number} */ (webPid))).toBe(false)
    await expect(fetch(`http://127.0.0.1:${proxyPort}/ping`)).rejects.toThrow()
    await expect(fs.stat(statePath)).rejects.toMatchObject({code: "ENOENT"})
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("direct shutdown closes idle accepted clients and converges", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-direct-shutdown-idle-"))
  const socketPath = path.join(root, "control.sock")
  const daemon = new RollbridgeDaemon({config: buildConfig(socketPath), logger: () => {}})
  let idle = /** @type {net.Socket | undefined} */ (undefined)

  try {
    await daemon.start()
    idle = net.createConnection(socketPath)
    await once(idle, "connect")
    const idleClosed = once(idle, "close")

    await daemon.shutdown()
    await idleClosed

    expect(idle.destroyed).toBe(true)
    await expect(fs.stat(socketPath)).rejects.toMatchObject({code: "ENOENT"})
  } finally {
    idle?.destroy()
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

    await expect(sendControlCommand({command: {command: "shutdown"}, path: socketPath})).rejects.toThrow(/directory|EISDIR/i)
    await expect(fs.stat(socketPath)).rejects.toMatchObject({code: "ENOENT"})
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

    if (!release) throw new Error("Missing required fixture: release")
    const originalStop = release.stop.bind(release)

    restoreStop = originalStop
    release.stop = async () => { throw new Error("owned release stop failed") }

    await expect(sendControlCommand({command: {command: "shutdown"}, path: socketPath})).rejects.toThrow(/Shutdown failed to stop 1 owned resource/)
  } finally {
    if (restoreStop) await restoreStop()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("shutdown of an already-stopped endpoint fails explicitly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-shutdown-missing-"))
  const socketPath = path.join(root, "missing.sock")

  try {
    await expect(sendControlCommand({command: {command: "shutdown"}, path: socketPath})).rejects.toMatchObject({code: "ENOENT"})
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

/**
 * @param {string} socketPath - Control socket path.
 * @param {{companion?: Record<string, import("../src/json.js").JsonValue>, service?: Record<string, import("../src/json.js").JsonValue>}} [options] - Optional dependent processes.
 * @returns {import("../src/config.js").RollbridgeConfig} Normalized config.
 */
function buildConfig(socketPath, {companion, service} = {}) {
  return normalizeConfig({
    ...rawConfig(socketPath),
    ...((companion || service) ? {processes: [...(service ? [service] : []), ...(companion ? [companion] : []), ...rawConfig(socketPath).processes]} : {})
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
})
