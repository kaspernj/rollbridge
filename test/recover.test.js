// @ts-check

import {spawn} from "node:child_process"
import net from "node:net"
import {once} from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {describe, expect, test} from "@velocious/testing"
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"
import {recoverOrphans} from "../src/recover.js"
import {isProcessAlive, readState, writeState} from "../src/state-store.js"

describe("recover", () => {

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

    expect("error" in result && /statePath/.test(result.error)).toBeTruthy()
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

    if ("error" in result) throw new Error(`Recovery failed: ${result.error}`)
    expect(result.forced).toBe(false)
    expect(result.cleared).toBe(false)
    expect(result.remaining).toEqual([])
    expect(result.orphans.length).toBe(1)
    expect(result.orphans[0].pid).toBe(orphan.pid)
    // The orphan must not be stopped by a dry run.
    expect(orphan.pid !== undefined && isProcessAlive(orphan.pid)).toBeTruthy()
    // A dry run must not clear the state file.
    expect(await readState(statePath)).toBeTruthy()
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

    if ("error" in result) throw new Error(`Recovery failed: ${result.error}`)
    expect(result.forced).toBe(true)
    expect(result.cleared).toBe(true)
    expect(result.remaining).toEqual([])
    await waitFor(() => orphan.pid === undefined || !isProcessAlive(orphan.pid))
    // The state file is cleared after a forced recovery.
    expect(await readState(statePath)).toBe(undefined)
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

    if ("error" in result) throw new Error(`Recovery failed: ${result.error}`)
    expect(result.forced).toBe(true)
    // The state file is kept when an orphan survives.
    expect(result.cleared).toBe(false)
    expect(result.remaining.length).toBe(1)
    expect(result.remaining[0].pid).toBe(orphan.pid)
    // The state file must remain so the operator can retry.
    expect(await readState(statePath)).toBeTruthy()
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

    expect("error" in result && /is using/.test(result.error)).toBeTruthy()
  } finally {
    await daemon.shutdown()
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("recover archives a state naming a dead guardian once every orphan is stopped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-recover-"))

  try {
    const statePath = path.join(dir, "rollbridge-state.json")
    const guardianSocketPath = `${statePath}.guardian.sock`
    const orphan = await spawnOrphan()
    const orphanPid = orphan.pid ?? 0
    const deadPid = await spawnDeadPid()
    const listener = net.createServer()

    await once(listener.listen(guardianSocketPath), "listening")
    await new Promise((resolve) => listener.close(resolve))

    await writeState(statePath, {
      activeReleaseId: "v1",
      recovery: {
        configDigest: "digest",
        format: 1,
        guardian: {pid: deadPid, socketPath: guardianSocketPath, token: "token"},
        reconnectGraceMs: 30000
      },
      releases: [{processes: [{id: "worker", pid: orphanPid}], releaseId: "v1"}],
      services: [],
      singletons: []
    })

    const result = await recoverOrphans({config: buildConfig(dir, {statePath}), force: true})

    expect("error" in result).toBeFalse()

    if ("error" in result) return

    expect(result.forced).toEqual(true)
    expect(result.archived).toEqual(true)
    expect(result.deadGuardianState).toEqual(true)
    expect(result.archivePath).toBeTruthy()
    expect(result.remaining).toEqual([])

    const archiveBytes = await fs.readFile(/** @type {string} */ (result.archivePath), "utf8")

    expect(JSON.parse(archiveBytes).activeReleaseId).toEqual("v1")
    await expectMissing(statePath)
    await expectMissing(guardianSocketPath)
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("recover leaves the state alone when a guardian listener is still live", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-recover-"))

  try {
    const statePath = path.join(dir, "rollbridge-state.json")
    const guardianSocketPath = `${statePath}.guardian.sock`
    const listener = net.createServer()

    await once(listener.listen(guardianSocketPath), "listening")

    try {
      await writeState(statePath, {
        activeReleaseId: "v1",
        recovery: {
          configDigest: "digest",
          format: 1,
          guardian: {socketPath: guardianSocketPath, token: "token"},
          reconnectGraceMs: 30000
        },
        releases: [],
        services: [],
        singletons: []
      })

      const result = await recoverOrphans({config: buildConfig(dir, {statePath}), force: true})

      expect("error" in result).toBeFalse()

      if ("error" in result) return

      expect(result.archived).toEqual(false)
      expect(result.deadGuardianState).toEqual(false)
      expect(result.cleared).toEqual(true)
    } finally {
      await new Promise((resolve) => listener.close(resolve))
    }
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

/**
 * @returns {Promise<number>} The pid of a process that has exited.
 */
async function spawnDeadPid() {
  const child = spawn(process.execPath, ["-e", "true"], {detached: true, stdio: "ignore"})
  const pid = child.pid ?? 0

  await once(child, "exit")
  await waitFor(() => !isProcessAlive(pid))

  return pid
}

/**
 * @param {string} targetPath - Path that must no longer exist.
 * @returns {Promise<void>} Resolves when the path is gone.
 */
async function expectMissing(targetPath) {
  try {
    await fs.access(targetPath)
  } catch {
    return
  }

  throw new Error(`Expected ${targetPath} to be gone`)
}

})
