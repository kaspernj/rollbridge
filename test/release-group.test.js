// @ts-check

import assert from "node:assert/strict"
import test from "node:test"
import ReleaseGroup from "../src/release-group.js"
import {normalizeConfig} from "../src/config.js"

/**
 * @param {import("../src/json.js").JsonValue} webProcess - The single proxied process definition.
 * @returns {ReleaseGroup} A release group ready for buildProcess.
 */
function buildRelease(webProcess) {
  const config = normalizeConfig({
    application: "demo",
    control: {path: "/tmp/rollbridge-release-group.sock"},
    processes: [webProcess],
    proxy: {host: "127.0.0.1", port: 0}
  })

  return new ReleaseGroup({config, logger: () => {}, releaseId: "v1", releasePath: "/tmp/rel", revision: "v1"})
}

test("templates interpolate values from the daemon environment", () => {
  const release = buildRelease({
    command: "run --token {{env.ROLLBRIDGE_ENV_TEST}}",
    env: {DOWNSTREAM_TOKEN: "{{env.ROLLBRIDGE_ENV_TEST}}"},
    id: "web",
    policy: "proxied",
    port: {from: 0, to: 0}
  })

  process.env.ROLLBRIDGE_ENV_TEST = "from-daemon"

  try {
    const managed = release.buildProcess(release.config.processes[0])

    assert.equal(managed.command, "run --token from-daemon")
    assert.equal(managed.env.DOWNSTREAM_TOKEN, "from-daemon")
  } finally {
    delete process.env.ROLLBRIDGE_ENV_TEST
  }
})

test("replica processes get a replica index, count, and template context", () => {
  const config = normalizeConfig({
    application: "demo",
    control: {path: "/tmp/rollbridge-release-group.sock"},
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 0, to: 0}},
      {command: "worker {{replicaIndex}}/{{replicaCount}}", env: {SLOT: "{{replicaIndex}}"}, id: "worker", policy: "companion", replicas: 3}
    ],
    proxy: {host: "127.0.0.1", port: 0}
  })
  const release = new ReleaseGroup({config, logger: () => {}, releaseId: "v1", releasePath: "/tmp/rel", revision: "v1"})
  const workerConfig = release.config.processes[1]
  const replica = release.buildProcess(workerConfig, {count: 3, index: 1, instanceId: "worker#1"})

  assert.equal(replica.id, "worker#1")
  assert.equal(replica.command, "worker 1/3")
  assert.equal(replica.env.ROLLBRIDGE_REPLICA_INDEX, "1")
  assert.equal(replica.env.ROLLBRIDGE_REPLICA_COUNT, "3")
  assert.equal(replica.env.ROLLBRIDGE_PROCESS_ID, "worker")
  assert.equal(replica.env.SLOT, "1")
})

test("a referenced daemon environment variable that is unset fails fast", () => {
  const release = buildRelease({
    command: "run {{env.ROLLBRIDGE_ENV_MISSING}}",
    id: "web",
    policy: "proxied",
    port: {from: 0, to: 0}
  })

  delete process.env.ROLLBRIDGE_ENV_MISSING

  assert.throws(
    () => release.buildProcess(release.config.processes[0]),
    /Missing template value for \{\{env.ROLLBRIDGE_ENV_MISSING\}\}/
  )
})
