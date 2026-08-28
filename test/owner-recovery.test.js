// @ts-check

import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {once} from "node:events"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import {sendControlCommand} from "../src/control-client.js"
import RollbridgeDaemon from "../src/daemon.js"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const binPath = path.join(currentDir, "..", "bin", "rollbridge")
const dummyAppPath = path.join(currentDir, "fixtures", "dummy-app.js")
const serviceAppPath = path.join(currentDir, "fixtures", "service-app.js")

/** @typedef {import("../src/daemon.js").DaemonStatus} DaemonStatus */
/** @typedef {DaemonStatus & {recovery: {configDigest: string}}} RecoveryState */

test("replacement owner reconstructs one active and two draining generations after abrupt daemon exit", async () => {
  const fixture = await createFixture()
  let owner = spawnDaemon(fixture.configPath)
  const managedProcessGroups = new Set()

  try {
    await waitForLog(owner, "control socket listening")
    for (const releaseId of ["v1", "v2", "v3"]) {
      const releasePath = path.join(fixture.root, releaseId)

      await fs.mkdir(releasePath)
      const gate = spawn("mkfifo", [path.join(releasePath, "worker.fifo")])
      assert.equal((await once(gate, "exit"))[0], 0)
      await sendControlCommand({command: {command: "deploy", releaseId, releasePath, revision: releaseId}, path: fixture.socketPath})
    }

    const before = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: fixture.socketPath}))

    assert.equal(before.activeReleaseId, "v3")
    assert.deepEqual(before.releaseReferences.map((/** @type {{releaseId: string}} */ reference) => reference.releaseId), ["v1", "v2", "v3"])
    assert.equal(new Set(before.releases.map((release) => release.ports.jobs)).size, 3)
    for (const release of before.releases) {
      for (const processStatus of release.processes) if (processStatus.pid) managedProcessGroups.add(processStatus.pid)
    }
    for (const entry of [...before.services, ...before.singletons]) if (entry.process.pid) managedProcessGroups.add(entry.process.pid)

    owner.kill("SIGKILL")
    await once(owner, "exit")

    owner = spawnDaemon(fixture.configPath)
    await waitForLog(owner, "control socket listening")

    const recovered = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: fixture.socketPath}))

    assert.equal(recovered.activeReleaseId, "v3")
    assert.deepEqual(recovered.releases.map((/** @type {{state: string}} */ release) => release.state), ["draining", "draining", "active"])
    assert.deepEqual(recovered.releaseReferences.map((/** @type {{releaseId: string}} */ reference) => reference.releaseId), ["v1", "v2", "v3"])
    assert.deepEqual(recovered.releases.map((release) => release.ports.jobs), before.releases.map((release) => release.ports.jobs))
    assert.equal(recovered.services[0]?.process.pid, before.services[0]?.process.pid)
    assert.equal(recovered.singletons[0]?.process.pid, before.singletons[0]?.process.pid)

    const v4Path = path.join(fixture.root, "v4")
    await fs.mkdir(v4Path)
    const v4Gate = spawn("mkfifo", [path.join(v4Path, "worker.fifo")])
    assert.equal((await once(v4Gate, "exit"))[0], 0)
    await sendControlCommand({command: {command: "deploy", releaseId: "v4", releasePath: v4Path, revision: "v4"}, path: fixture.socketPath})
    assert.equal((await sendControlCommand({command: {command: "status"}, path: fixture.socketPath})).activeReleaseId, "v4", "new work must progress while old generations remain retained")

    await Promise.all(["v1", "v2"].map((releaseId) => fs.writeFile(path.join(fixture.root, releaseId, "worker.fifo"), "drained\n")))
    const afterDrain = await waitForState(fixture.statePath, (state) => state.releaseReferences?.map((/** @type {{releaseId: string}} */ reference) => reference.releaseId).join(",") === "v3,v4")
    assert.deepEqual(afterDrain.releaseReferences.map((/** @type {{releaseId: string}} */ reference) => reference.releaseId), ["v3", "v4"])

    await fs.writeFile(path.join(fixture.root, "v3", "worker.fifo"), "drained\n")
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: fixture.socketPath})
    await fs.writeFile(path.join(fixture.root, "v4", "worker.fifo"), "drained\n")
    await shutdown
    await once(owner, "exit")
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    for (const pid of managedProcessGroups) {
      try {
        process.kill(-pid, "SIGKILL")
      } catch (_error) {
        // The exact managed process group may already have completed.
      }
    }
    await stopFixtureGuardian(fixture.statePath)
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("owner recovery rejects config identity mismatch without changing the valid snapshot", async () => {
  const fixture = await createFixture()
  let owner = spawnDaemon(fixture.configPath)
  let workerPid

  try {
    await waitForLog(owner, "control socket listening")
    const releasePath = await prepareRelease(fixture.root, "v1")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: fixture.socketPath})
    const status = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: fixture.socketPath}))
    workerPid = status.releases[0]?.processes.find((processStatus) => processStatus.id === "worker")?.pid
    assert.ok(workerPid)
    const validState = await fs.readFile(fixture.statePath, "utf8")

    owner.kill("SIGKILL")
    await once(owner, "exit")
    await writeConfig(fixture.configPath, {...fixture.config, application: "different-authority"})

    const rejected = await runDaemon(fixture.configPath)

    assert.notEqual(rejected.code, 0)
    assert.match(rejected.output, /config identity does not match/)
    assert.equal(await fs.readFile(fixture.statePath, "utf8"), validState)

    await writeConfig(fixture.configPath, fixture.config)
    owner = spawnDaemon(fixture.configPath)
    await waitForLog(owner, "control socket listening")
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: fixture.socketPath})
    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
    await once(owner, "exit")
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    if (workerPid) {
      try { process.kill(-workerPid, "SIGKILL") } catch (_error) { /* The exact group already exited. */ }
    }
    await stopFixtureGuardian(fixture.statePath)
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("failed recovery bootstrap keeps the reconstructed active generation serving", async () => {
  const fixture = await createFixture()
  let owner = spawnDaemon(fixture.configPath)
  let workerPid

  try {
    await waitForLog(owner, "control socket listening")
    const releasePath = await prepareRelease(fixture.root, "v1")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: fixture.socketPath})
    const status = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: fixture.socketPath}))
    workerPid = status.releases[0]?.processes.find((processStatus) => processStatus.id === "worker")?.pid
    assert.ok(workerPid)

    owner.kill("SIGKILL")
    await once(owner, "exit")
    owner = spawnDaemon(fixture.configPath, {releaseId: "bad", releasePath: fixture.root, revision: "bad"})
    await waitForLog(owner, "control socket listening")

    const preserved = await sendControlCommand({command: {command: "status"}, path: fixture.socketPath})
    const events = await sendControlCommand({command: {command: "events"}, path: fixture.socketPath})

    assert.equal(preserved.activeReleaseId, "v1")
    assert.deepEqual(preserved.releaseReferences, [{releaseId: "v1", releasePath}])
    assert.ok(Array.isArray(events.events) && events.events.some((event) => event && typeof event === "object" && "message" in event && event.message === "bootstrap activation failed"))

    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: fixture.socketPath})
    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
    await once(owner, "exit")
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    if (workerPid) {
      try { process.kill(-workerPid, "SIGKILL") } catch (_error) { /* The exact group already exited. */ }
    }
    await stopFixtureGuardian(fixture.statePath)
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("owner recovery fails closed on a partial snapshot and preserves it for repair", async () => {
  const fixture = await createFixture()
  let owner = spawnDaemon(fixture.configPath)
  let workerPid

  try {
    await waitForLog(owner, "control socket listening")
    const releasePath = await prepareRelease(fixture.root, "v1")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: fixture.socketPath})
    const status = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: fixture.socketPath}))
    workerPid = status.releases[0]?.processes.find((processStatus) => processStatus.id === "worker")?.pid
    assert.ok(workerPid)
    const validState = JSON.parse(await fs.readFile(fixture.statePath, "utf8"))

    owner.kill("SIGKILL")
    await once(owner, "exit")
    const partialState = {...validState, releases: []}
    await fs.writeFile(fixture.statePath, `${JSON.stringify(partialState, null, 2)}\n`)

    const rejected = await runDaemon(fixture.configPath)

    assert.notEqual(rejected.code, 0)
    assert.match(rejected.output, /does not contain active release v1/)
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.statePath, "utf8")), partialState)

    await fs.writeFile(fixture.statePath, `${JSON.stringify(validState, null, 2)}\n`)
    owner = spawnDaemon(fixture.configPath)
    await waitForLog(owner, "control socket listening")
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: fixture.socketPath})
    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
    await once(owner, "exit")
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    if (workerPid) {
      try { process.kill(-workerPid, "SIGKILL") } catch (_error) { /* The exact group already exited. */ }
    }
    await stopFixtureGuardian(fixture.statePath)
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("concurrent same-authority replacements converge on one fenced owner", async () => {
  const fixture = await createFixture()
  let owner = spawnDaemon(fixture.configPath)
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let contender
  let workerPid

  try {
    await waitForLog(owner, "control socket listening")
    const releasePath = await prepareRelease(fixture.root, "v1")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: fixture.socketPath})
    const status = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: fixture.socketPath}))
    workerPid = status.releases[0]?.processes.find((processStatus) => processStatus.id === "worker")?.pid
    assert.ok(workerPid)

    owner.kill("SIGKILL")
    await once(owner, "exit")
    owner = spawnDaemon(fixture.configPath)
    const secondContender = spawnDaemon(fixture.configPath)
    contender = secondContender

    const winner = await Promise.any([
      waitForLog(owner, "control socket listening").then(() => owner),
      waitForLog(secondContender, "control socket listening").then(() => secondContender)
    ])
    const loser = winner === owner ? secondContender : owner
    const [loserCode] = loser.exitCode === null && loser.signalCode === null ? await once(loser, "exit") : [loser.exitCode]

    assert.equal(loserCode, 0, "fenced loser must attest the matching winner and exit successfully")
    assert.equal((await sendControlCommand({command: {command: "status"}, path: fixture.socketPath})).activeReleaseId, "v1")

    owner = winner
    contender = undefined
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: fixture.socketPath})
    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
    await once(owner, "exit")
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    if (contender && contender.exitCode === null && contender.signalCode === null) contender.kill("SIGKILL")
    if (workerPid) {
      try { process.kill(-workerPid, "SIGKILL") } catch (_error) { /* The exact group already exited. */ }
    }
    await stopFixtureGuardian(fixture.statePath)
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("fresh guardian identity remains recoverable when proxy startup fails", async () => {
  const fixture = await createFixture()
  const blocker = net.createServer()
  const config = /** @type {import("../src/config.js").RollbridgeConfig} */ (fixture.config)
  /** @type {RollbridgeDaemon | undefined} */
  let failedOwner
  /** @type {RollbridgeDaemon | undefined} */
  let replacement

  try {
    await new Promise((resolve, reject) => blocker.listen(0, "127.0.0.1", () => resolve(undefined)).once("error", reject))
    const address = blocker.address()
    assert.ok(address && typeof address === "object")
    config.proxy.port = address.port
    const startupAttempt = new RollbridgeDaemon({config, logger: () => {}})
    failedOwner = startupAttempt
    await assert.rejects(() => startupAttempt.start(), /EADDRINUSE/)

    const state = JSON.parse(await fs.readFile(fixture.statePath, "utf8"))
    assert.equal(typeof state.recovery?.guardian?.token, "string")
    failedOwner.abandonOwnerRecoveryAttempt()
    await new Promise((resolve) => blocker.close(() => resolve(undefined)))

    replacement = new RollbridgeDaemon({config, logger: () => {}})
    await replacement.start()
    assert.equal(replacement.status().activeReleaseId, null)
    await replacement.shutdown()
  } finally {
    if (blocker.listening) await new Promise((resolve) => blocker.close(() => resolve(undefined)))
    if (!replacement && failedOwner?.guardian) await failedOwner.guardian.shutdown()
    else failedOwner?.guardian?.disconnect()
    replacement?.guardian?.disconnect()
    await stopFixtureGuardian(fixture.statePath)
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("replacement reconstructs retained draining generations without an active release", async () => {
  const fixture = await createFixture()
  const config = /** @type {import("../src/config.js").RollbridgeConfig} */ (fixture.config)
  config.processes = config.processes.filter((processConfig) => processConfig.id !== "beacon" && processConfig.id !== "singleton")
  await writeConfig(fixture.configPath, config)
  let owner = spawnDaemon(fixture.configPath)

  try {
    await waitForLog(owner, "control socket listening")
    const v1Path = await prepareRelease(fixture.root, "v1")
    const v2Path = await prepareRelease(fixture.root, "v2")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath: v1Path, revision: "v1"}, path: fixture.socketPath})
    await sendControlCommand({command: {command: "deploy", releaseId: "v2", releasePath: v2Path, revision: "v2"}, path: fixture.socketPath})

    const stopActive = sendControlCommand({command: {command: "stop", releaseId: "v2"}, path: fixture.socketPath})
    await fs.writeFile(path.join(v2Path, "worker.fifo"), "drained\n")
    await stopActive
    const drainOnly = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: fixture.socketPath}))
    assert.equal(drainOnly.activeReleaseId, null)
    assert.deepEqual(drainOnly.releaseReferences, [{releaseId: "v1", releasePath: v1Path}])

    owner.kill("SIGKILL")
    await once(owner, "exit")
    owner = spawnDaemon(fixture.configPath)
    await waitForLog(owner, "control socket listening")
    const recovered = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: fixture.socketPath}))
    assert.equal(recovered.activeReleaseId, null)
    assert.deepEqual(recovered.releaseReferences, [{releaseId: "v1", releasePath: v1Path}])

    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: fixture.socketPath})
    await fs.writeFile(path.join(v1Path, "worker.fifo"), "drained\n")
    await shutdown
    await once(owner, "exit")
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    await stopFixtureGuardian(fixture.statePath)
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("deploy rejects a live ownerRecovery mode change", async () => {
  const fixture = await createFixture()
  const owner = spawnDaemon(fixture.configPath)
  const releasePath = await prepareRelease(fixture.root, "v1")

  try {
    await waitForLog(owner, "control socket listening")
    const changedConfig = {...fixture.config}
    delete changedConfig.ownerRecovery
    await writeConfig(fixture.configPath, changedConfig)

    await assert.rejects(
      sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: fixture.socketPath}),
      /ownerRecovery.*cannot be applied live/
    )

    await writeConfig(fixture.configPath, fixture.config)
    await sendControlCommand({command: {command: "shutdown"}, path: fixture.socketPath})
    await once(owner, "exit")
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    await stopFixtureGuardian(fixture.statePath)
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("ensure-daemon atomically replaces an incompatible owner without losing retained generations", async () => {
  const fixture = await createFixture()
  const oldControlPath = fixture.socketPath
  const newControlPath = path.join(fixture.root, "rollbridge-v2.sock")
  const runtimePath = path.join(fixture.root, "runtime")
  const daemonLogPath = path.join(fixture.root, "replacement.log")
  const daemonPidPath = path.join(fixture.root, "replacement.pid")
  let owner = spawnDaemon(fixture.configPath)
  const processGroups = new Set()

  try {
    await waitForLog(owner, "control socket listening")
    const v1Path = await prepareRelease(fixture.root, "v1")
    const v2Path = await prepareRelease(fixture.root, "v2")

    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath: v1Path, revision: "v1"}, path: oldControlPath})
    await sendControlCommand({command: {command: "deploy", releaseId: "v2", releasePath: v2Path, revision: "v2"}, path: oldControlPath})
    const before = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: oldControlPath}))

    for (const release of before.releases) for (const processStatus of release.processes) if (processStatus.pid) processGroups.add(processStatus.pid)
    for (const entry of [...before.services, ...before.singletons]) if (entry.process.pid) processGroups.add(entry.process.pid)

    const nextConfig = /** @type {import("../src/config.js").RollbridgeConfig} */ (structuredClone(fixture.config))
    nextConfig.control = {path: newControlPath}
    const companionTemplate = nextConfig.processes.find((processConfig) => processConfig.policy === "companion")

    assert.ok(companionTemplate)
    nextConfig.processes.splice(2, 0, {
      ...structuredClone(companionTemplate),
      id: "new-topology-process",
      lifecycle: {drainTimeoutMs: 0},
      nonBlockingDrain: false
    })
    await writeConfig(fixture.configPath, nextConfig)

    const replacement = await runCli([
      "ensure-daemon", "--config", fixture.configPath,
      "--daemon-log-path", daemonLogPath,
      "--daemon-pid-path", daemonPidPath,
      "--daemon-runtime-path", runtimePath,
      "--daemon-start-timeout-ms", "5000"
    ])
    assert.equal(replacement.code, 0, replacement.output)

    const after = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: newControlPath}))

    assert.equal(after.activeReleaseId, "v2")
    assert.deepEqual(after.releaseReferences, before.releaseReferences)
    assert.deepEqual(after.releases.map((release) => release.processes.map((processStatus) => processStatus.pid)), before.releases.map((release) => release.processes.map((processStatus) => processStatus.pid)))
    assert.equal(after.services[0]?.process.pid, before.services[0]?.process.pid)
    assert.equal(after.singletons[0]?.process.pid, before.singletons[0]?.process.pid)

    const v3Path = await prepareRelease(fixture.root, "v3")
    await sendControlCommand({command: {command: "deploy", releaseId: "v3", releasePath: v3Path, revision: "v3"}, path: newControlPath})
    const deployed = /** @type {DaemonStatus} */ (await sendControlCommand({command: {command: "status"}, path: newControlPath}))

    assert.equal(deployed.activeReleaseId, "v3")
    assert.deepEqual(deployed.releaseReferences.map((reference) => reference.releaseId), ["v1", "v2", "v3"])

    await Promise.all(["v1", "v2"].map((releaseId) => fs.writeFile(path.join(fixture.root, releaseId, "worker.fifo"), "drained\n")))
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: newControlPath})
    await fs.writeFile(path.join(v3Path, "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    for (const pid of processGroups) {
      try { process.kill(-pid, "SIGKILL") } catch (_error) { /* Exact managed group already exited. */ }
    }
    await stopFixtureGuardian(fixture.statePath)
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

/** @returns {Promise<{config: Record<string, import("../src/json.js").JsonValue>, configPath: string, root: string, socketPath: string, statePath: string}>} Fixture paths. */
async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-recovery-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const configPath = path.join(root, "rollbridge.cjs")
  const statePath = path.join(root, "rollbridge.state.json")
  const serviceLogPath = path.join(root, "service.log")
  const config = {
    application: "owner-recovery-test",
    control: {path: socketPath},
    ownerRecovery: {reconnectGraceMs: 250},
    processes: [
      {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(serviceAppPath)}`,
        env: {ROLLBRIDGE_SERVICE_LOG: serviceLogPath},
        id: "beacon",
        policy: "service",
        port: {from: 17100, to: 17120}
      },
      {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(serviceAppPath)}`,
        deployStrategy: "handoff",
        env: {ROLLBRIDGE_SERVICE_LOG: serviceLogPath},
        id: "jobs",
        lifecycle: {quietCommand: "exit 0"},
        policy: "service",
        port: {from: 17000, to: 17020}
      },
      {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
        id: "worker",
        lifecycle: {drainCommand: "read released < \"$ROLLBRIDGE_RELEASE_PATH/worker.fifo\"", drainTimeoutMs: 60000},
        nonBlockingDrain: true,
        policy: "companion"
      },
      {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`,
        health: {intervalMs: 25, path: "/ping", timeoutMs: 3000},
        id: "web",
        policy: "proxied",
        port: {from: 0, to: 0}
      },
      {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
        id: "singleton",
        policy: "singleton"
      }
    ],
    proxy: {drainTimeoutMs: 1000, forceStopTimeoutMs: 500, healthPath: "/ping", healthTimeoutMs: 3000, host: "127.0.0.1", port: 0},
    statePath
  }

  await writeConfig(configPath, config)

  return {config, configPath, root, socketPath, statePath}
}

/**
 * @param {string} root - Fixture root.
 * @param {string} releaseId - Release id.
 * @returns {Promise<string>} Prepared release path.
 */
async function prepareRelease(root, releaseId) {
  const releasePath = path.join(root, releaseId)

  await fs.mkdir(releasePath)
  const gate = spawn("mkfifo", [path.join(releasePath, "worker.fifo")])
  assert.equal((await once(gate, "exit"))[0], 0)
  return releasePath
}

/**
 * @param {string} configPath - Config path.
 * @param {Record<string, import("../src/json.js").JsonValue>} config - Raw config.
 * @returns {Promise<void>} Write completion.
 */
async function writeConfig(configPath, config) {
  await fs.writeFile(configPath, `module.exports = ${JSON.stringify(config, null, 2)}\n`)
}

/**
 * @param {string} statePath - Fixture state path.
 * @returns {Promise<void>} Cleanup completion.
 */
async function stopFixtureGuardian(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"))
    const pid = state.recovery?.guardian?.pid

    if (typeof pid !== "number") return
    const command = (await fs.readFile(`/proc/${pid}/cmdline`)).toString().replaceAll("\0", " ")

    if (!command.includes("process-guardian.js") || !command.includes(statePath)) throw new Error(`Refusing to stop unverified fixture guardian pid ${pid}`)
    process.kill(pid, "SIGKILL")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return
    throw error
  }
}

/**
 * @param {string} statePath - State path.
 * @param {(state: RecoveryState) => boolean} predicate - Completion predicate.
 * @returns {Promise<RecoveryState>} Matching state.
 */
async function waitForState(statePath, predicate) {
  const watcher = fs.watch(path.dirname(statePath))

  try {
    const initial = /** @type {RecoveryState} */ (JSON.parse(await fs.readFile(statePath, "utf8")))
    if (predicate(initial)) return initial

    for await (const change of watcher) {
      if (change.filename !== path.basename(statePath)) continue
      const state = /** @type {RecoveryState} */ (JSON.parse(await fs.readFile(statePath, "utf8")))

      if (predicate(state)) return state
    }
  } finally {
    await watcher.return?.()
  }

  throw new Error("State watcher ended before the expected snapshot")
}

/**
 * @param {string} configPath - Config path.
 * @param {{releaseId: string, releasePath: string, revision: string}} [bootstrap] - Optional bootstrap tuple.
 * @returns {import("node:child_process").ChildProcess} Daemon process.
 */
function spawnDaemon(configPath, bootstrap) {
  const args = [binPath, "daemon", "--config", configPath]

  if (bootstrap) args.push("--release-id", bootstrap.releaseId, "--release-path", bootstrap.releasePath, "--revision", bootstrap.revision)
  return spawn(process.execPath, args, {stdio: ["ignore", "pipe", "pipe"]})
}

/**
 * @param {string} configPath - Config path.
 * @returns {Promise<{code: number | null, output: string}>} Exit result.
 */
async function runDaemon(configPath) {
  const child = spawnDaemon(configPath)
  let output = ""

  child.stdout?.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  child.stderr?.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  const [code] = await once(child, "exit")
  return {code, output}
}

/**
 * @param {string[]} args - CLI arguments.
 * @returns {Promise<{code: number, output: string}>} Exit result.
 */
async function runCli(args) {
  const child = spawn(process.execPath, [binPath, ...args], {stdio: ["ignore", "pipe", "pipe"]})
  let output = ""

  child.stdout?.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  child.stderr?.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  const [code] = await once(child, "exit")
  return {code, output}
}

/**
 * @param {import("node:child_process").ChildProcess} child - Daemon child.
 * @param {string} message - Structured log message.
 */
async function waitForLog(child, message) {
  assert.ok(child.stdout)
  child.stdout.setEncoding("utf8")

  await new Promise((resolve, reject) => {
    let buffer = ""
    let stderr = ""
    const onErrorData = (/** @type {string} */ chunk) => { stderr += chunk }
    const onExit = () => finish(new Error(`Daemon exited before logging ${message}: ${stderr.trim()}`))
    /** @param {string} chunk - Output chunk. */
    const onData = (chunk) => {
      buffer += chunk
      const lines = buffer.split("\n")

      buffer = lines.pop() || ""
      for (const line of lines) {
        if (line && JSON.parse(line).message === message) {
          finish()
          return
        }
      }
    }
    /** @param {Error} [error] - Failure. */
    const finish = (error) => {
      child.off("exit", onExit)
      child.stdout?.off("data", onData)
      child.stderr?.off("data", onErrorData)
      if (error) reject(error)
      else resolve(undefined)
    }

    child.once("exit", onExit)
    child.stdout?.on("data", onData)
    child.stderr?.setEncoding("utf8").on("data", onErrorData)
  })
}
