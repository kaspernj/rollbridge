// @ts-check

import {describe, expect, test} from "@velocious/testing"
import RollbridgeDaemon from "../src/daemon.js"
import ReleaseGroup from "../src/release-group.js"
import {normalizeConfig} from "../src/config.js"

describe("stale connection handoff", () => {

/**
 * @param {import("../src/json.js").JsonValue} webProcess - The single proxied process definition.
 * @returns {import("../src/config.js").RollbridgeConfig} A normalized daemon config.
 */
function daemonConfig(webProcess) {
  return normalizeConfig({
    application: "stale-connection-handoff-test",
    control: {path: "/tmp/rollbridge-stale-connection-handoff.sock"},
    processes: [webProcess],
    proxy: {host: "127.0.0.1", port: 0}
  })
}

const webProcess = {
  command: "run web",
  id: "web",
  policy: "proxied",
  port: {from: 0, to: 0}
}

test("the serialized owner handoff never carries a stopped release's stale connection count", () => {
  const daemon = new RollbridgeDaemon({config: daemonConfig(webProcess), logger: () => {}})
  const release = new ReleaseGroup({
    config: daemon.config,
    logger: () => {},
    releaseId: "stopped-v1",
    releasePath: "/tmp/stopped-v1",
    revision: "stopped-v1"
  })

  release.state = "stopped"
  // Frozen drain-timeout count that a prior owner persisted (the 062147 incident shape).
  release.setTransferredConnections({http: 14, websocket: 0})
  daemon.releases.set(release.releaseId, release)
  daemon.setListenerConnectionSource("incumbent-listener", release.releaseId, {http: 14, websocket: 0})

  expect(daemon.serializedListenerConnectionSources()).toEqual({})
})

test("a successor daemon reconciles a stale report for an unretained release instead of failing the handoff", () => {
  const logs = /** @type {{message: string, data?: Record<string, import("../src/json.js").JsonValue>}[]} */ ([])
  const daemon = new RollbridgeDaemon({
    config: daemonConfig(webProcess),
    logger: (message, data) => {
      logs.push({message, data})
    }
  })

  // The candidate daemon does not rehydrate the stopped release; the incumbent's handoff
  // still reports a nonzero count for it.
  expect(() => daemon.setListenerConnectionSource("incumbent-listener", "062147", {http: 14, websocket: 0})).not.toThrow()

  expect(daemon.serializedListenerConnectionSources()).toEqual({})
  expect(logs.some((entry) => entry.message === "dropping stale connection state for unretained release")).toBe(true)
})

test("live release connection counts still cross the owner handoff", () => {
  const daemon = new RollbridgeDaemon({config: daemonConfig(webProcess), logger: () => {}})
  const release = new ReleaseGroup({
    config: daemon.config,
    logger: () => {},
    releaseId: "active-v2",
    releasePath: "/tmp/active-v2",
    revision: "active-v2"
  })

  release.state = "active"
  daemon.releases.set(release.releaseId, release)
  daemon.setListenerConnectionSource("incumbent-listener", release.releaseId, {http: 3, websocket: 1})

  // The incumbent's live counts must still cross the handoff so the successor can adopt them.
  expect(daemon.serializedListenerConnectionSources()).toEqual({"incumbent-listener": {"active-v2": {http: 3, websocket: 1}}})
  expect(release.status().connections).toEqual({http: 3, websocket: 1})
})
})
