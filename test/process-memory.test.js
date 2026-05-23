// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import {measureProcessGroupRssBytes} from "../src/process-memory.js"

const linuxOnly = process.platform !== "linux" && "requires /proc (Linux)"

test("measures the resident memory of a live process group", {skip: linuxOnly}, () => {
  const stat = fs.readFileSync("/proc/self/stat", "utf8")
  const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2])

  const rssBytes = measureProcessGroupRssBytes(pgrp)

  assert.ok(typeof rssBytes === "number" && rssBytes > 0, `expected a positive RSS, got ${rssBytes}`)
})

test("returns undefined for a process group with no members", {skip: linuxOnly}, () => {
  assert.equal(measureProcessGroupRssBytes(2147483646), undefined)
})
