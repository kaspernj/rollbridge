// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {clearState, readState, writeState} from "../src/state-store.js"

test("writeState then readState round-trips a snapshot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-state-"))
  const statePath = path.join(dir, "state.json")

  try {
    await writeState(statePath, {activeReleaseId: "v1", releases: [{releaseId: "v1"}]})

    const state = /** @type {{activeReleaseId: string}} */ (await readState(statePath))

    assert.equal(state.activeReleaseId, "v1")
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("readState returns undefined for a missing or unparseable file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-state-"))
  const statePath = path.join(dir, "state.json")

  try {
    assert.equal(await readState(statePath), undefined)

    await fs.writeFile(statePath, "{not json")

    assert.equal(await readState(statePath), undefined)
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("concurrent writes leave a complete, uncorrupted snapshot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-state-"))
  const statePath = path.join(dir, "state.json")

  try {
    await Promise.all([writeState(statePath, {n: 1}), writeState(statePath, {n: 2}), writeState(statePath, {n: 3})])

    const state = /** @type {{n: number}} */ (await readState(statePath))

    // A complete snapshot from one of the writers — never a partial/corrupt file or a temp race.
    assert.ok(state && typeof state.n === "number")
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("clearState removes the file and ignores a missing one", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-state-"))
  const statePath = path.join(dir, "state.json")

  try {
    await writeState(statePath, {ok: true})
    await clearState(statePath)

    assert.equal(await readState(statePath), undefined)
    await clearState(statePath)
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})
