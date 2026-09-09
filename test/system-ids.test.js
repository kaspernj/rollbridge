// @ts-check

import {describe, expect, test} from "@velocious/testing"
import {resolveGroupId, resolveUserId} from "../src/system-ids.js"

describe("system-ids", () => {

const linuxTest = process.platform === "linux" ? test : test.skip

test("resolves numeric ids and numeric strings as-is", () => {
  expect(resolveUserId(1000)).toBe(1000)
  expect(resolveUserId("1000")).toBe(1000)
  expect(resolveGroupId(0)).toBe(0)
  expect(resolveGroupId("42")).toBe(42)
})

linuxTest("resolves user and group names to ids", () => {
  expect(resolveUserId("root")).toBe(0)
  expect(resolveGroupId("root")).toBe(0)
})

linuxTest("throws for an unknown user or group name", async () => {
  await expect(() => resolveUserId("rollbridge-no-such-user")).toThrow(/Unknown user "rollbridge-no-such-user"/)
  await expect(() => resolveGroupId("rollbridge-no-such-group")).toThrow(/Unknown group "rollbridge-no-such-group"/)
})
})
