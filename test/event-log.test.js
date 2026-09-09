// @ts-check

import {describe, expect, test} from "@velocious/testing"
import EventLog from "../src/event-log.js"

describe("event-log", () => {

test("records events with a timestamp, message, and data", () => {
  const log = new EventLog(10)

  log.record("traffic switched", {releaseId: "v1"})

  const [event] = log.recent()

  expect(event.message).toBe("traffic switched")
  expect(event.data).toEqual({releaseId: "v1"})
  expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
})

test("drops the oldest events once the limit is exceeded", () => {
  const log = new EventLog(3)

  for (let index = 0; index < 5; index += 1) log.record("tick", {index})

  const events = log.recent()

  expect(events.length).toBe(3)
  expect(events.map((event) => event.data.index)).toEqual([2, 3, 4])
})

test("recent(limit) returns only the most recent events, oldest first", () => {
  const log = new EventLog(10)

  for (let index = 0; index < 5; index += 1) log.record("tick", {index})

  expect(log.recent(2).map((event) => event.data.index)).toEqual([3, 4])
})

test("recent returns every event when the limit is omitted or not a positive number", () => {
  const log = new EventLog(10)

  for (let index = 0; index < 3; index += 1) log.record("tick", {index})

  expect(log.recent().length).toBe(3)
  expect(log.recent(0).length).toBe(3)
  expect(log.recent(99).length).toBe(3)
})
})
