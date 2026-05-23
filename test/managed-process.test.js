// @ts-check

import assert from "node:assert/strict"
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
