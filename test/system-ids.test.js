// @ts-check

import assert from "node:assert/strict"
import {describe, test} from "@velocious/testing"
import {resolveGroupId, resolveUserId} from "../src/system-ids.js"

describe("system-ids", () => {

const linuxTest = process.platform === "linux" ? test : test.skip

test("resolves numeric ids and numeric strings as-is", () => {
  assert.equal(resolveUserId(1000), 1000)
  assert.equal(resolveUserId("1000"), 1000)
  assert.equal(resolveGroupId(0), 0)
  assert.equal(resolveGroupId("42"), 42)
})

linuxTest("resolves user and group names to ids", () => {
  assert.equal(resolveUserId("root"), 0)
  assert.equal(resolveGroupId("root"), 0)
})

linuxTest("throws for an unknown user or group name", () => {
  assert.throws(() => resolveUserId("rollbridge-no-such-user"), /Unknown user "rollbridge-no-such-user"/)
  assert.throws(() => resolveGroupId("rollbridge-no-such-group"), /Unknown group "rollbridge-no-such-group"/)
})
})
