// @ts-check

import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {once} from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {normalizeConfig} from "../src/config.js"
import {isProcessAlive} from "../src/state-store.js"
import {predeployCleanup} from "../src/predeploy-cleanup.js"

/**
 * @param {string} dir - Working directory.
 * @param {string} marker - Unique process marker.
 * @returns {import("../src/config.js").RollbridgeConfig} Test config.
 */
function buildConfig(dir, marker) {
  return normalizeConfig({
    application: "predeploy-cleanup-test",
    control: {path: path.join(dir, "rollbridge.sock")},
    legacyTakeover: {
      forceStopTimeoutMs: 50,
      processes: [{includes: [marker], name: "legacy marker process"}]
    },
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0}
  })
}

test("predeploy cleanup stops configured legacy process when no daemon is active", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-predeploy-cleanup-"))
  const marker = `legacy-marker-${process.pid}-${Date.now()}`
  const legacy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], {stdio: "ignore"})

  await once(legacy, "spawn")

  try {
    const result = await predeployCleanup({config: buildConfig(dir, marker)})

    assert.equal(result.action, "no-daemon-cleaned")
    assert.equal(result.recoveredOrphans, 0)
    assert.equal(result.legacyProcesses.length, 1)
    assert.equal(result.legacyProcesses[0].pid, legacy.pid)
    assert.ok(legacy.pid === undefined || !isProcessAlive(legacy.pid))
  } finally {
    legacy.kill("SIGKILL")
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("predeploy cleanup leaves legacy processes alone when daemon already has an active release", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-predeploy-cleanup-"))

  try {
    const result = await predeployCleanup({
      config: buildConfig(dir, "unused-marker"),
      inspectSocket: async () => ({
        activeReleaseId: "v1",
        alive: true,
        application: "predeploy-cleanup-test"
      })
    })

    assert.deepEqual(result, {
      action: "daemon-active",
      legacyProcesses: [],
      recoveredOrphans: 0
    })
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})
