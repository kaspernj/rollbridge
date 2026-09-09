// @ts-check

import {describe, expect, test} from "@velocious/testing"
import ReleaseGroup from "../src/release-group.js"
import {normalizeConfig} from "../src/config.js"

describe("release-group", () => {

/**
 * @param {import("../src/json.js").JsonValue} webProcess - The single proxied process definition.
 * @param {() => boolean} [shouldStart] - Whether process starts remain allowed.
 * @returns {ReleaseGroup} A release group ready for buildProcess.
 */
function buildRelease(webProcess, shouldStart = () => true) {
  const config = normalizeConfig({
    application: "demo",
    control: {path: "/tmp/rollbridge-release-group.sock"},
    processes: [webProcess],
    proxy: {host: "127.0.0.1", port: 0}
  })

  return new ReleaseGroup({config, logger: () => {}, releaseId: "v1", releasePath: "/tmp/rel", revision: "v1", shouldStart})
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

    expect(managed.command).toBe("run --token from-daemon")
    expect(managed.env.DOWNSTREAM_TOKEN).toBe("from-daemon")
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

  expect(replica.id).toBe("worker#1")
  expect(replica.command).toBe("worker 1/3")
  expect(replica.env.ROLLBRIDGE_REPLICA_INDEX).toBe("1")
  expect(replica.env.ROLLBRIDGE_REPLICA_COUNT).toBe("3")
  expect(replica.env.ROLLBRIDGE_PROCESS_ID).toBe("worker")
  expect(replica.env.SLOT).toBe("1")
})

test("a referenced daemon environment variable that is unset fails fast", async () => {
  const release = buildRelease({
    command: "run {{env.ROLLBRIDGE_ENV_MISSING}}",
    id: "web",
    policy: "proxied",
    port: {from: 0, to: 0}
  })

  delete process.env.ROLLBRIDGE_ENV_MISSING

  await expect(() => release.buildProcess(release.config.processes[0])).toThrow(/Missing template value for \{\{env.ROLLBRIDGE_ENV_MISSING\}\}/)
})

test("committed generation restoration does not start after shutdown begins", async () => {
  const release = buildRelease({command: "run web", id: "web", policy: "proxied", port: {from: 0, to: 0}}, () => false)
  const process = release.buildProcess(release.config.processes[0])
  let starts = 0

  release.state = "draining"
  process.start = async () => {
    starts += 1
    throw new Error("process started after shutdown")
  }
  release.processes.set("web", process)

  await expect(release.restartCommittedGeneration()).rejects.toThrow(/shutting down/)
  expect(starts).toBe(0)
})
})
