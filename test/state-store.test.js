// @ts-check

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {describe, expect, test} from "@velocious/testing"
import {clearState, readState, writeState} from "../src/state-store.js"

describe("state-store", () => {

test("writeState then readState round-trips a snapshot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-state-"))
  const statePath = path.join(dir, "state.json")

  try {
    await writeState(statePath, {activeReleaseId: "v1", releases: [{releaseId: "v1"}]})

    const state = /** @type {{activeReleaseId: string}} */ (await readState(statePath))

    expect(state.activeReleaseId).toBe("v1")
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("writeState keeps durable guardian capabilities private", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-state-mode-"))
  const statePath = path.join(dir, "state.json")

  try {
    await writeState(statePath, {recovery: {guardian: {token: "private"}}})
    expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600)
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("readState returns undefined for a missing or unparseable file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-state-"))
  const statePath = path.join(dir, "state.json")

  try {
    expect(await readState(statePath)).toBe(undefined)

    await fs.writeFile(statePath, "{not json")

    expect(await readState(statePath)).toBe(undefined)
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
    expect(state && typeof state.n === "number").toBeTruthy()
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

    expect(await readState(statePath)).toBe(undefined)
    await clearState(statePath)
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})
})
