// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs"
import {describe, test} from "@velocious/testing"
import os from "node:os"
import path from "node:path"
import {measureProcessGroupRssBytes, processGroupHasLiveMembers, processGroupMembers} from "../src/process-memory.js"

describe("process-memory", () => {

const linuxTest = process.platform === "linux" ? test : test.skip

/**
 * @returns {number} The current process's group id, read from /proc.
 */
function currentProcessGroupId() {
  const stat = fs.readFileSync("/proc/self/stat", "utf8")

  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2])
}

linuxTest("measures the resident memory of a live process group", () => {
  const rssBytes = measureProcessGroupRssBytes(currentProcessGroupId())

  assert.ok(typeof rssBytes === "number" && rssBytes > 0, `expected a positive RSS, got ${rssBytes}`)
})

linuxTest("returns undefined for a process group with no members", () => {
  assert.equal(measureProcessGroupRssBytes(2147483646), undefined)
})

linuxTest("lists process-group members with their command and resident memory", () => {
  const members = processGroupMembers(currentProcessGroupId())
  const self = members.find((member) => member.pid === process.pid)

  assert.ok(self, "the current process should be a group member")
  assert.ok(typeof self.rssBytes === "number" && self.rssBytes > 0)
  assert.equal(typeof self.command, "string")
})

linuxTest("returns an empty list for a process group with no members", () => {
  assert.deepEqual(processGroupMembers(2147483646), [])
})

test("treats a process group containing only defunct members as stopped", () => {
  const procPath = fs.mkdtempSync(path.join(os.tmpdir(), "rollbridge-proc-"))

  try {
    fs.mkdirSync(path.join(procPath, "101"))
    fs.writeFileSync(path.join(procPath, "101", "stat"), "101 (worker) Z 1 77 0 0")

    assert.equal(processGroupHasLiveMembers(77, procPath), false)

    fs.mkdirSync(path.join(procPath, "102"))
    fs.writeFileSync(path.join(procPath, "102", "stat"), "102 (worker) S 1 77 0 0")

    assert.equal(processGroupHasLiveMembers(77, procPath), true)
  } finally {
    fs.rmSync(procPath, {force: true, recursive: true})
  }
})
})
