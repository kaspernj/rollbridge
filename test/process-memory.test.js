// @ts-check

import fs from "node:fs"
import {describe, expect, test} from "@velocious/testing"
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

  expect({value: Boolean(typeof rssBytes === "number" && rssBytes > 0), context: `expected a positive RSS, got ${rssBytes}`}).toMatchObject({value: true})
})

linuxTest("returns undefined for a process group with no members", () => {
  expect(measureProcessGroupRssBytes(2147483646)).toBe(undefined)
})

linuxTest("lists process-group members with their command and resident memory", () => {
  const members = processGroupMembers(currentProcessGroupId())
  const self = members.find((member) => member.pid === process.pid)

  if (!self) throw new Error("the current process should be a group member")
  expect(typeof self.rssBytes === "number" && self.rssBytes > 0).toBeTruthy()
  expect(typeof self.command).toBe("string")
})

linuxTest("returns an empty list for a process group with no members", () => {
  expect(processGroupMembers(2147483646)).toEqual([])
})

test("treats a process group containing only defunct members as stopped", () => {
  const procPath = fs.mkdtempSync(path.join(os.tmpdir(), "rollbridge-proc-"))

  try {
    fs.mkdirSync(path.join(procPath, "101"))
    fs.writeFileSync(path.join(procPath, "101", "stat"), "101 (worker) Z 1 77 0 0")

    expect(processGroupHasLiveMembers(77, procPath)).toBe(false)

    fs.mkdirSync(path.join(procPath, "102"))
    fs.writeFileSync(path.join(procPath, "102", "stat"), "102 (worker) S 1 77 0 0")

    expect(processGroupHasLiveMembers(77, procPath)).toBe(true)
  } finally {
    fs.rmSync(procPath, {force: true, recursive: true})
  }
})
})
