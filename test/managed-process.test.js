// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import ManagedProcess from "../src/managed-process.js"

const crasherPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "crasher.js")

/**
 * Builds a managed process that is never spawned, for exercising output retention directly.
 * @param {number} outputLines - Recent output lines to retain and report.
 * @returns {ManagedProcess} Managed process.
 */
function buildProcess(outputLines) {
  return new ManagedProcess({
    command: "true",
    cwd: undefined,
    env: {},
    id: "web",
    logger: () => {},
    outputLines,
    restartDelayMs: 1000,
    shouldRestart: () => false,
    stopTimeoutMs: 1000
  })
}

/**
 * @param {() => boolean} callback - Probe.
 * @returns {Promise<void>} Resolves once the probe returns true.
 */
async function waitFor(callback) {
  const deadline = Date.now() + 3000

  while (Date.now() < deadline) {
    if (callback()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error("Timed out waiting for condition")
}

test("retains and reports only the configured number of recent output lines", () => {
  const managed = buildProcess(3)

  managed.appendLog("stdout", "a\nb\nc\nd\ne\n")

  const {logs} = managed.status()

  assert.equal(logs.length, 3)
  assert.deepEqual(logs.map((entry) => entry.line), ["c", "d", "e"])
  assert.equal(logs[0].stream, "stdout")
})

test("keeps every output line when fewer than the retention limit are produced", () => {
  const managed = buildProcess(50)

  managed.appendLog("stderr", "one\ntwo\n")

  const {logs} = managed.status()

  assert.deepEqual(logs.map((entry) => entry.line), ["one", "two"])
})

test("reports zeroed restart and uptime fields before the process starts", () => {
  const status = buildProcess(50).status()

  assert.equal(status.restarts, 0)
  assert.equal(status.startedAt, undefined)
  assert.equal(status.uptimeMs, undefined)
  assert.equal(status.state, "stopped")
})

test("counts automatic restarts and reports startedAt and uptime while running", async () => {
  const managed = new ManagedProcess({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(crasherPath)}`,
    cwd: undefined,
    env: {},
    id: "crasher",
    logger: () => {},
    outputLines: 50,
    restartDelayMs: 20,
    shouldRestart: () => true,
    stopTimeoutMs: 500
  })

  try {
    await managed.start()

    const initial = managed.status()

    assert.equal(initial.restarts, 0)
    assert.equal(initial.state, "running")
    assert.equal(typeof initial.startedAt, "string")
    assert.ok(typeof initial.uptimeMs === "number" && initial.uptimeMs >= 0)

    // The fixture exits non-zero ~40ms after each start, so it keeps auto-restarting.
    await waitFor(() => managed.status().restarts >= 2)

    assert.ok(managed.status().restarts >= 2)
  } finally {
    await managed.stop()
  }
})

test("a queued auto-restart timer is unref'd so it can't keep the process alive", async () => {
  const managed = new ManagedProcess({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(crasherPath)}`,
    cwd: undefined,
    env: {},
    id: "crasher",
    logger: () => {},
    outputLines: 50,
    restartDelayMs: 5000,
    shouldRestart: () => true,
    stopTimeoutMs: 500
  })

  try {
    await managed.start()

    // After the fixture crashes a restart is queued. Under the default unlimited restart policy a
    // ref'd timer would respawn forever and block process exit, so the queued timer must be unref'd.
    await waitFor(() => managed.restartTimer !== undefined)

    assert.equal(managed.restartTimer?.hasRef(), false)
  } finally {
    await managed.stop()
  }
})

/**
 * Builds a managed crasher with a specific restart policy.
 * @param {import("../src/config.js").RestartConfig} restart - Restart policy.
 * @returns {ManagedProcess} Managed process.
 */
function buildCrasher(restart) {
  return new ManagedProcess({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(crasherPath)}`,
    cwd: undefined,
    env: {},
    id: "crasher",
    logger: () => {},
    outputLines: 50,
    restart,
    restartDelayMs: 10,
    shouldRestart: () => true,
    stopTimeoutMs: 500
  })
}

test("records the start reason, marking crash auto-restarts", async () => {
  const managed = buildCrasher({backoffFactor: 1, maxDelayMs: 0, maxRestarts: undefined, windowMs: 0})

  try {
    await managed.start()

    assert.equal(managed.status().lastStartReason, "deploy")

    // The fixture crashes ~40ms after each start, so it auto-restarts with reason "crash".
    await waitFor(() => managed.status().restarts >= 1)

    assert.equal(managed.status().lastStartReason, "crash")
  } finally {
    await managed.stop()
  }
})

test("records the manual start reason", async () => {
  // Restarts disabled, so the crash does not overwrite the manual reason.
  const managed = buildCrasher({backoffFactor: 1, maxDelayMs: 0, maxRestarts: 0, windowMs: 0})

  try {
    await managed.start("manual")

    assert.equal(managed.status().lastStartReason, "manual")
  } finally {
    await managed.stop()
  }
})

test("does not record a start reason when the spawn fails", async () => {
  const managed = new ManagedProcess({
    command: "true",
    cwd: "/nonexistent-rollbridge-spawn-dir",
    env: {},
    id: "broken",
    logger: () => {},
    outputLines: 50,
    restartDelayMs: 10,
    shouldRestart: () => false,
    stopTimeoutMs: 500
  })

  // The cwd does not exist, so the spawn fails before the process ever runs.
  await assert.rejects(() => managed.start("manual"))
  assert.equal(managed.status().lastStartReason, undefined)
})

/**
 * Builds a long-lived managed process (stays running until stopped) with a restart gate.
 * @param {() => boolean} shouldRestart - Restart policy callback.
 * @returns {ManagedProcess} Managed process.
 */
function buildLongLived(shouldRestart) {
  return new ManagedProcess({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    cwd: undefined,
    env: {},
    id: "worker",
    logger: () => {},
    outputLines: 50,
    restartDelayMs: 10,
    shouldRestart,
    stopTimeoutMs: 500
  })
}

test("runs quiet and drain lifecycle hooks before stopping", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rollbridge-hooks-"))
  const logPath = path.join(dir, "hooks.log")
  const append = (/** @type {string} */ word) => `${JSON.stringify("/bin/sh")} -c ${JSON.stringify(`echo ${word} >> ${logPath}`)}`
  const managed = new ManagedProcess({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    cwd: undefined,
    env: {},
    id: "worker",
    lifecycle: {drainCommand: append("drain"), drainTimeoutMs: 500, quietCommand: append("quiet")},
    logger: () => {},
    outputLines: 50,
    restartDelayMs: 10,
    shouldRestart: () => false,
    stopSignal: "SIGTERM",
    stopTimeoutMs: 2000
  })

  try {
    await managed.start()
    await managed.stop()

    assert.equal(managed.status().state, "stopped")
    // quietCommand ran, then drainCommand, then the worker was stopped via stopSignal.
    assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), ["quiet", "drain"])
  } finally {
    await managed.stop()
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test("a configured stopCommand is used instead of the stop signal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rollbridge-hooks-"))
  const logPath = path.join(dir, "stop.log")
  const managed = new ManagedProcess({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    cwd: undefined,
    env: {},
    id: "worker",
    // The stop command logs and kills the worker's process group, so no SIGKILL fallback is needed.
    lifecycle: {drainTimeoutMs: 0, stopCommand: `${JSON.stringify("/bin/sh")} -c ${JSON.stringify(`echo stop >> ${logPath}; kill -KILL -$ROLLBRIDGE_PID`)}`},
    logger: () => {},
    outputLines: 50,
    restartDelayMs: 10,
    shouldRestart: () => false,
    stopSignal: "SIGTERM",
    stopTimeoutMs: 2000
  })

  /** @type {string[]} */
  const signals = []
  const killProcessGroup = managed.killProcessGroup.bind(managed)

  managed.killProcessGroup = (signal) => {
    signals.push(signal)
    killProcessGroup(signal)
  }

  try {
    await managed.start()
    await managed.stop()

    assert.equal(managed.status().state, "stopped")
    assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), ["stop"])
    // The stop signal is replaced by the stop command (only a SIGKILL fallback may be sent).
    assert.ok(!signals.includes("SIGTERM"), `expected no stopSignal, got ${signals.join(",")}`)
  } finally {
    await managed.stop()
    fs.rmSync(dir, {force: true, recursive: true})
  }
})

test("a failing lifecycle hook is logged but does not fail the stop", async () => {
  /** @type {string[]} */
  const messages = []
  const managed = new ManagedProcess({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    cwd: undefined,
    env: {},
    id: "worker",
    lifecycle: {drainTimeoutMs: 0, quietCommand: `${JSON.stringify("/bin/sh")} -c "exit 3"`},
    logger: (message) => { messages.push(message) },
    outputLines: 50,
    restartDelayMs: 10,
    shouldRestart: () => false,
    stopSignal: "SIGTERM",
    stopTimeoutMs: 2000
  })

  try {
    await managed.start()
    await managed.stop()

    assert.equal(managed.status().state, "stopped")
    assert.ok(messages.includes("quiet command exited non-zero"), `expected a non-zero hook log, got ${messages.join(",")}`)
  } finally {
    await managed.stop()
  }
})

test("a hanging lifecycle hook is bounded so stop still completes", async () => {
  const managed = new ManagedProcess({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    cwd: undefined,
    env: {},
    id: "worker",
    lifecycle: {drainTimeoutMs: 0, quietCommand: "sleep 30"},
    logger: () => {},
    outputLines: 50,
    restartDelayMs: 10,
    shouldRestart: () => false,
    stopSignal: "SIGTERM",
    stopTimeoutMs: 300
  })

  try {
    await managed.start()

    const startedAt = Date.now()

    await managed.stop()

    assert.equal(managed.status().state, "stopped")
    // The hung quietCommand is killed at stopTimeoutMs rather than blocking stop indefinitely.
    assert.ok(Date.now() - startedAt < 5000, "stop should not wait for the hung hook")
  } finally {
    await managed.stop()
  }
})

test("sends the configured stopSignal as the graceful stop signal", async () => {
  const managed = new ManagedProcess({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    cwd: undefined,
    env: {},
    id: "worker",
    logger: () => {},
    outputLines: 50,
    restartDelayMs: 10,
    shouldRestart: () => false,
    stopSignal: "SIGINT",
    stopTimeoutMs: 500
  })

  /** @type {string[]} */
  const signals = []
  const killProcessGroup = managed.killProcessGroup.bind(managed)

  managed.killProcessGroup = (signal) => {
    signals.push(signal)
    killProcessGroup(signal)
  }

  await managed.start()
  await managed.stop()

  // The graceful stop uses the configured signal (a SIGKILL fallback, if any, comes after).
  assert.equal(signals[0], "SIGINT")
  assert.equal(managed.status().state, "stopped")
})

test("indefinite stop waits for the process to exit without SIGKILL", async () => {
  const managed = new ManagedProcess({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150)); setInterval(() => {}, 1000)")}`,
    cwd: undefined,
    env: {},
    id: "worker",
    logger: () => {},
    outputLines: 50,
    restartDelayMs: 10,
    shouldRestart: () => false,
    stopSignal: "SIGTERM",
    stopTimeoutMs: "indefinite"
  })
  /** @type {string[]} */
  const signals = []
  const killProcessGroup = managed.killProcessGroup.bind(managed)

  managed.killProcessGroup = (signal) => {
    signals.push(signal)
    killProcessGroup(signal)
  }

  try {
    await managed.start()
    await managed.stop()

    assert.equal(managed.status().state, "stopped")
    assert.deepEqual(signals, ["SIGTERM"])
  } finally {
    await managed.stop()
  }
})

test("a memory restart respawns and is counted when the supervisor still wants the process", async () => {
  const managed = buildLongLived(() => true)

  try {
    await managed.start()
    await managed.restartForMemory()

    assert.equal(managed.status().state, "running")
    assert.equal(managed.memoryRestarts, 1)
    assert.equal(managed.status().lastStartReason, "memory")
  } finally {
    await managed.stop()
  }
})

test("a memory restart does not respawn when shouldRestart is false", async () => {
  let allowRestart = true
  const managed = buildLongLived(() => allowRestart)

  try {
    await managed.start()
    assert.equal(managed.status().state, "running")

    // The supervisor (e.g. daemon shutdown or a draining release) no longer wants it running.
    allowRestart = false
    await managed.restartForMemory()

    assert.equal(managed.status().state, "stopped")
    assert.equal(managed.memoryRestarts, 0)
  } finally {
    await managed.stop()
  }
})

test("does not auto-restart when the restart policy is disabled (maxRestarts: 0)", async () => {
  const managed = buildCrasher({backoffFactor: 1, maxDelayMs: 0, maxRestarts: 0, windowMs: 0})

  try {
    await managed.start()

    // The fixture exits ~40ms after start; with restarts disabled it should stay failed.
    await waitFor(() => managed.status().state === "failed")
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.equal(managed.status().restarts, 0)
    assert.equal(managed.status().state, "failed")
  } finally {
    await managed.stop()
  }
})

test("stops auto-restarting once maxRestarts within the window is reached", async () => {
  const managed = buildCrasher({backoffFactor: 1, maxDelayMs: 0, maxRestarts: 2, windowMs: 60000})

  try {
    await managed.start()

    // It restarts at most twice within the window, then gives up and stays failed.
    await waitFor(() => managed.status().restarts === 2 && managed.status().state === "failed")
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.equal(managed.status().restarts, 2)
    assert.equal(managed.status().state, "failed")
  } finally {
    await managed.stop()
  }
})

test("applies exponential backoff to restart delays, capped by maxDelayMs", () => {
  const capped = buildCrasher({backoffFactor: 2, maxDelayMs: 500, maxRestarts: undefined, windowMs: 0})

  // restartDelayMs (10) * 2 ** attempt, capped at 500.
  assert.equal(capped.restartDelayFor(0), 10)
  assert.equal(capped.restartDelayFor(1), 20)
  assert.equal(capped.restartDelayFor(2), 40)
  assert.equal(capped.restartDelayFor(6), 500) // 10 * 64 = 640, capped to 500
  assert.equal(capped.restartDelayFor(7), 500)

  // maxDelayMs: 0 means no cap.
  const uncapped = buildCrasher({backoffFactor: 3, maxDelayMs: 0, maxRestarts: undefined, windowMs: 0})

  assert.equal(uncapped.restartDelayFor(0), 10)
  assert.equal(uncapped.restartDelayFor(2), 90)
})

test("the unlimited constant-delay fast path still applies maxDelayMs", () => {
  // restartDelayMs (10) above maxDelayMs (5), with no backoff and unlimited restarts.
  const managed = buildCrasher({backoffFactor: 1, maxDelayMs: 5, maxRestarts: undefined, windowMs: 0})

  assert.equal(managed.restartDelayFor(0), 5)

  /** @type {number | undefined} */
  let queued

  managed.queueRestart = (delayMs) => { queued = delayMs }
  managed.scheduleRestart()

  assert.equal(queued, 5)
})
