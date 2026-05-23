// @ts-check

import assert from "node:assert/strict"
import test from "node:test"
import {resolveGroupId, resolveUserId} from "../src/system-ids.js"

const linuxOnly = process.platform !== "linux" && "requires /etc/passwd and /etc/group (Linux)"

test("resolves numeric ids and numeric strings as-is", () => {
  assert.equal(resolveUserId(1000), 1000)
  assert.equal(resolveUserId("1000"), 1000)
  assert.equal(resolveGroupId(0), 0)
  assert.equal(resolveGroupId("42"), 42)
})

test("resolves user and group names to ids", {skip: linuxOnly}, () => {
  assert.equal(resolveUserId("root"), 0)
  assert.equal(resolveGroupId("root"), 0)
})

test("throws for an unknown user or group name", {skip: linuxOnly}, () => {
  assert.throws(() => resolveUserId("rollbridge-no-such-user"), /Unknown user "rollbridge-no-such-user"/)
  assert.throws(() => resolveGroupId("rollbridge-no-such-group"), /Unknown group "rollbridge-no-such-group"/)
})
