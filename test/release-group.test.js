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

test("stopping a release abandons its connection count instead of persisting a stale drain timeout", async () => {
  const release = buildRelease({command: "run web", id: "web", policy: "proxied", port: {from: 0, to: 0}})
  // In-flight connections whose response never completes (a drain timeout) hold the count.
  const stuck = [0, 1, 2, 3].map(() => release.retainConnection("http"))

  expect(release.connectionCount).toBe(4)

  await release.stop()

  expect(stuck).toHaveLength(4)
  expect(release.state).toBe("stopped")
  expect(release.status().connectionCount).toBe(0)
  expect(release.localConnections()).toEqual({http: 0, websocket: 0})
})

test("restoring a stopped release does not re-adopt a stale connection count", async () => {
  const release = buildRelease({command: "run web", id: "web", policy: "proxied", port: {from: 0, to: 0}})

  const processStatus = /** @type {import("../src/managed-process.js").ManagedProcessStatus} */ ({
    children: [],
    command: "run web",
    cwd: "/tmp/rel",
    exitCode: 143,
    exitSignal: "SIGTERM",
    id: "web",
    lastMemoryRestartAt: undefined,
    lastStartReason: "deploy",
    logs: [],
    memoryRestarts: 0,
    pid: undefined,
    restarts: 0,
    rssBytes: undefined,
    startedAt: "2026-10-08T06:22:23.500Z",
    state: "stopped",
    uptimeMs: 900000
  })

  await release.restore({
    activatedAt: "2026-10-08T06:22:23.583Z",
    connectionCount: 14,
    connections: {http: 14, websocket: 0},
    drainStartedAt: "2026-10-08T07:58:00.464Z",
    ports: {web: 4200},
    processes: [processStatus],
    releaseId: "v1",
    releasePath: "/tmp/rel",
    retirementError: undefined,
    revision: "v1",
    state: "stopped",
    stoppedAt: "2026-10-08T08:28:02.005Z"
  }, {synchronizeLifecycleRole: false})

  expect(release.state).toBe("stopped")
  expect(release.status().connectionCount).toBe(0)
  expect(release.localConnections()).toEqual({http: 0, websocket: 0})
})
})
