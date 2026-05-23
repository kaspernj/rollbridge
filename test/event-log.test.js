// @ts-check

import assert from "node:assert/strict"
import test from "node:test"
import EventLog from "../src/event-log.js"

test("records events with a timestamp, message, and data", () => {
  const log = new EventLog(10)

  log.record("traffic switched", {releaseId: "v1"})

  const [event] = log.recent()

  assert.equal(event.message, "traffic switched")
  assert.deepEqual(event.data, {releaseId: "v1"})
  assert.match(event.at, /^\d{4}-\d{2}-\d{2}T.*Z$/)
})

test("drops the oldest events once the limit is exceeded", () => {
  const log = new EventLog(3)

  for (let index = 0; index < 5; index += 1) log.record("tick", {index})

  const events = log.recent()

  assert.equal(events.length, 3)
  assert.deepEqual(events.map((event) => event.data.index), [2, 3, 4])
})

test("recent(limit) returns only the most recent events, oldest first", () => {
  const log = new EventLog(10)

  for (let index = 0; index < 5; index += 1) log.record("tick", {index})

  assert.deepEqual(log.recent(2).map((event) => event.data.index), [3, 4])
})

test("recent returns every event when the limit is omitted or not a positive number", () => {
  const log = new EventLog(10)

  for (let index = 0; index < 3; index += 1) log.record("tick", {index})

  assert.equal(log.recent().length, 3)
  assert.equal(log.recent(0).length, 3)
  assert.equal(log.recent(99).length, 3)
})
