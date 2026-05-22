// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import RollbridgeDaemon, {releasesToPrune} from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const dummyAppPath = path.join(currentDir, "fixtures", "dummy-app.js")

test("releasesToPrune keeps the most recent stopped releases and never active or draining ones", () => {
  const releases = [
    {releaseId: "active", state: "active", stoppedAt: undefined},
    {releaseId: "draining", state: "draining", stoppedAt: undefined},
    {releaseId: "v3", state: "stopped", stoppedAt: "2026-05-22T00:00:03.000Z"},
    {releaseId: "v2", state: "stopped", stoppedAt: "2026-05-22T00:00:02.000Z"},
    {releaseId: "v1", state: "stopped", stoppedAt: "2026-05-22T00:00:01.000Z"}
  ]

  const remove = releasesToPrune(releases, {keep: 1, maxAgeMs: 0}, Date.parse("2026-05-22T00:00:10.000Z"))

  assert.deepEqual([...remove].sort(), ["v1", "v2"])
})

test("releasesToPrune prunes stopped releases older than maxAgeMs", () => {
  const now = Date.parse("2026-05-22T00:01:00.000Z")
  const releases = [
    {releaseId: "fresh", state: "stopped", stoppedAt: new Date(now - 1000).toISOString()},
    {releaseId: "old", state: "stopped", stoppedAt: new Date(now - 60000).toISOString()}
  ]

  const remove = releasesToPrune(releases, {keep: 100, maxAgeMs: 30000}, now)

  assert.deepEqual(remove, ["old"])
})

test("the daemon prunes stopped releases beyond the retention count across deploys", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-retention-"))
  const config = normalizeConfig({
    application: "rollbridge-retention-test",
    control: {path: path.join(root, "rollbridge.sock")},
    processes: [
      {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`,
        health: {intervalMs: 50, path: "/ping", timeoutMs: 3000},
        id: "web",
        policy: "proxied",
        port: {from: 0, to: 0}
      }
    ],
    proxy: {drainTimeoutMs: 200, forceStopTimeoutMs: 200, host: "127.0.0.1", port: 0},
    releaseRetention: {keep: 1}
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  try {
    await daemon.deploy({releaseId: "v1", releasePath: root, revision: "v1"})
    await daemon.deploy({releaseId: "v2", releasePath: root, revision: "v2"})
    await daemon.deploy({releaseId: "v3", releasePath: root, revision: "v3"})

    // Older stopped releases are pruned once they drain; keep:1 retains only the most recent stopped one.
    await waitFor(() => !daemon.status().releases.some((release) => release.releaseId === "v1"))

    const ids = daemon.status().releases.map((release) => release.releaseId)

    assert.ok(ids.includes("v3"), `active release should be retained, got ${JSON.stringify(ids)}`)
    assert.ok(!ids.includes("v1"), `oldest stopped release should be pruned, got ${JSON.stringify(ids)}`)
    assert.ok(ids.length <= 2, `expected at most the active release plus one stopped, got ${JSON.stringify(ids)}`)
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

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
