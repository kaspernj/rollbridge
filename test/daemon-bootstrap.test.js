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
import {isProcessAlive, liveProcesses, readState, writeState} from "../src/state-store.js"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const binPath = path.join(currentDir, "..", "bin", "rollbridge")
const dummyAppPath = path.join(currentDir, "fixtures", "dummy-app.js")
const ownedChildPath = path.join(currentDir, "fixtures", "owned-child.js")
const firstAttestation = `sha256:${"a".repeat(64)}`
const secondAttestation = `sha256:${"b".repeat(64)}`

/** @typedef {{data?: Record<string, import("../src/json.js").JsonValue>, message?: string}} StructuredRecord */

test("daemon bootstrap requires complete, safe, absolute inputs before binding listeners", async (t) => {
  const cases = [
    {args: ["--config", "CONFIG", "--release-path", "RELEASE", "--release-id", "v1"], message: /must be provided together/},
    {args: ["--config", "relative/config.js", "--release-path", "RELEASE", "--release-id", "v1", "--revision", "abc123"], message: /--config must be an absolute path/},
    {args: ["--config", "CONFIG", "--release-path", "relative/release", "--release-id", "v1", "--revision", "abc123"], message: /--release-path must be an absolute path/},
    {args: ["--config", "CONFIG", "--release-path", "RELEASE_UNNORMALIZED", "--release-id", "v1", "--revision", "abc123"], message: /--release-path must be normalized/},
    {args: ["--config", "CONFIG", "--release-path", "RELEASE_MISSING", "--release-id", "v1", "--revision", "abc123"], message: /--release-path is not accessible/},
    {args: ["--config", "CONFIG", "--release-path", "RELEASE", "--release-id", "unsafe id", "--revision", "abc123"], message: /--release-id/},
    {args: ["--config", "CONFIG", "--release-path", "RELEASE", "--release-id", "v1", "--revision", "unsafe revision"], message: /--revision/},
    {args: ["--config", "CONFIG", "--boot-attestation", firstAttestation], message: /accepted only with/},
    {args: ["--config", "CONFIG", "--release-path", "RELEASE", "--release-id", "v1", "--revision", "abc123", "--boot-attestation", `sha256:${"A".repeat(64)}`], message: /--boot-attestation/},
    {args: ["--config", "CONFIG", "--release-path", "RELEASE", "--release-id", "v1", "--revision", "abc123", "--boot-attestation", `sha512:${"a".repeat(64)}`], message: /--boot-attestation/},
    {args: ["--config", "CONFIG", "--release-path", "RELEASE", "--release-id", "v1", "--revision", "abc123", "--boot-attestation", `sha256:${"a".repeat(63)}`], message: /--boot-attestation/}
  ]

  for (const testCase of cases) {
    await t.test(testCase.message.source, async () => {
      const fixture = await createFixture()
      const args = testCase.args.map((arg) => {
        if (arg === "CONFIG") return fixture.configPath
        if (arg === "RELEASE") return fixture.root
        if (arg === "RELEASE_UNNORMALIZED") return `${fixture.root}/child/..`
        if (arg === "RELEASE_MISSING") return path.join(fixture.root, "missing")
        return arg
      })

      try {
        const result = await runDaemon(args)

        assert.notEqual(result.code, 0)
        assert.match(result.stderr, testCase.message)
        await assert.rejects(() => fs.stat(fixture.socketPath), {code: "ENOENT"})
        await assert.rejects(() => fs.stat(fixture.startedPath), {code: "ENOENT"})
      } finally {
        await fs.rm(fixture.root, {force: true, recursive: true})
      }
    })
  }
})

test("daemon bootstrap activates the exact release through the foreground daemon", async () => {
  const fixture = await createFixture()
  const child = spawnDaemon(fixture, {attestation: firstAttestation, releaseId: "release-42", revision: "abc123"})

  try {
    await waitForLog(child, "control socket listening")
    const status = await sendControlCommand({command: {command: "status"}, path: fixture.socketPath})
    const activeRelease = assertRelease(status, "release-42")

    assert.equal(activeRelease.releasePath, fixture.root)
    assert.equal(activeRelease.revision, "abc123")
    assert.deepEqual(status.bootstrap, {
      attestation: firstAttestation,
      releaseId: "release-42",
      releasePath: fixture.root,
      revision: "abc123"
    })
    assert.ok(status.proxy && typeof status.proxy === "object" && !Array.isArray(status.proxy) && typeof status.proxy.port === "number")
    assert.equal((await fetch(`http://127.0.0.1:${status.proxy.port}/release`).then((response) => response.text())).trim(), "release-42")

    child.kill("SIGTERM")
    assert.equal((await once(child, "exit"))[0], 0)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("failed takeover bootstrap preserves the previously accepted owner", async () => {
  const fixture = await createFixture({persistState: true})
  const accepted = spawnDaemon(fixture, {attestation: firstAttestation, releaseId: "accepted", revision: "accepted123"})

  try {
    await waitForLog(accepted, "control socket listening")
    await waitForFile(fixture.statePath)
    const badConfig = JSON.parse((await fs.readFile(fixture.configPath, "utf8")).replace(/^module\.exports = /, ""))
    badConfig.processes[0].health.path = "/never-ready"
    badConfig.processes[0].health.timeoutMs = 100
    await fs.writeFile(fixture.configPath, `module.exports = ${JSON.stringify(badConfig, null, 2)}\n`)

    const result = await runDaemon([
      "--config", fixture.configPath,
      "--release-path", fixture.root,
      "--release-id", "candidate",
      "--revision", "candidate123",
      "--boot-attestation", secondAttestation,
      "--takeover-owner"
    ])

    assert.notEqual(result.code, 0)
    const records = parseStructuredOutput(result.output)
    const failure = records.find((record) => record.message === "bootstrap activation failed")
    const candidatePid = Number(await fs.readFile(fixture.startedPath, "utf8"))

    assert.match(String(failure?.data?.error), /Health check failed/)
    assert.match(String(failure?.data?.stack), /Error: Health check failed/)
    assert.equal(isProcessAlive(candidatePid), false, "the failed candidate process must be stopped")
    const status = await sendControlCommand({command: {command: "status"}, path: fixture.socketPath})
    assert.equal(status.activeReleaseId, "accepted")
    assert.ok(status.bootstrap && typeof status.bootstrap === "object" && !Array.isArray(status.bootstrap))
    assert.equal(status.bootstrap.attestation, firstAttestation)
    const priorState = await readState(fixture.statePath)

    assert.ok(priorState && typeof priorState === "object" && !Array.isArray(priorState) && priorState.activeReleaseId === "accepted", "candidate cleanup must preserve the prior owner's state")
  } finally {
    accepted.kill("SIGTERM")
    if (accepted.exitCode === null) await once(accepted, "exit")
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
    assert.equal(status.bootstrap, undefined)

    child.kill("SIGTERM")
    assert.equal((await once(child, "exit"))[0], 0)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("ensure-daemon rejects boot attestation instead of inheriting foreground identity", async () => {
  const fixture = await createFixture()

  try {
    const result = await runRollbridge(["ensure-daemon", "--config", fixture.configPath, "--boot-attestation", firstAttestation])

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /unknown option '--boot-attestation'/)
    await assert.rejects(() => fs.stat(fixture.socketPath), {code: "ENOENT"})
    await assert.rejects(() => fs.stat(fixture.startedPath), {code: "ENOENT"})
  } finally {
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("otherwise identical foreground boots remain distinguishable by attestation", async () => {
  const fixture = await createFixture()

  try {
    const attestations = []

    for (const attestation of [firstAttestation, secondAttestation]) {
      const child = spawnDaemon(fixture, {attestation, releaseId: "same-release", revision: "same-revision"})

      await waitForLog(child, "control socket listening")
      const status = await sendControlCommand({command: {command: "status"}, path: fixture.socketPath})

      assert.equal(status.activeReleaseId, "same-release")
      assert.ok(status.bootstrap && typeof status.bootstrap === "object" && !Array.isArray(status.bootstrap))
      attestations.push(status.bootstrap.attestation)

      child.kill("SIGTERM")
      assert.equal((await once(child, "exit"))[0], 0)
    }

    assert.deepEqual(attestations, [firstAttestation, secondAttestation])
  } finally {
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

test("failed ordinary bootstrap completely shuts down attempt-owned resources and exposes the cause", async () => {
  const fixture = await createFixture({attemptOwnedProcesses: true, fixedPorts: true, missingControlParent: true})

  try {
    const result = await runDaemon([
      "--config", fixture.configPath,
      "--release-path", fixture.root,
      "--release-id", "ordinary-failure",
      "--revision", "ordinary123"
    ])
    const records = parseStructuredOutput(result.output)
    const failure = records.find((record) => record.message === "bootstrap activation failed")

    assert.notEqual(result.code, 0)
    assert.equal(failure?.data?.releaseId, "ordinary-failure")
    assert.equal(failure?.data?.status, "error")
    assert.match(String(failure?.data?.error), /listen (?:EACCES|ENOENT)/)
    assert.match(String(failure?.data?.stack), /Error: listen (?:EACCES|ENOENT)/)
    await assertAttemptResourcesStopped(fixture, records)
    await assert.rejects(() => fs.stat(fixture.socketPath), {code: "ENOENT"})
  } finally {
    await killAttemptProcesses(fixture.lifecyclePath)
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("failed takeover retirement completely shuts down and exits non-zero instead of lingering", async () => {
  const fixture = await createFixture({attemptOwnedProcesses: true, fixedPorts: true})

  try {
    const result = await runDaemon([
      "--config", fixture.configPath,
      "--release-path", fixture.root,
      "--release-id", "orphaned-candidate",
      "--revision", "candidate123",
      "--boot-attestation", secondAttestation,
      "--takeover-owner"
    ], {timeoutMs: 2000})
    const records = parseStructuredOutput(result.output)
    const failure = records.find((record) => record.message === "bootstrap activation failed")

    assert.notEqual(result.code, 0)
    assert.equal(failure?.data?.releaseId, "orphaned-candidate")
    assert.equal(failure?.data?.status, "error")
    assert.match(String(failure?.data?.error), /connect ENOENT/)
    assert.match(String(failure?.data?.stack), /Error: connect ENOENT/)
    await assertAttemptResourcesStopped(fixture, records)
    await assert.rejects(() => fs.stat(fixture.socketPath), {code: "ENOENT"})
  } finally {
    await killAttemptProcesses(fixture.lifecyclePath)
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
 * @param {{attemptOwnedProcesses?: boolean, fixedPorts?: boolean, healthGate?: boolean, healthPath?: string, healthTimeoutMs?: number, missingControlParent?: boolean, multiProcessSignal?: boolean, persistState?: boolean}} [options] - Fixture options.
 * @returns {Promise<{configPath: string, gatePath: string, healthGatePath: string, lifecyclePath: string, processPort: number, proxyPort: number, root: string, socketPath: string, startedPath: string, statePath: string, stoppedPath: string}>} Fixture paths.
 */
async function createFixture({attemptOwnedProcesses = false, fixedPorts = false, healthGate = false, healthPath = "/ping", healthTimeoutMs = 1000, missingControlParent = false, multiProcessSignal = false, persistState = false} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-bootstrap-"))
  const socketPath = missingControlParent ? path.join(root, "missing", "control.sock") : path.join(root, "control.sock")
  const statePath = path.join(root, "state.json")
  const startedPath = path.join(root, "started.pid")
  const stoppedPath = path.join(root, "stopped.pid")
  const lifecyclePath = path.join(root, "lifecycle.jsonl")
  const gatePath = path.join(root, "continue.fifo")
  const healthGatePath = path.join(root, "health-ready")
  const configPath = path.join(root, "rollbridge.js")
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`
  const ownedCommand = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(ownedChildPath)}`
  const ownedWebCommand = `exec ${command}`
  const [processPort, proxyPort] = fixedPorts ? await availablePorts(2) : [0, 0]
  const lifecycleEnv = {ROLLBRIDGE_TEST_LIFECYCLE_PATH: lifecyclePath}
  const webEnv = {
    ...(attemptOwnedProcesses ? lifecycleEnv : {}),
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
    ] : attemptOwnedProcesses ? [
      {command: ownedCommand, env: lifecycleEnv, id: "database", policy: "service"},
      {command: ownedCommand, env: lifecycleEnv, id: "worker", policy: "companion"},
      {command: ownedCommand, env: lifecycleEnv, id: "scheduler", policy: "singleton"},
      {command: ownedWebCommand, env: webEnv, health: {path: healthPath, timeoutMs: healthTimeoutMs}, id: "web", policy: "proxied", port: {from: processPort, to: processPort}}
    ] : [{command, env: webEnv, health: {path: healthPath, timeoutMs: healthTimeoutMs}, id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: proxyPort},
    ...(persistState ? {statePath} : {})
  }

  const setup = multiProcessSignal ? "process.env.ROLLBRIDGE_TEST_DAEMON_PID = String(process.pid)\n" : ""

  if (multiProcessSignal) {
    const fifo = spawn("mkfifo", [gatePath])
    const [code] = await once(fifo, "exit")

    assert.equal(code, 0)
  }

  await fs.writeFile(configPath, `${setup}module.exports = ${JSON.stringify(config, null, 2)}\n`)
  return {configPath, gatePath, healthGatePath, lifecyclePath, processPort, proxyPort, root, socketPath, startedPath, statePath, stoppedPath}
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
    try {
      return await fs.readFile(filePath, "utf8")
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
    }

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
 * @param {{attestation?: string, releaseId: string, revision: string}} release - Bootstrap metadata.
 * @returns {import("node:child_process").ChildProcessWithoutNullStreams} Spawned daemon.
 */
function spawnDaemon(fixture, release) {
  const args = [binPath, "daemon", "--config", fixture.configPath, "--release-path", fixture.root, "--release-id", release.releaseId, "--revision", release.revision]

  if (release.attestation) args.push("--boot-attestation", release.attestation)

  return spawn(process.execPath, args, {stdio: ["pipe", "pipe", "pipe"]})
}

/**
 * @param {string[]} args - Daemon arguments.
 * @param {{timeoutMs?: number}} [options] - Process execution options.
 * @returns {Promise<{code: number | null, output: string, stderr: string}>} Completed process result.
 */
async function runDaemon(args, options) {
  return await runRollbridge(["daemon", ...args], options)
}

/**
 * @param {string[]} args - Rollbridge command and arguments.
 * @param {{timeoutMs?: number}} [options] - Process execution options.
 * @returns {Promise<{code: number | null, output: string, stderr: string}>} Completed process result.
 */
async function runRollbridge(args, {timeoutMs} = {}) {
  const child = spawn(process.execPath, [binPath, ...args], {stdio: ["ignore", "pipe", "pipe"]})
  let output = ""
  let stderr = ""

  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  let timer

  const exited = once(child, "exit")
  const result = timeoutMs === undefined ? await exited : await Promise.race([
    exited,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve(["timeout"])
      }, timeoutMs)
    })
  ])

  if (timer) clearTimeout(timer)
  if (result[0] === "timeout") {
    await exited
    throw new Error(`Rollbridge did not terminate within ${timeoutMs}ms`)
  }

  const [code] = result

  return {code: typeof code === "number" || code === null ? code : null, output, stderr}
}

/**
 * @param {string} output - JSON-lines daemon output.
 * @returns {StructuredRecord[]} Parsed records.
 */
function parseStructuredOutput(output) {
  return output.split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

/**
 * @param {{lifecyclePath: string, processPort: number, proxyPort: number}} fixture - Attempt fixture.
 * @param {StructuredRecord[]} records - Structured daemon records.
 * @returns {Promise<void>} Resolves after all owned resources are verified stopped.
 */
async function assertAttemptResourcesStopped(fixture, records) {
  const events = await readLifecycleEvents(fixture.lifecyclePath)
  const started = events.filter((event) => event.event === "started")
  const stoppedPids = new Set(events.filter((event) => event.event === "stopped").map((event) => event.pid))
  const expectedProcessIds = new Set(["database", "scheduler", "web", "worker"])
  const managedStarts = new Set(records.filter((record) => record.message === "process started").map((record) => record.data?.processId))
  const managedExits = new Set(records.filter((record) => record.message === "process exited").map((record) => record.data?.processId))

  assert.deepEqual(managedStarts, expectedProcessIds)
  assert.deepEqual(managedExits, expectedProcessIds)
  for (const event of started) {
    assert.equal(stoppedPids.has(event.pid), true, `${event.processId} must receive graceful shutdown`)
    assert.equal(isProcessAlive(Number(event.pid)), false, `${event.processId} pid ${event.pid} must be gone before daemon exit`)
  }

  await assertPortAvailable(fixture.processPort)
  await assertPortAvailable(fixture.proxyPort)
}

/**
 * @param {string} lifecyclePath - Fixture lifecycle log.
 * @returns {Promise<Record<string, import("../src/json.js").JsonValue>[]>} Parsed lifecycle events.
 */
async function readLifecycleEvents(lifecyclePath) {
  return (await fs.readFile(lifecyclePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

/**
 * Best-effort cleanup for a deliberately failing lingering-process regression.
 * @param {string} lifecyclePath - Fixture lifecycle log.
 * @returns {Promise<void>} Resolves after known fixture process groups are stopped.
 */
async function killAttemptProcesses(lifecyclePath) {
  try {
    const events = await readLifecycleEvents(lifecyclePath)

    for (const event of events) {
      const pid = Number(event.pid)

      if (event.event === "started" && isProcessAlive(pid)) process.kill(-pid, "SIGKILL")
    }
  } catch {
    // The attempt can fail before creating the lifecycle file.
  }
}

/**
 * @param {number} port - Local port expected to be free.
 * @returns {Promise<void>} Resolves after binding and releasing the port.
 */
async function assertPortAvailable(port) {
  const server = net.createServer()

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve(undefined))
  })
  await new Promise((resolve) => server.close(() => resolve(undefined)))
}

/**
 * Reserves distinct ephemeral ports until all have been observed, then releases them.
 * @param {number} count - Number of ports.
 * @returns {Promise<number[]>} Available port numbers.
 */
async function availablePorts(count) {
  const servers = Array.from({length: count}, () => net.createServer())

  await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(undefined))
  })))
  const ports = servers.map((server) => {
    const address = server.address()

    if (!address || typeof address === "string") throw new Error("Expected a TCP server address")
    return address.port
  })

  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))))
  return ports
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
