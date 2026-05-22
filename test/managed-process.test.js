// @ts-check

import assert from "node:assert/strict"
import test from "node:test"
import ManagedProcess from "../src/managed-process.js"

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
