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
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"
import {sendControlCommand} from "../src/control-client.js"
import {readState, writeState} from "../src/state-store.js"
import {runCli} from "../src/cli.js"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const binPath = path.join(currentDir, "..", "bin", "rollbridge")
const dependentAppPath = path.join(currentDir, "fixtures", "dependent-app.js")
const dummyAppPath = path.join(currentDir, "fixtures", "dummy-app.js")
const memoryHogPath = path.join(currentDir, "fixtures", "memory-hog.js")
const serviceAppPath = path.join(currentDir, "fixtures", "service-app.js")
const singletonAppPath = path.join(currentDir, "fixtures", "singleton-app.js")

test("a nonBlockingDrain worker stops immediately while its release is still draining", async () => {
  const fixture = await createFixture({nonBlockingDrainWorker: true})
  const daemon = await startDaemon(fixture.config)
  /** @type {WebSocket | undefined} */
  let socket

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // An open WebSocket keeps v1's connection drain pending after v2 takes over.
    socket = await openWebSocket(daemon)
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    // The nonBlockingDrain worker is stopped right away, in parallel with the connection drain.
    await waitFor(() => {
      const draining = daemon.status().releases.find((release) => release.releaseId === "v1")

      return draining?.processes.find((processStatus) => processStatus.id === "worker")?.state === "stopped"
    })

    const v1 = statusRelease(daemon, "v1")

    // The release is still draining (the WebSocket is held) and its proxied process is still
    // serving, but the worker has already drained.
    assert.equal(v1.state, "draining")
    assert.equal(v1.processes.find((processStatus) => processStatus.id === "web")?.state, "running")
    assert.equal(v1.processes.find((processStatus) => processStatus.id === "worker")?.state, "stopped")
  } finally {
    if (socket) socket.close()
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

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

test("handoff services start per release and drain with their release", async () => {
  const fixture = await createFixture({handoffService: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)
  /** @type {WebSocket | undefined} */
  let socket

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    socket = await openWebSocket(daemon)
    const v1 = statusRelease(daemon, "v1")
    const v1Service = v1.processes.find((processStatus) => processStatus.id === "beacon")

    assert.ok(v1Service?.pid, "v1 service should be running")
    assert.equal(v1.ports.beacon > 0, true)

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    const v2 = statusRelease(daemon, "v2")
    const v2Service = v2.processes.find((processStatus) => processStatus.id === "beacon")

    assert.ok(v2Service?.pid, "v2 service should be running")
    assert.notEqual(v2.ports.beacon, v1.ports.beacon)
    assert.equal(statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "beacon")?.state, "running")

    socket.close()
    socket = undefined

    await waitFor(() => statusRelease(daemon, "v1").state === "stopped")
    assert.equal(statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "beacon")?.state, "stopped")

    const events = await processEvents(fixture.serviceLogPath)

    assert.ok(events.some((event) => event.event === "start" && event.releaseId === "v1"), "v1 service should start")
    assert.ok(events.some((event) => event.event === "start" && event.releaseId === "v2"), "v2 service should start")
    assert.ok(events.some((event) => event.event === "stop" && event.releaseId === "v1"), "v1 service should stop after drain")
  } finally {
    if (socket) socket.close()
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("handoff services stop after release-local dependents finish draining", async () => {
  const fixture = await createFixture({handoffService: true, nonBlockingDrainWorker: true, webDependsOnService: true, workerStopDelayMs: 200})
  const daemon = await startDaemon(fixture.config)
  /** @type {WebSocket | undefined} */
  let socket

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    socket = await openWebSocket(daemon)
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    await waitFor(() => statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "worker")?.state === "stopped")

    const drainingRelease = statusRelease(daemon, "v1")

    assert.equal(drainingRelease.state, "draining")
    assert.equal(drainingRelease.processes.find((processStatus) => processStatus.id === "beacon")?.state, "running")

    socket.close()
    socket = undefined
    await waitFor(() => statusRelease(daemon, "v1").state === "stopped")

    const events = await processEvents(fixture.serviceLogPath)
    const v1ServiceStop = events.find((event) => event.event === "stop" && event.releaseId === "v1")

    assert.ok(v1ServiceStop, "v1 handoff service should stop after release drain")
  } finally {
    if (socket) socket.close()
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("a replicated companion starts one instance per replica, and restart targets one or all", async () => {
  const fixture = await createFixture({companionReplicas: 3})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const release = daemon.status().releases.find((candidate) => candidate.state === "active")

    assert.ok(release)

    const workerIds = release.processes.filter((processStatus) => processStatus.id.startsWith("worker")).map((processStatus) => processStatus.id).sort()

    assert.deepEqual(workerIds, ["worker#0", "worker#1", "worker#2"])

    // A specific replica id restarts only that replica.
    const one = await daemon.restartProcesses({processId: "worker#1"})

    assert.deepEqual(one.restarted, ["worker#1"])

    // The base id restarts every replica.
    const all = /** @type {string[]} */ ((await daemon.restartProcesses({processId: "worker"})).restarted)

    assert.deepEqual([...all].sort(), ["worker#0", "worker#1", "worker#2"])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("restart bounces a single process by id", async () => {
  const fixture = await createFixture({includeService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const before = pidsById(daemon.status())
    const result = await daemon.restartProcesses({processId: "beacon"})

    assert.deepEqual(result.restarted, ["beacon"])

    const after = pidsById(daemon.status())

    assert.ok(before.beacon && after.beacon, "beacon should have a pid before and after")
    assert.notEqual(after.beacon, before.beacon)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("restart with no selector bounces every non-proxied process but not the proxied one", async () => {
  const fixture = await createFixture({includeCompanion: true, includeService: true, includeSingleton: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const before = pidsById(daemon.status())
    const result = await daemon.restartProcesses()
    const restarted = /** @type {string[]} */ (result.restarted)

    assert.deepEqual([...restarted].sort(), ["beacon", "jobs-main", "worker"])

    const after = pidsById(daemon.status())

    assert.equal(after.web, before.web, "proxied process should not be restarted")
    assert.notEqual(after.beacon, before.beacon)
    assert.notEqual(after["jobs-main"], before["jobs-main"])
    assert.notEqual(after.worker, before.worker)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("restart --policy targets only processes with that policy", async () => {
  const fixture = await createFixture({includeCompanion: true, includeService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const before = pidsById(daemon.status())
    const result = await daemon.restartProcesses({policy: "companion"})

    assert.deepEqual(result.restarted, ["worker"])

    const after = pidsById(daemon.status())

    assert.notEqual(after.worker, before.worker)
    assert.equal(after.beacon, before.beacon, "the service should be left running")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("restart refuses the proxied process and reports unknown ids", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    await assert.rejects(() => daemon.restartProcesses({processId: "web"}), /proxied process cannot be restarted/)
    await assert.rejects(() => daemon.restartProcesses({policy: "proxied"}), /proxied process cannot be restarted/)
    await assert.rejects(() => daemon.restartProcesses({processId: "missing"}), /No managed process with id "missing"/)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("restart revives a stopped process instead of erroring", async () => {
  const fixture = await createFixture({includeCompanion: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // Simulate the worker having exited (e.g. crashed and exhausted its restart budget).
    const worker = daemon.activeRelease?.getProcess("worker")

    assert.ok(worker, "worker process should exist")
    await worker.stop()
    assert.equal(worker.status().state, "stopped")

    const result = await daemon.restartProcesses({processId: "worker"})

    assert.deepEqual(result.restarted, ["worker"])
    assert.equal(worker.status().state, "running")
    assert.ok(worker.status().pid)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("the restart control command bounces a process over the socket", async () => {
  const fixture = await createFixture({includeService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const before = pidsById(daemon.status())
    const response = await sendControlCommand({
      command: {command: "restart", processId: "beacon"},
      path: fixture.config.control.path
    })

    assert.deepEqual(response.restarted, ["beacon"])
    assert.notEqual(pidsById(daemon.status()).beacon, before.beacon)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("status and events distinguish deploy starts from manual restarts", async () => {
  const fixture = await createFixture({includeService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const afterDeploy = daemon.status().services.find((service) => service.id === "beacon")

    assert.ok(afterDeploy)
    assert.equal(afterDeploy.process.lastStartReason, "deploy")

    await daemon.restartProcesses({processId: "beacon"})

    const afterRestart = daemon.status().services.find((service) => service.id === "beacon")

    assert.ok(afterRestart)
    assert.equal(afterRestart.process.lastStartReason, "manual")

    const events = /** @type {import("../src/event-log.js").DaemonEvent[]} */ ((await sendControlCommand({
      command: {command: "events"},
      path: fixture.config.control.path
    })).events)
    const startReasons = events.filter((event) => event.message === "process started").map((event) => event.data.reason)

    assert.ok(startReasons.includes("deploy"), JSON.stringify(startReasons))
    assert.ok(startReasons.includes("manual"), JSON.stringify(startReasons))
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("persists daemon state to statePath and removes it on a clean shutdown", async () => {
  const fixture = await createFixture({persistState: true})
  const daemon = await startDaemon(fixture.config)
  let stateAfterShutdown

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // The state write is fire-and-forget (deploy doesn't block on it), so wait for it to land.
    await waitFor(async () => {
      const persisted = /** @type {{activeReleaseId: string} | undefined} */ (await readState(fixture.statePath))

      return persisted?.activeReleaseId === "v1"
    })

    await daemon.shutdown()
    stateAfterShutdown = await readState(fixture.statePath)
  } finally {
    if (!daemon.stopping) await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }

  assert.equal(stateAfterShutdown, undefined, "state file removed on clean shutdown")
})

test("a clean shutdown clears the state file even when a persist write is in flight", async () => {
  const fixture = await createFixture({persistState: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // Shut down immediately — the deploy's fire-and-forget persist may still be in flight.
    await daemon.shutdown()

    assert.equal(await readState(fixture.statePath), undefined, "state file must not be recreated by an in-flight write")
  } finally {
    if (!daemon.stopping) await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("reports orphaned managed processes from a previous daemon's state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const statePath = path.join(dir, "state.json")
  // A live process standing in for a leftover managed child from a crashed daemon.
  const leftover = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"})

  await once(leftover, "spawn")

  /** @type {{data: Record<string, import("../src/json.js").JsonValue>, message: string}[]} */
  const logs = []
  const config = normalizeConfig({
    application: "rollbridge-test",
    control: {path: path.join(dir, "rollbridge.sock")},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0},
    statePath
  })
  const daemon = new RollbridgeDaemon({config, logger: (message, data = {}) => { logs.push({data, message}) }})

  try {
    // A prior daemon left a worker with this (still-alive) pid.
    await writeState(statePath, {
      activeReleaseId: "v1",
      releases: [{processes: [{id: "worker", pid: leftover.pid}], releaseId: "v1"}],
      services: [],
      singletons: []
    })

    await daemon.reportOrphans()

    assert.ok(logs.some((entry) => entry.message === "orphaned managed process detected" && entry.data.pid === leftover.pid), JSON.stringify(logs))

    // A dead pid is not reported.
    logs.length = 0
    await writeState(statePath, {
      activeReleaseId: "v1",
      releases: [{processes: [{id: "worker", pid: 2147483646}], releaseId: "v1"}],
      services: [],
      singletons: []
    })
    await daemon.reportOrphans()

    assert.ok(!logs.some((entry) => entry.message === "orphaned managed process detected"))
  } finally {
    leftover.kill("SIGKILL")
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("status surfaces still-alive orphaned processes from a previous daemon and drops them once gone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const statePath = path.join(dir, "state.json")
  const leftover = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"})

  await once(leftover, "spawn")

  const config = normalizeConfig({
    application: "rollbridge-test",
    control: {path: path.join(dir, "rollbridge.sock")},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0},
    statePath
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  try {
    // A prior daemon left a worker with this (still-alive) pid.
    await writeState(statePath, {
      activeReleaseId: "v1",
      releases: [{processes: [{id: "worker", pid: leftover.pid}], releaseId: "v1"}],
      services: [],
      singletons: []
    })

    await daemon.reportOrphans()

    // status reflects the still-running child even though the daemon cannot re-manage it.
    assert.deepEqual(daemon.status().orphans, [{id: "worker", pid: leftover.pid, releaseId: "v1"}])

    // Once the leftover is stopped, status re-checks liveness and drops it.
    leftover.kill("SIGKILL")
    await waitFor(() => daemon.status().orphans.length === 0)
    assert.deepEqual(daemon.status().orphans, [])

    // The dead entry is pruned from the underlying list, not merely filtered, so a recycled pid
    // can't resurrect a cleared orphan.
    assert.deepEqual(daemon.orphans, [])
  } finally {
    leftover.kill("SIGKILL")
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("the daemon records a structured event history served by the events command", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const response = await sendControlCommand({
      command: {command: "events"},
      path: fixture.config.control.path
    })
    const events = /** @type {import("../src/event-log.js").DaemonEvent[]} */ (response.events)
    const messages = events.map((event) => event.message)

    assert.ok(messages.includes("deploy starting"), JSON.stringify(messages))
    assert.ok(messages.includes("traffic switched"), JSON.stringify(messages))

    const switched = events.find((event) => event.message === "traffic switched")

    assert.ok(switched)
    assert.equal(switched.data.releaseId, "v1")
    assert.match(switched.at, /^\d{4}-\d{2}-\d{2}T.*Z$/)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("the events command honors --limit and records failed commands", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // An unknown command is rejected and recorded as a "command failed" event.
    await assert.rejects(() => sendControlCommand({
      command: {command: "bogus"},
      path: fixture.config.control.path
    }))

    const all = /** @type {import("../src/event-log.js").DaemonEvent[]} */ ((await sendControlCommand({
      command: {command: "events"},
      path: fixture.config.control.path
    })).events)

    assert.ok(all.some((event) => event.message === "command failed"))

    const limited = /** @type {import("../src/event-log.js").DaemonEvent[]} */ ((await sendControlCommand({
      command: {command: "events", limit: 1},
      path: fixture.config.control.path
    })).events)

    assert.equal(limited.length, 1)
    assert.deepEqual(limited[0], all[all.length - 1])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("a process over its memory limit is restarted with reason memory", {skip: process.platform !== "linux" && "requires /proc (Linux)"}, async () => {
  const limitBytes = 64 * 1024 * 1024
  const fixture = await createFixture({memoryLimitBytes: limitBytes})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // The hog allocates ~4x the limit, so the monitor restarts it.
    await waitFor(() => (activeProcessStatus(daemon, "hog")?.memoryRestarts ?? 0) >= 1, 10000)

    const hog = activeProcessStatus(daemon, "hog")

    assert.ok(hog, "hog process should be present")
    assert.ok(hog.memoryRestarts >= 1, `expected a memory restart, got ${hog.memoryRestarts}`)
    assert.equal(hog.lastStartReason, "memory")
    assert.equal(typeof hog.lastMemoryRestartAt, "string")

    // rssBytes is sampled on the monitor's interval; wait for a measurement of the running process.
    await waitFor(() => {
      const rssBytes = activeProcessStatus(daemon, "hog")?.rssBytes

      return typeof rssBytes === "number" && rssBytes > 0
    }, 5000)

    // The same monitor sample reports the process tree.
    const monitored = activeProcessStatus(daemon, "hog")

    assert.ok(monitored)
    assert.ok(monitored.children.length >= 1, "status should include the process tree")
    assert.ok(monitored.children.some((child) => typeof child.rssBytes === "number" && child.rssBytes > 0))
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("rollback re-activates the previous release and switches traffic back", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    assert.equal(await fetchText(daemon, "/release"), "v2")

    const result = await daemon.rollback()

    assert.equal(result.activeReleaseId, "v1")
    assert.equal(result.previousReleaseId, "v2")
    assert.equal(daemon.status().activeReleaseId, "v1")
    assert.equal(await fetchText(daemon, "/release"), "v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("rollback --release-id targets a specific retained release", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    await daemon.deploy({releaseId: "v3", releasePath: fixture.root, revision: "v3"})

    const result = await daemon.rollback({releaseId: "v1"})

    assert.equal(result.activeReleaseId, "v1")
    assert.equal(await fetchText(daemon, "/release"), "v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("rollback rejects no-previous, unknown, and already-active targets", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    await assert.rejects(() => daemon.rollback(), /No previous release/)
    await assert.rejects(() => daemon.rollback({releaseId: "v1"}), /already active/)
    await assert.rejects(() => daemon.rollback({releaseId: "nope"}), /No retained release "nope"/)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("rollback to a still-draining release stops the old instance instead of orphaning it", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)
  /** @type {WebSocket | undefined} */
  let socket

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // An open WebSocket keeps v1's connection count > 0, so it stays draining after v2.
    socket = await openWebSocket(daemon)
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    const draining = statusRelease(daemon, "v1")

    assert.equal(draining.state, "draining")

    const oldWebPid = draining.processes.find((processStatus) => processStatus.id === "web")?.pid

    assert.ok(oldWebPid, "the draining release should have a running web process")

    await daemon.rollback({releaseId: "v1"})

    assert.equal(daemon.status().activeReleaseId, "v1")
    // The old draining instance was stopped before its id was reused, so its process is gone.
    assert.throws(() => process.kill(/** @type {number} */ (oldWebPid), 0), /ESRCH/)
  } finally {
    if (socket) socket.close()
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("the rollback control command switches traffic over the socket", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    const response = await sendControlCommand({
      command: {command: "rollback"},
      path: fixture.config.control.path
    })

    assert.equal(response.activeReleaseId, "v1")
    assert.equal(await fetchText(daemon, "/release"), "v1")
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

test("the daemon applies control.owner and control.group to the bound socket", {skip: process.platform !== "linux" && "requires POSIX chown"}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const {uid, username} = os.userInfo()
  const gid = process.getgid?.() ?? 0
  const config = normalizeConfig({
    application: "rollbridge-test",
    // owner by name (resolved to the current uid); group by numeric id. Both are the current
    // user's, so a non-root daemon can chown the socket to itself.
    control: {group: gid, owner: username, path: socketPath},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0}
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  try {
    await daemon.start()

    const stats = await fs.stat(socketPath)

    assert.equal(stats.uid, uid)
    assert.equal(stats.gid, gid)
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
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
 * @param {{companionReplicas?: number, handoffService?: boolean, includeCompanion?: boolean, includeService?: boolean, includeSingleton?: boolean, memoryLimitBytes?: number, nonBlockingDrainWorker?: boolean, persistState?: boolean, proxyHost?: string, singletonCwd?: string, webCommand?: string, webDependsOnService?: boolean, webHealthTimeoutMs?: number, workerStopDelayMs?: number}} [options] - Fixture options.
 * @returns {Promise<{config: import("../src/config.js").RollbridgeConfig, root: string, serviceLogPath: string, singletonLogPath: string, statePath: string}>} Fixture data.
 */
async function createFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const serviceLogPath = path.join(root, "service.log")
  const singletonLogPath = path.join(root, "singleton.log")
  const statePath = path.join(root, "rollbridge.state.json")
  /** @type {Array<Record<string, import("../src/json.js").JsonValue>>} */
  const processes = []

  if (options.includeService || options.handoffService) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(serviceAppPath)} --release={{releaseId}}`,
      ...(options.handoffService ? {deployStrategy: "handoff"} : {}),
      env: {
        ROLLBRIDGE_SERVICE_LOG: serviceLogPath
      },
      id: "beacon",
      policy: "service",
      port: options.handoffService ? {from: 15000, to: 15099} : {from: 0, to: 0},
      restartDelayMs: 50
    })
  }

  if (options.includeCompanion) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      id: "worker",
      policy: "companion"
    })
  }

  if (options.companionReplicas) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      id: "worker",
      policy: "companion",
      replicas: options.companionReplicas
    })
  }

  if (options.nonBlockingDrainWorker) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${options.workerStopDelayMs || 0})); setInterval(() => {}, 1000)`)}`,
      id: "worker",
      nonBlockingDrain: true,
      policy: "companion"
    })
  }

  if (options.memoryLimitBytes) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(memoryHogPath)}`,
      env: {
        ROLLBRIDGE_HOG_BYTES: String(options.memoryLimitBytes * 4)
      },
      id: "hog",
      memory: {checkIntervalMs: 100, limitBytes: options.memoryLimitBytes, warnBytes: 0},
      policy: "companion"
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
    },
    ...(options.persistState ? {statePath} : {})
  })

  return {config, root, serviceLogPath, singletonLogPath, statePath}
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
 * Maps process id to pid across the active release, services, and singletons.
 * @param {import("../src/daemon.js").DaemonStatus} status - Daemon status payload.
 * @returns {Record<string, number | undefined>} Process id to current pid.
 */
function pidsById(status) {
  /** @type {Record<string, number | undefined>} */
  const pids = {}

  for (const release of status.releases) {
    if (release.state !== "active") continue

    for (const processStatus of release.processes) pids[processStatus.id] = processStatus.pid
  }

  for (const service of status.services) pids[service.id] = service.process.pid
  for (const singleton of status.singletons) pids[singleton.id] = singleton.process.pid

  return pids
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
 * @param {number} [timeoutMs] - How long to wait before giving up (default 3000).
 * @returns {Promise<void>} Resolves when callback returns true.
 */
async function waitFor(callback, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await callback()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error("Timed out waiting for condition")
}

/**
 * @param {RollbridgeDaemon} daemon - Daemon.
 * @param {string} processId - Process id within the active release.
 * @returns {import("../src/managed-process.js").ManagedProcessStatus | undefined} The process status, if present.
 */
function activeProcessStatus(daemon, processId) {
  const release = daemon.status().releases.find((candidate) => candidate.state === "active")

  return release ? release.processes.find((processStatus) => processStatus.id === processId) : undefined
}
