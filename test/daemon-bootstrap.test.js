// @ts-check

import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {once} from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import {sendControlCommand} from "../src/control-client.js"
import {isProcessAlive, liveProcesses, readState, writeState} from "../src/state-store.js"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const binPath = path.join(currentDir, "..", "bin", "rollbridge")
const dummyAppPath = path.join(currentDir, "fixtures", "dummy-app.js")

test("daemon bootstrap requires complete, safe, absolute inputs before binding listeners", async (t) => {
  const cases = [
    {args: ["--config", "CONFIG", "--release-path", "RELEASE", "--release-id", "v1"], message: /must be provided together/},
    {args: ["--config", "relative/config.js", "--release-path", "RELEASE", "--release-id", "v1", "--revision", "abc123"], message: /--config must be an absolute path/},
    {args: ["--config", "CONFIG", "--release-path", "relative/release", "--release-id", "v1", "--revision", "abc123"], message: /--release-path must be an absolute path/},
    {args: ["--config", "CONFIG", "--release-path", "RELEASE", "--release-id", "unsafe id", "--revision", "abc123"], message: /--release-id/},
    {args: ["--config", "CONFIG", "--release-path", "RELEASE", "--release-id", "v1", "--revision", "unsafe revision"], message: /--revision/}
  ]

  for (const testCase of cases) {
    await t.test(testCase.message.source, async () => {
      const fixture = await createFixture()
      const args = testCase.args.map((arg) => arg === "CONFIG" ? fixture.configPath : arg === "RELEASE" ? fixture.root : arg)

      try {
        const result = await runDaemon(args)

        assert.notEqual(result.code, 0)
        assert.match(result.stderr, testCase.message)
        await assert.rejects(() => fs.stat(fixture.socketPath), {code: "ENOENT"})
      } finally {
        await fs.rm(fixture.root, {force: true, recursive: true})
      }
    })
  }
})

test("daemon bootstrap activates the exact release through the foreground daemon", async () => {
  const fixture = await createFixture()
  const child = spawnDaemon(fixture, {releaseId: "release-42", revision: "abc123"})

  try {
    await waitForLog(child, "control socket listening")
    const status = await sendControlCommand({command: {command: "status"}, path: fixture.socketPath})
    const activeRelease = assertRelease(status, "release-42")

    assert.equal(activeRelease.releasePath, fixture.root)
    assert.equal(activeRelease.revision, "abc123")
    assert.ok(status.proxy && typeof status.proxy === "object" && !Array.isArray(status.proxy) && typeof status.proxy.port === "number")
    assert.equal((await fetch(`http://127.0.0.1:${status.proxy.port}/release`).then((response) => response.text())).trim(), "release-42")

    child.kill("SIGTERM")
    assert.equal((await once(child, "exit"))[0], 0)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("daemon bootstrap does not expose control deploys until activation completes", async () => {
  const fixture = await createFixture({healthGate: true, healthTimeoutMs: 60000})
  const started = waitForFile(fixture.startedPath)
  const child = spawnDaemon(fixture, {releaseId: "bootstrap-release", revision: "bootstrap123"})

  try {
    await started
    await assert.rejects(() => fs.stat(fixture.socketPath), {code: "ENOENT"})

    await fs.writeFile(fixture.healthGatePath, "ready\n")
    await waitForLog(child, "control socket listening")

    const status = await sendControlCommand({command: {command: "status"}, path: fixture.socketPath})

    assert.equal(status.activeReleaseId, "bootstrap-release")
    assert.ok(Array.isArray(status.releases))
    assert.equal(status.releases.length, 1)
    assertRelease(status, "bootstrap-release")

    child.kill("SIGTERM")
    assert.equal((await once(child, "exit"))[0], 0)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("plain daemon startup remains listener-only with no active release", async () => {
  const fixture = await createFixture()
  const child = spawn(process.execPath, [binPath, "daemon", "--config", fixture.configPath], {stdio: ["pipe", "pipe", "pipe"]})

  try {
    await waitForLog(child, "control socket listening")
    const status = await sendControlCommand({command: {command: "status"}, path: fixture.socketPath})

    assert.equal(status.activeReleaseId, null)
    assert.deepEqual(status.releases, [])

    child.kill("SIGTERM")
    assert.equal((await once(child, "exit"))[0], 0)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("SIGTERM during bootstrap activation follows the daemon shutdown path", async () => {
  const fixture = await createFixture({healthPath: "/never-ready", healthTimeoutMs: 60000})
  const started = waitForFile(fixture.startedPath)
  const child = spawnDaemon(fixture, {releaseId: "slow-release", revision: "slow123"})

  try {
    const managedPid = Number(await started)
    child.kill("SIGTERM")

    const [code, signal] = await once(child, "exit")

    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.equal(await fs.readFile(fixture.stoppedPath, "utf8"), String(managedPid))
    await assert.rejects(() => fs.stat(fixture.socketPath), {code: "ENOENT"})
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("SIGTERM during multi-process bootstrap owns every process started after shutdown begins", async () => {
  const fixture = await createFixture({multiProcessSignal: true})
  const shutdownStarted = waitForLifecycleEvent(fixture.lifecyclePath, (event) => event.event === "shutdown")
  const child = spawnDaemon(fixture, {releaseId: "multi-release", revision: "multi123"})
  let output = ""

  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })

  try {
    await shutdownStarted
    await fs.writeFile(fixture.gatePath, "continue\n")
    const [code, signal] = await once(child, "exit")
    const events = (await fs.readFile(fixture.lifecyclePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    const shutdownIndex = events.findIndex((event) => event.event === "shutdown")
    const startedAfterShutdown = events.slice(shutdownIndex + 1).filter((event) => event.event === "started")
    const records = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    const recordedPids = new Set(records.filter((record) => record.message === "process started").map((record) => record.data?.pid))

    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.notEqual(shutdownIndex, -1)
    assert.ok(startedAfterShutdown.length > 0, `fixture must start a later bootstrap process after triggering shutdown: ${JSON.stringify(events)}`)
    assert.deepEqual(startedAfterShutdown.filter((event) => !recordedPids.has(event.pid)), [])
    for (const event of startedAfterShutdown) assert.equal(isProcessAlive(event.pid), false, `expected process ${event.pid} to be stopped before daemon exit`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")

    try {
      const events = (await fs.readFile(fixture.lifecyclePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))

      for (const event of events) {
        if (event.event === "started" && isProcessAlive(event.pid)) process.kill(-event.pid, "SIGKILL")
      }
    } catch {
      // The fixture may exit before creating its lifecycle log.
    }

    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("failed daemon bootstrap reports a structured failure, cleans its processes, and exits non-zero", async () => {
  const fixture = await createFixture({healthPath: "/never-ready", healthTimeoutMs: 100})

  try {
    const result = await runDaemon([
      "--config", fixture.configPath,
      "--release-path", fixture.root,
      "--release-id", "bad-release",
      "--revision", "bad123"
    ])
    const records = result.output.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    const failure = records.find((record) => record.message === "bootstrap activation failed")

    assert.notEqual(result.code, 0)
    assert.deepEqual(failure?.data, {releaseId: "bad-release", status: "error"})
    assert.ok(records.some((record) => record.message === "release startup process status" && record.data?.phase === "after cleanup" && record.data?.state === "stopped"))
    await assert.rejects(() => fs.stat(fixture.socketPath), {code: "ENOENT"})
  } finally {
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("daemon bootstrap reports but does not kill a live process from statePath", async () => {
  const fixture = await createFixture({persistState: true})
  const leftover = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"})

  await once(leftover, "spawn")
  await writeState(fixture.statePath, {
    activeReleaseId: "previous",
    releases: [{processes: [{id: "worker", pid: leftover.pid}], releaseId: "previous"}],
    services: [],
    singletons: []
  })

  const child = spawnDaemon(fixture, {releaseId: "recovered", revision: "def456"})

  try {
    await waitForLog(child, "control socket listening")
    const status = await sendControlCommand({command: {command: "status"}, path: fixture.socketPath})

    assert.ok(leftover.pid !== undefined && isProcessAlive(leftover.pid))
    assert.deepEqual(status.orphans, [{id: "worker", pid: leftover.pid, releaseId: "previous"}])

    child.kill("SIGTERM")
    await once(child, "exit")

    assert.deepEqual(liveProcesses(await readState(fixture.statePath)), [{id: "worker", pid: leftover.pid, releaseId: "previous"}])
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    leftover.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("failed daemon bootstrap preserves prior live process records in statePath", async () => {
  const fixture = await createFixture({healthPath: "/never-ready", healthTimeoutMs: 100, persistState: true})
  const leftover = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"})

  await once(leftover, "spawn")
  await writeState(fixture.statePath, {
    activeReleaseId: "previous",
    releases: [{processes: [{id: "worker", pid: leftover.pid}], releaseId: "previous"}],
    services: [],
    singletons: []
  })

  try {
    const result = await runDaemon([
      "--config", fixture.configPath,
      "--release-path", fixture.root,
      "--release-id", "bad-release",
      "--revision", "bad123"
    ])

    assert.notEqual(result.code, 0)
    assert.deepEqual(liveProcesses(await readState(fixture.statePath)), [{id: "worker", pid: leftover.pid, releaseId: "previous"}])
  } finally {
    leftover.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

/**
 * @param {{healthGate?: boolean, healthPath?: string, healthTimeoutMs?: number, multiProcessSignal?: boolean, persistState?: boolean}} [options] - Fixture options.
 * @returns {Promise<{configPath: string, gatePath: string, healthGatePath: string, lifecyclePath: string, root: string, socketPath: string, startedPath: string, statePath: string, stoppedPath: string}>} Fixture paths.
 */
async function createFixture({healthGate = false, healthPath = "/ping", healthTimeoutMs = 1000, multiProcessSignal = false, persistState = false} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-bootstrap-"))
  const socketPath = path.join(root, "control.sock")
  const statePath = path.join(root, "state.json")
  const startedPath = path.join(root, "started.pid")
  const stoppedPath = path.join(root, "stopped.pid")
  const lifecyclePath = path.join(root, "lifecycle.jsonl")
  const gatePath = path.join(root, "continue.fifo")
  const healthGatePath = path.join(root, "health-ready")
  const configPath = path.join(root, "rollbridge.js")
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`
  const lifecycleEnv = {ROLLBRIDGE_TEST_LIFECYCLE_PATH: lifecyclePath}
  const webEnv = {
    ROLLBRIDGE_TEST_STARTED_PATH: startedPath,
    ROLLBRIDGE_TEST_STOPPED_PATH: stoppedPath,
    ...(healthGate ? {ROLLBRIDGE_TEST_HEALTH_GATE_PATH: healthGatePath} : {})
  }
  const config = {
    application: "bootstrap-test",
    control: {path: socketPath},
    processes: multiProcessSignal ? [
      {command: `trap '' TERM; printf '%s\\n' '{"event":"shutdown"}' >> ${JSON.stringify(lifecyclePath)}; kill -TERM "$ROLLBRIDGE_TEST_DAEMON_PID"; printf '{"event":"started","pid":%s,"processId":"database","replicaIndex":"0"}\\n' "$$" >> ${JSON.stringify(lifecyclePath)}; read ignored < ${JSON.stringify(gatePath)}`, env: lifecycleEnv, id: "database", policy: "service"},
      {command: `exec ${command}`, env: lifecycleEnv, id: "worker", policy: "companion", replicas: 2},
      {command: `exec ${command}`, env: lifecycleEnv, health: {path: healthPath, timeoutMs: healthTimeoutMs}, id: "web", policy: "proxied", port: {from: 0, to: 0}}
    ] : [{command, env: webEnv, health: {path: healthPath, timeoutMs: healthTimeoutMs}, id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0},
    ...(persistState ? {statePath} : {})
  }

  const setup = multiProcessSignal ? "process.env.ROLLBRIDGE_TEST_DAEMON_PID = String(process.pid)\n" : ""

  if (multiProcessSignal) {
    const fifo = spawn("mkfifo", [gatePath])
    const [code] = await once(fifo, "exit")

    assert.equal(code, 0)
  }

  await fs.writeFile(configPath, `${setup}module.exports = ${JSON.stringify(config, null, 2)}\n`)
  return {configPath, gatePath, healthGatePath, lifecyclePath, root, socketPath, startedPath, statePath, stoppedPath}
}

/**
 * @param {string} filePath - JSON-lines event path.
 * @param {(event: Record<string, import("../src/json.js").JsonValue>) => boolean} matches - Event predicate.
 * @returns {Promise<Record<string, import("../src/json.js").JsonValue>>} First matching event.
 */
async function waitForLifecycleEvent(filePath, matches) {
  const watcher = fs.watch(path.dirname(filePath))

  try {
    for await (const event of watcher) {
      if (event.filename !== path.basename(filePath)) continue

      const records = (await fs.readFile(filePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      const match = records.find(matches)

      if (match) return match
    }
  } finally {
    await watcher.return?.()
  }

  throw new Error(`File watcher ended before a matching event was written to ${filePath}`)
}

/**
 * @param {string} filePath - File whose creation is the synchronization point.
 * @returns {Promise<string>} File contents once created.
 */
async function waitForFile(filePath) {
  const watcher = fs.watch(path.dirname(filePath))

  try {
    for await (const event of watcher) {
      if (event.filename === path.basename(filePath)) return await fs.readFile(filePath, "utf8")
    }
  } finally {
    await watcher.return?.()
  }

  throw new Error(`File watcher ended before ${filePath} was created`)
}

/**
 * @param {{configPath: string, root: string}} fixture - Fixture paths.
 * @param {{releaseId: string, revision: string}} release - Bootstrap metadata.
 * @returns {import("node:child_process").ChildProcessWithoutNullStreams} Spawned daemon.
 */
function spawnDaemon(fixture, release) {
  return spawn(process.execPath, [binPath, "daemon", "--config", fixture.configPath, "--release-path", fixture.root, "--release-id", release.releaseId, "--revision", release.revision], {stdio: ["pipe", "pipe", "pipe"]})
}

/**
 * @param {string[]} args - Daemon arguments.
 * @returns {Promise<{code: number | null, output: string, stderr: string}>} Completed process result.
 */
async function runDaemon(args) {
  const child = spawn(process.execPath, [binPath, "daemon", ...args], {stdio: ["ignore", "pipe", "pipe"]})
  let output = ""
  let stderr = ""

  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const [code] = await once(child, "exit")

  return {code, output, stderr}
}

/**
 * @param {import("node:child_process").ChildProcessWithoutNullStreams} child - Spawned daemon.
 * @param {string} message - Structured log message to await.
 * @returns {Promise<void>} Resolves after the message is observed.
 */
async function waitForLog(child, message) {
  child.stdout.setEncoding("utf8")

  for await (const chunk of child.stdout) {
    if (String(chunk).includes(`"message":"${message}"`)) return
  }

  throw new Error(`Daemon exited before logging ${message}`)
}

/**
 * @param {Record<string, import("../src/json.js").JsonValue>} status - Daemon status.
 * @param {string} releaseId - Expected release id.
 * @returns {Record<string, import("../src/json.js").JsonValue>} Matching release status.
 */
function assertRelease(status, releaseId) {
  assert.ok(Array.isArray(status.releases))
  const release = status.releases.find((candidate) => candidate && typeof candidate === "object" && "releaseId" in candidate && candidate.releaseId === releaseId)

  assert.ok(release && typeof release === "object" && !Array.isArray(release))
  return release
}
