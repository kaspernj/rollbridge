// @ts-check

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {describe, expect, test} from "@velocious/testing"
import {fileURLToPath} from "node:url"
import RollbridgeDaemon, {releasesToPrune, unusableRetiredReleaseIds} from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"

describe("release-retention", () => {

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

  expect([...remove].sort()).toEqual(["v1", "v2"])
})

test("releasesToPrune keeps the later-deployed release when stoppedAt ties", () => {
  const sameTime = "2026-05-22T00:00:05.000Z"
  // Deploy order (oldest first): v1 then v2, both stopped in the same millisecond.
  const releases = [
    {releaseId: "v1", state: "stopped", stoppedAt: sameTime},
    {releaseId: "v2", state: "stopped", stoppedAt: sameTime}
  ]

  const remove = releasesToPrune(releases, {keep: 1, maxAgeMs: 0}, Date.parse("2026-05-22T00:00:10.000Z"))

  expect(remove).toEqual(["v1"])
})

test("releasesToPrune prunes stopped releases older than maxAgeMs", () => {
  const now = Date.parse("2026-05-22T00:01:00.000Z")
  const releases = [
    {releaseId: "fresh", state: "stopped", stoppedAt: new Date(now - 1000).toISOString()},
    {releaseId: "old", state: "stopped", stoppedAt: new Date(now - 60000).toISOString()}
  ]

  const remove = releasesToPrune(releases, {keep: 100, maxAgeMs: 30000}, now)

  expect(remove).toEqual(["old"])
})

test("unusableRetiredReleaseIds drops a retired release whose directory is gone", () => {
  const releases = [
    {releaseId: "active", releasePath: "/srv/releases/active", state: "active"},
    {releaseId: "gone", releasePath: "/srv/releases/gone", state: "stopped"},
    {releaseId: "kept", releasePath: "/srv/releases/kept", state: "stopped"}
  ]

  const drop = unusableRetiredReleaseIds(releases, (releasePath) => releasePath !== "/srv/releases/gone")

  expect(drop).toEqual(["gone"])
})

test("unusableRetiredReleaseIds drops a retired release parked on another release's directory", () => {
  // Production shape: three ids were registered on one release directory, so the extra two
  // reported a path that disagrees with `dirname(activeReleasePath)/<releaseId>`.
  const releases = [
    {releaseId: "20261023063230", releasePath: "/srv/releases/20261023063230", state: "stopped"},
    {releaseId: "20261023073300", releasePath: "/srv/releases/20261023063230", state: "stopped"},
    {releaseId: "20261023074500", releasePath: "/srv/releases/20261023063230", state: "stopped"}
  ]

  const drop = unusableRetiredReleaseIds(releases, () => true)

  expect([...drop].sort()).toEqual(["20261023073300", "20261023074500"])
})

test("unusableRetiredReleaseIds keeps releases that share a directory no release id names", () => {
  const releases = [
    {releaseId: "v1", releasePath: "/srv/app", state: "stopped"},
    {releaseId: "v2", releasePath: "/srv/app", state: "active"}
  ]

  expect(unusableRetiredReleaseIds(releases, () => true)).toEqual([])
})

test("the daemon refuses to register a release on another release's directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-release-identity-"))
  const releaseA = path.join(root, "releases", "v1")

  await fs.mkdir(releaseA, {recursive: true})

  const config = normalizeConfig({
    application: "rollbridge-release-identity-test",
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
    releaseRetention: {keep: 10}
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  try {
    await daemon.deploy({releaseId: "v1", releasePath: releaseA, revision: "v1"})

    await expect(daemon.deploy({releaseId: "v2", releasePath: releaseA, revision: "v2"}))
      .rejects.toThrow(/is the directory of tracked release v1; refusing to register release v2/u)

    expect(daemon.status().releaseReferences.map((reference) => reference.releaseId)).toEqual(["v1"])
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("the daemon prunes a retired release once its directory is removed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-dead-release-"))
  const releaseA = path.join(root, "releases", "v1")
  const releaseB = path.join(root, "releases", "v2")

  await fs.mkdir(releaseA, {recursive: true})
  await fs.mkdir(releaseB, {recursive: true})

  const config = normalizeConfig({
    application: "rollbridge-dead-release-test",
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
    releaseRetention: {keep: 10}
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  try {
    await daemon.deploy({releaseId: "v1", releasePath: releaseA, revision: "v1"})
    await daemon.deploy({releaseId: "v2", releasePath: releaseB, revision: "v2"})
    await waitFor(() => daemon.status().releases.some((release) => release.releaseId === "v1" && release.state === "stopped"))

    // The deploying tool deletes old release directories; the record must stop being reported even
    // though the retention count would keep it.
    await fs.rm(releaseA, {force: true, recursive: true})
    daemon.pruneStoppedReleases()

    const ids = daemon.status().releases.map((release) => release.releaseId)

    expect({value: !ids.includes("v1"), context: `dead release should be pruned, got ${JSON.stringify(ids)}`}).toMatchObject({value: true})
    expect({value: ids.includes("v2"), context: `active release should stay, got ${JSON.stringify(ids)}`}).toMatchObject({value: true})
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
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

    expect({value: Boolean(ids.includes("v3")), context: `active release should be retained, got ${JSON.stringify(ids)}`}).toMatchObject({value: true})
    expect({value: Boolean(!ids.includes("v1")), context: `oldest stopped release should be pruned, got ${JSON.stringify(ids)}`}).toMatchObject({value: true})
    expect({value: Boolean(ids.length <= 2), context: `expected at most the active release plus one stopped, got ${JSON.stringify(ids)}`}).toMatchObject({value: true})
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
})
