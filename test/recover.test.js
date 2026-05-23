// @ts-check

import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {once} from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"
import {recoverOrphans} from "../src/recover.js"
import {isProcessAlive, readState, writeState} from "../src/state-store.js"

/**
 * @param {string} dir - Working directory.
 * @param {{statePath?: string}} [options] - Config options.
 * @returns {import("../src/config.js").RollbridgeConfig} Normalized config.
 */
function buildConfig(dir, {statePath} = {}) {
  return normalizeConfig({
    application: "recover-test",
    control: {path: path.join(dir, "rollbridge.sock")},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {forceStopTimeoutMs: 1000, host: "127.0.0.1", port: 0},
    ...(statePath ? {statePath} : {})
  })
}

/**
 * @returns {Promise<import("node:child_process").ChildProcess>} A detached, long-lived process (its own group leader).
 */
async function spawnOrphan() {
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {detached: true, stdio: "ignore"})

  await once(orphan, "spawn")

  return orphan
}

/**
 * @param {string} statePath - State file path.
 * @param {number | undefined} pid - Orphan pid to record.
 * @returns {Promise<void>} Resolves once written.
 */
async function writeOrphanState(statePath, pid) {
  await writeState(statePath, {activeReleaseId: "v1", releases: [{processes: [{id: "worker", pid}], releaseId: "v1"}], services: [], singletons: []})
}

/**
 * @param {() => boolean} probe - Condition to await.
 * @returns {Promise<void>} Resolves once the probe returns true.
 */
async function waitFor(probe) {
  const deadline = Date.now() + 3000

  while (Date.now() < deadline) {
    if (probe()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error("Timed out waiting for condition")
}

test("recover requires a configured statePath", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-recover-"))

  try {
    const result = await recoverOrphans({config: buildConfig(dir), force: true})

    assert.ok("error" in result && /statePath/.test(result.error))
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("recover lists orphans without stopping them unless forced", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-recover-"))
  const statePath = path.join(dir, "state.json")
  const orphan = await spawnOrphan()

  try {
    await writeOrphanState(statePath, orphan.pid)

    const result = await recoverOrphans({config: buildConfig(dir, {statePath}), force: false})

    assert.ok(!("error" in result))
    assert.equal(result.forced, false)
    assert.equal(result.cleared, false)
    assert.deepEqual(result.remaining, [])
    assert.equal(result.orphans.length, 1)
    assert.equal(result.orphans[0].pid, orphan.pid)
    assert.ok(orphan.pid !== undefined && isProcessAlive(orphan.pid), "the orphan must not be stopped by a dry run")
    assert.ok(await readState(statePath), "a dry run must not clear the state file")
  } finally {
    orphan.kill("SIGKILL")
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("recover --force stops orphan process groups and clears the state file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-recover-"))
  const statePath = path.join(dir, "state.json")
  const orphan = await spawnOrphan()

  try {
    await writeOrphanState(statePath, orphan.pid)

    const result = await recoverOrphans({config: buildConfig(dir, {statePath}), force: true})

    assert.ok(!("error" in result))
    assert.equal(result.forced, true)
    assert.equal(result.cleared, true)
    assert.deepEqual(result.remaining, [])
    await waitFor(() => orphan.pid === undefined || !isProcessAlive(orphan.pid))
    assert.equal(await readState(statePath), undefined, "the state file is cleared after a forced recovery")
  } finally {
    orphan.kill("SIGKILL")
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("recover --force keeps the state file when an orphan cannot be stopped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-recover-"))
  const statePath = path.join(dir, "state.json")
  const orphan = await spawnOrphan()

  try {
    await writeOrphanState(statePath, orphan.pid)

    // Simulate an orphan that can't be signaled (for example owned by another user): stopGroup
    // reports it is still alive.
    const result = await recoverOrphans({config: buildConfig(dir, {statePath}), force: true, stopGroup: async () => false})

    assert.ok(!("error" in result))
    assert.equal(result.forced, true)
    assert.equal(result.cleared, false, "the state file is kept when an orphan survives")
    assert.equal(result.remaining.length, 1)
    assert.equal(result.remaining[0].pid, orphan.pid)
    assert.ok(await readState(statePath), "the state file must remain so the operator can retry")
  } finally {
    orphan.kill("SIGKILL")
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("recover refuses while a daemon is running", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-recover-"))
  const config = buildConfig(dir, {statePath: path.join(dir, "state.json")})
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  try {
    const result = await recoverOrphans({config, force: true})

    assert.ok("error" in result && /is using/.test(result.error))
  } finally {
    await daemon.shutdown()
    await fs.rm(dir, {force: true, recursive: true})
  }
})
