// @ts-check

import {spawn} from "node:child_process"
import {once} from "node:events"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import {describe, expect, test} from "@velocious/testing"
import {fileURLToPath, pathToFileURL} from "node:url"
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"
import {sendControlCommand} from "../src/control-client.js"
import {liveProcesses, readState, writeState} from "../src/state-store.js"
import {runCli} from "../src/cli.js"

describe("rollbridge", () => {

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const binPath = path.join(currentDir, "..", "bin", "rollbridge")
const dependentAppPath = path.join(currentDir, "fixtures", "dependent-app.js")
const dummyAppPath = path.join(currentDir, "fixtures", "dummy-app.js")
const memoryHogPath = path.join(currentDir, "fixtures", "memory-hog.js")
const serviceAppPath = path.join(currentDir, "fixtures", "service-app.js")
const singletonAppPath = path.join(currentDir, "fixtures", "singleton-app.js")
const linuxTest = process.platform === "linux" ? test : test.skip

test("a nonBlockingDrain worker stops immediately while its release is still draining", async () => {
  const fixture = await createFixture({nonBlockingDrainWorker: true})
  const daemon = await startDaemon(fixture.config)
  /** @type {WebSocket | undefined} */
  let socket

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // An open WebSocket keeps v1's connection drain pending after v2 takes over.
    socket = await openWebSocket(daemon)
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    // The nonBlockingDrain worker is stopped right away, in parallel with the connection drain.
    await waitFor(() => {
      const draining = daemon.status().releases.find((release) => release.releaseId === "v1")

      return draining?.processes.find((processStatus) => processStatus.id === "worker")?.state === "stopped"
    })

    const v1 = statusRelease(daemon, "v1")

    // The release is still draining (the WebSocket is held) and its proxied process is still
    // serving, but the worker has already drained.
    expect(v1.state).toBe("draining")
    expect(v1.processes.find((processStatus) => processStatus.id === "web")?.state).toBe("running")
    expect(v1.processes.find((processStatus) => processStatus.id === "worker")?.state).toBe("stopped")
  } finally {
    if (socket) socket.close()
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("deploy switches new HTTP traffic while old WebSockets drain", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    expect(await fetchText(daemon, "/release")).toBe("v1")

    const websocket = await openWebSocket(daemon)

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    expect(await fetchText(daemon, "/release")).toBe("v2")

    const drainingRelease = statusRelease(daemon, "v1")
    expect(drainingRelease.state).toBe("draining")
    expect(drainingRelease.connections.websocket).toBe(1)

    websocket.close()
    await waitFor(async () => statusRelease(daemon, "v1").state === "stopped")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("failed health check leaves the previous release active", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "good", releasePath: fixture.root, revision: "good"})

    await expect(daemon.deploy({releaseId: "bad", releasePath: fixture.root, revision: "bad"})).rejects.toThrow(/Health check failed/)

    expect(await fetchText(daemon, "/release")).toBe("good")
    expect(daemon.status().activeReleaseId).toBe("good")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("deploy reloads process config and retires the previous worker with the refreshed timeout", async () => {
  const fixture = await createFixture({nonBlockingDrainWorker: true, workerStopDelayMs: 10000})
  const initialConfig = normalizeConfig({
    ...fixture.config,
    processes: fixture.config.processes.map((processConfig) => processConfig.id === "worker"
      ? {...processConfig, gracefulStopMs: "indefinite"}
      : processConfig)
  })
  const configPath = await writeConfigFile(initialConfig, fixture.root)
  const daemon = new RollbridgeDaemon({config: initialConfig, configPath, logger: () => {}})

  try {
    await daemon.start()
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const refreshedConfig = normalizeConfig({
      ...initialConfig,
      processes: initialConfig.processes.map((processConfig) => processConfig.id === "worker"
        ? {...processConfig, gracefulStopMs: 50}
        : processConfig)
    })

    await writeConfigFile(refreshedConfig, fixture.root)
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    await waitFor(() => statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "worker")?.state === "stopped", 1000)

    expect(daemon.config.processes.find((processConfig) => processConfig.id === "worker")?.gracefulStopMs).toBe(50)
    expect(await fetchText(daemon, "/release")).toBe("v2")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("deploy rejects a reloaded config that changes the running proxy", async () => {
  const fixture = await createFixture()
  const configPath = await writeConfigFile(fixture.config, fixture.root)
  const daemon = new RollbridgeDaemon({config: fixture.config, configPath, logger: () => {}})

  try {
    await daemon.start()
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await writeConfigFile(normalizeConfig({
      ...fixture.config,
      proxy: {...fixture.config.proxy, host: "0.0.0.0"}
    }), fixture.root)

    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow(/proxy\.host.*restart the Rollbridge daemon/)
    expect(daemon.status().activeReleaseId).toBe("v1")
    expect(await fetchText(daemon, "/release")).toBe("v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("a failed deploy does not adopt reloaded process config", async () => {
  const fixture = await createFixture()
  const configPath = await writeConfigFile(fixture.config, fixture.root)
  const daemon = new RollbridgeDaemon({config: fixture.config, configPath, logger: () => {}})

  try {
    await daemon.start()
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const failingConfig = normalizeConfig({
      ...fixture.config,
      processes: fixture.config.processes.map((processConfig) => processConfig.id === "web"
        ? {...processConfig, health: {...processConfig.health, path: "/not-ready", timeoutMs: 100}}
        : processConfig)
    })

    await writeConfigFile(failingConfig, fixture.root)
    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow(/Health check failed/)

    expect(daemon.config.processes.find((processConfig) => processConfig.id === "web")?.health?.path).toBe("/ping")
    expect(daemon.status().activeReleaseId).toBe("v1")
    expect(await fetchText(daemon, "/release")).toBe("v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("wildcard proxy bind host targets release processes through loopback", async () => {
  const fixture = await createFixture({proxyHost: "0.0.0.0"})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const status = daemon.status()
    const release = statusRelease(daemon, "v1")

    if (!daemon.activeRelease) throw new Error("expected active release")
    expect(status.proxy.host).toBe("0.0.0.0")
    expect(status.proxy.upstreamHost).toBe("127.0.0.1")
    expect(daemon.activeRelease.proxyTarget().target).toBe(`http://127.0.0.1:${release.ports.web}`)
    expect(await fetchText(daemon, "/release")).toBe("v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("failed release startup logs process output and cleanup status", async () => {
  const fixture = await createFixture({handoffService: true, webCommand: `${JSON.stringify(process.execPath)} -e "console.log('startup stdout'); console.error('startup stderr'); const http = require('node:http'); http.createServer((_request, response) => { response.writeHead(500); response.end('bad') }).listen(Number(process.env.ROLLBRIDGE_PORT), '127.0.0.1')"`, webHealthTimeoutMs: 500})
  /** @type {Array<{data?: Record<string, import("../src/json.js").JsonValue>, message: string}>} */
  const logs = []
  const daemon = new RollbridgeDaemon({
    config: fixture.config,
    logger: (message, data = {}) => logs.push({data, message})
  })

  await daemon.start()

  try {
    await expect(daemon.deploy({releaseId: "bad", releasePath: fixture.root, revision: "bad"})).rejects.toThrow(/Health check failed/)

    const processStatusLog = logs.find((entry) => entry.message === "release startup process status" && entry.data?.phase === "before cleanup" && entry.data?.processId === "web")
    const cleanupProcessStatusLog = logs.find((entry) => entry.message === "release startup process status" && entry.data?.phase === "after cleanup" && entry.data?.processId === "web")
    const handoffServiceStatusLog = logs.find((entry) => entry.message === "release startup process status" && entry.data?.phase === "after cleanup" && entry.data?.processId === "beacon")

    if (!processStatusLog) throw new Error("expected failed web process diagnostics to be logged")
    if (!processStatusLog.data) throw new Error("expected diagnostic data")
    if (!Array.isArray(processStatusLog.data.logs)) throw new Error("expected retained process output in diagnostics")
    expect(processStatusLog.data.logs.some((entry) => typeof entry === "object" && entry && "line" in entry && entry.line === "startup stdout")).toBeTruthy()
    expect(processStatusLog.data.logs.some((entry) => typeof entry === "object" && entry && "line" in entry && entry.line === "startup stderr")).toBeTruthy()
    expect(processStatusLog.data.state).toBe("running")
    if (!cleanupProcessStatusLog) throw new Error("expected failed web cleanup diagnostics to be logged")
    expect(cleanupProcessStatusLog.data?.state).toBe("stopped")
    expect(cleanupProcessStatusLog.data?.exitSignal).toBe("SIGTERM")
    if (!handoffServiceStatusLog) throw new Error("expected handoff service cleanup diagnostics to be logged")
    expect(handoffServiceStatusLog.data?.state).toBe("stopped")
    expect(handoffServiceStatusLog.data?.exitSignal).toBe("SIGTERM")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("singleton processes restart without overlap during deploy", async () => {
  const fixture = await createFixture({includeSingleton: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await waitFor(async () => (await processEvents(fixture.singletonLogPath)).some((event) => event.event === "start" && event.releaseId === "v1"))

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    await waitFor(async () => {
      const events = await processEvents(fixture.singletonLogPath)

      return events.some((event) => event.event === "stop" && event.releaseId === "v1") &&
        events.some((event) => event.event === "start" && event.releaseId === "v2")
    })

    const status = daemon.status()

    expect(status.singletons.length).toBe(1)
    expect(status.singletons[0].process.state).toBe("running")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("candidate activation quiesces the old jobs generation before a blocked singleton replacement completes", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceQuiet: true, includeSingleton: true, webDependsOnService: true})
  const singletonGatePath = path.join(fixture.root, "singleton-replacement.gate")
  const singletonQuietPath = path.join(fixture.root, "singleton-replacement.quiet")
  const fifo = spawn("mkfifo", [singletonGatePath])

  await once(fifo, "exit")

  const config = normalizeConfig({
    ...fixture.config,
    processes: fixture.config.processes.map((processConfig) => processConfig.id === "jobs-main"
      ? {...processConfig, lifecycle: {quietCommand: `printf 'quiet\\n' > ${JSON.stringify(singletonQuietPath)}; read -r _ < ${JSON.stringify(singletonGatePath)}`}}
      : processConfig)
  })
  const daemon = await startDaemon(config)
  /** @type {Promise<Record<string, import("../src/json.js").JsonValue>> | undefined} */
  let deployPromise
  let singletonGateReleased = false

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const abortController = new AbortController()
    const changes = fs.watch(fixture.root, {signal: abortController.signal})
    const singletonReplacementBlocked = (async () => {
      try {
        for await (const change of changes) {
          if (change.filename === path.basename(singletonQuietPath)) return
        }
      } finally {
        abortController.abort()
      }
    })()

    deployPromise = daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    let deploySettled = false

    void deployPromise.then(() => { deploySettled = true }, () => { deploySettled = true })
    await singletonReplacementBlocked
    await Promise.resolve()

    // Candidate traffic must already be active.
    expect(daemon.status().activeReleaseId).toBe("v2")
    // Deploy must remain pending on singleton replacement.
    expect(deploySettled).toBe(false)
    // Old jobs-main must quiesce before singleton replacement completes.
    expect(await fs.readFile(fixture.serviceQuietPath, "utf8")).toBe("v1\n")

    await fs.writeFile(singletonGatePath, "continue\n")
    singletonGateReleased = true
    await deployPromise
  } finally {
    if (deployPromise && !singletonGateReleased) {
      await fs.writeFile(singletonGatePath, "continue\n")
      await deployPromise.catch(() => {})
    }

    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("a failed singleton replacement surfaces the error after stopping the old singleton", async () => {
  // The singleton's working directory is per-release; only the v1 directory exists, so
  // the v2 replacement cannot spawn (ENOENT on cwd) and its start() rejects.
  const fixture = await createFixture({includeSingleton: true, singletonCwd: "{{releasePath}}/{{releaseId}}"})
  const daemon = await startDaemon(fixture.config)

  await fs.mkdir(path.join(fixture.root, "v1"))

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await waitFor(async () => (await processEvents(fixture.singletonLogPath)).some((event) => event.event === "start" && event.releaseId === "v1"))

    // The new release's singleton fails to start, so the deploy surfaces the error.
    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow()

    // The old singleton is stopped before the new one is started, so two copies never
    // overlap — even when the replacement then fails.
    await waitFor(async () => (await processEvents(fixture.singletonLogPath)).some((event) => event.event === "stop" && event.releaseId === "v1"))

    const status = daemon.status()

    // Traffic switches before singletons are replaced, so the new release is already active,
    // but its singleton is left failed with no replacement running.
    expect(status.activeReleaseId).toBe("v2")
    expect(status.singletons.length).toBe(1)
    expect(status.singletons[0].process.state).toBe("failed")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("service processes start before releases and restart with the latest deploy template", async () => {
  const fixture = await createFixture({includeService: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await waitFor(async () => (await processEvents(fixture.serviceLogPath)).some((event) => event.event === "start" && event.releaseId === "v1"))

    const firstServiceStatus = daemon.status().services[0].process

    expect(firstServiceStatus.pid).toBeTruthy()
    expect(firstServiceStatus.command).toMatch(/v1/)

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    const secondServiceStatus = daemon.status().services[0].process

    expect(secondServiceStatus.pid).toBe(firstServiceStatus.pid)
    expect(secondServiceStatus.command).toMatch(/v2/)

    process.kill(-Number(secondServiceStatus.pid), "SIGTERM")
    await waitFor(async () => {
      const events = await processEvents(fixture.serviceLogPath)

      return events.some((event) => event.event === "start" && event.releaseId === "v2")
    })
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("handoff services start per release and drain with their release", async () => {
  const fixture = await createFixture({handoffService: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)
  /** @type {WebSocket | undefined} */
  let socket

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    socket = await openWebSocket(daemon)
    const v1 = statusRelease(daemon, "v1")
    const v1Service = v1.processes.find((processStatus) => processStatus.id === "beacon")

    expect(v1Service?.pid).toBeTruthy()
    expect(v1.ports.beacon > 0).toBe(true)

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    const v2 = statusRelease(daemon, "v2")
    const v2Service = v2.processes.find((processStatus) => processStatus.id === "beacon")

    expect(v2Service?.pid).toBeTruthy()
    expect(v2.ports.beacon).not.toBe(v1.ports.beacon)
    expect(statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "beacon")?.state).toBe("quiesced")

    socket.close()
    socket = undefined

    await waitFor(() => statusRelease(daemon, "v1").state === "stopped")
    expect(statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "beacon")?.state).toBe("stopped")

    const events = await processEvents(fixture.serviceLogPath)

    expect(events.some((event) => event.event === "start" && event.releaseId === "v1")).toBe(true)
    expect(events.some((event) => event.event === "start" && event.releaseId === "v2")).toBe(true)
    expect(events.some((event) => event.event === "stop" && event.releaseId === "v1")).toBe(true)
  } finally {
    if (socket) socket.close()
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("handoff services stop after release-local dependents finish draining", async () => {
  const fixture = await createFixture({handoffService: true, nonBlockingDrainWorker: true, webDependsOnService: true, workerStopDelayMs: 200})
  const daemon = await startDaemon(fixture.config)
  /** @type {WebSocket | undefined} */
  let socket

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    socket = await openWebSocket(daemon)
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    await waitFor(() => statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "worker")?.state === "stopped")

    const drainingRelease = statusRelease(daemon, "v1")

    expect(drainingRelease.state).toBe("draining")
    expect(drainingRelease.processes.find((processStatus) => processStatus.id === "beacon")?.state).toBe("quiesced")

    socket.close()
    socket = undefined
    await waitFor(() => statusRelease(daemon, "v1").state === "stopped")

    const events = await processEvents(fixture.serviceLogPath)
    const v1ServiceStop = events.find((event) => event.event === "stop" && event.releaseId === "v1")

    // V1 handoff service should stop after release drain.
    expect(v1ServiceStop).toBeTruthy()
  } finally {
    if (socket) socket.close()
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("candidate activation retires jobs-main with its workers without waiting for the generation to drain", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceQuiet: true, nonBlockingDrainWorker: true, webDependsOnService: true, workerStopDelayMs: 1000})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    const oldRelease = statusRelease(daemon, "v1")
    const oldService = oldRelease.processes.find((processStatus) => processStatus.id === "beacon")
    const oldWorker = oldRelease.processes.find((processStatus) => processStatus.id === "worker")

    expect(oldService?.pid).toBeTruthy()
    expect(oldWorker?.pid).toBeTruthy()

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    // Traffic must switch only after the complete candidate is healthy.
    expect(daemon.status().activeReleaseId).toBe("v2")
    // Old jobs-main must quiesce immediately after candidate activation.
    expect(await fs.readFile(fixture.serviceQuietPath, "utf8")).toBe("v1\n")

    const retired = statusRelease(daemon, "v1")

    // Deployment completion must not wait for the old jobs generation.
    expect(retired.state).toBe("draining")
    // Old jobs-main must remain alive and quiesced with its draining workers.
    expect(retired.processes.find((processStatus) => processStatus.id === "beacon")?.state).toBe("quiesced")
    // Old worker must remain in its original generation until accepted work settles.
    expect(retired.processes.find((processStatus) => processStatus.id === "worker")?.state).not.toBe("stopped")
    // Old and new workers must retain distinct jobs-main endpoints.
    expect(statusRelease(daemon, "v2").ports.beacon).not.toBe(retired.ports.beacon)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("opt-in generation lifecycle acknowledges old retirement before activating the candidate", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, nonBlockingDrainWorker: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1"])
    expect(daemon.status().activeReleaseId).toBe("v1")

    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1", "retire:v1", "activate:v2"])
    expect(daemon.status().activeReleaseId).toBe("v2")
    expect(daemon.status().generationTransition?.phase).toBe("committed")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("manual restart reaches the active handoff coordinator and restores its lifecycle role", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    const before = statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "beacon")?.pid
    const result = await daemon.restartProcesses({processId: "beacon"})
    const after = statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "beacon")?.pid

    expect(result).toEqual({restarted: ["beacon"]})
    expect(before).toBeTruthy()
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1", "retire:v1", "activate:v1"])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("generation commit is durable before awaited post-transition work", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, includeSingleton: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)
  const replaceSingletons = daemon.replaceSingletons.bind(daemon)
  /** @type {() => void} */
  let markReplacementStarted = () => {}
  /** @type {() => void} */
  let releaseReplacement = () => {}
  const replacementStarted = new Promise((resolve) => { markReplacementStarted = () => resolve(undefined) })
  const replacementGate = new Promise((resolve) => { releaseReplacement = () => resolve(undefined) })
  /** @type {Promise<Record<string, import("../src/json.js").JsonValue>> | undefined} */
  let deployPromise

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    daemon.replaceSingletons = async (release) => {
      if (release.releaseId === "v2") {
        markReplacementStarted()
        await replacementGate
      }
      await replaceSingletons(release)
    }

    deployPromise = daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    await replacementStarted

    const persisted = /** @type {{activeReleaseId?: string, generationTransition?: {phase?: string}, singletonReleaseIds?: Record<string, string>} | undefined} */ (await readState(fixture.statePath))

    expect(daemon.status().activeReleaseId).toBe("v2")
    expect(persisted?.activeReleaseId).toBe("v2")
    expect(persisted?.generationTransition?.phase).toBe("committed_pending")
    expect(persisted?.singletonReleaseIds?.["jobs-main"]).toBe("v1")

    releaseReplacement()
    await deployPromise
    expect(daemon.status().generationTransition?.phase).toBe("committed")
  } finally {
    releaseReplacement()
    await deployPromise?.catch(() => {})
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("exact committed retry finishes pending singleton replacement before success", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, includeSingleton: true, singletonCwd: "{{releasePath}}/{{releaseId}}", webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  await fs.mkdir(path.join(fixture.root, "v1"))

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow(/ENOENT/)

    // Traffic remains durably committed.
    expect(daemon.status().activeReleaseId).toBe("v2")
    expect(daemon.status().generationTransition?.phase).toBe("committed_pending")
    expect(daemon.status().singletons[0]?.process.state).not.toBe("running")

    await fs.mkdir(path.join(fixture.root, "v2"))
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    expect(daemon.status().generationTransition?.phase).toBe("committed")
    expect(daemon.status().singletons[0]?.process.state).toBe("running")
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1", "retire:v1", "activate:v2"])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("first generation is not committed when its activation acknowledgement fails", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceActivateFailure: "v1", nonBlockingDrainWorker: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await expect(daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})).rejects.toThrow(/activate command exited non-zero/)
    const status = daemon.status()

    expect(status.activeReleaseId).toBe(null)
    expect(status.generationTransition?.phase).toBe("activating_candidate")
    expect(status.releaseReferences.map((reference) => reference.releaseId)).toEqual(["v1"])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("retirement acknowledgement failure retains the exact transition, blocks other deploys, and exact resume continues it", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceQuietFailure: true, nonBlockingDrainWorker: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow(/retirement quiescence failed/)

    const failed = daemon.status()

    expect(failed.activeReleaseId).toBe("v1")
    expect(failed.generationTransition?.phase).toBe("retiring_previous")
    expect(String(failed.generationTransition?.error)).toMatch(/quiet command exited non-zero/)
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1"])
    await expect(daemon.deploy({releaseId: "v3", releasePath: fixture.root, revision: "v3"})).rejects.toThrow(/transition.*v2.*unresolved/i)

    await fs.writeFile(fixture.retirementGatePath, "allow\n")
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    expect(daemon.status().activeReleaseId).toBe("v2")
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1", "retire:v1", "activate:v2"])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("candidate activation failure reports restoration failure and exact recovery clears the fence", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceActivateFailure: true, nonBlockingDrainWorker: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    const incumbentCoordinator = daemon.releases.get("v1")?.getProcess("beacon")
    const reactivate = incumbentCoordinator?.reactivateStrict.bind(incumbentCoordinator)

    if (!(incumbentCoordinator && reactivate)) throw new Error("Missing required fixture: incumbentCoordinator && reactivate")
    incumbentCoordinator.reactivateStrict = async () => { throw new Error("incumbent restoration rejected") }
    const deployment = daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    await expect(deployment).rejects.toBeInstanceOf(AggregateError)
    await expect(deployment).rejects.toMatchObject({message: expect.stringMatching(/activate command exited non-zero/)})
    await expect(deployment).rejects.toMatchObject({message: expect.stringMatching(/incumbent v1 restoration failed: incumbent restoration rejected/i)})

    const failed = daemon.status()

    expect(failed.activeReleaseId).toBe("v1")
    expect(failed.generationTransition?.phase).toBe("restoring_previous")
    expect(String(failed.generationTransition?.activationError)).toMatch(/activate command exited non-zero/)
    expect(String(failed.generationTransition?.compensationError)).toMatch(/incumbent restoration rejected/)
    const failedEvents = daemon.eventLog.recent()
    const activationEvent = failedEvents.find((event) => event.message === "release generation activation failed")
    const restorationEvent = failedEvents.find((event) => event.message === "release generation compensation restoration failed")

    expect(String(activationEvent?.data.error)).toMatch(/activate command exited non-zero/)
    expect(String(restorationEvent?.data.activationError)).toMatch(/activate command exited non-zero/)
    expect(String(restorationEvent?.data.error)).toMatch(/incumbent restoration rejected/)
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1", "retire:v1", "retire:v2"])
    await expect(daemon.deploy({releaseId: "v3", releasePath: fixture.root, revision: "v3"})).rejects.toThrow(/transition.*v2.*unresolved/i)
    const failedCandidate = daemon.releases.get("v2")

    if (!failedCandidate) throw new Error("Missing required fixture: failedCandidate")
    await failedCandidate.stop()
    incumbentCoordinator.reactivateStrict = reactivate
    await incumbentCoordinator.stop()
    expect(failedCandidate.state).toBe("stopped")
    expect(incumbentCoordinator.status().state).toBe("stopped")
    daemon.config = structuredClone(daemon.config)
    daemon.config.processes[0].lifecycle.activateTimeoutMs = (daemon.config.processes[0].lifecycle.activateTimeoutMs ?? 30000) + 1
    const recovery = await sendControlCommand({
      command: {
        command: "recover-generation-transition",
        previousReleaseId: "v1",
        releaseId: "v2",
        releasePath: fixture.root,
        revision: "v2"
      },
      path: fixture.config.control.path
    })

    expect(recovery.recoveryStatus).toBe("recovered")
    expect(daemon.status().activeReleaseId).toBe("v1")
    expect(daemon.status().generationTransition).toBe(undefined)
    const persisted = /** @type {{generationTransition?: import("../src/json.js").JsonValue} | undefined} */ (await readState(fixture.statePath))

    expect(persisted?.generationTransition).toBe(undefined)
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1", "retire:v1", "retire:v2", "activate:v1"])

    const idempotent = await sendControlCommand({
      command: {
        command: "recover-generation-transition",
        previousReleaseId: "v1",
        releaseId: "v2",
        releasePath: fixture.root,
        revision: "v2"
      },
      path: fixture.config.control.path
    })

    expect(idempotent.recoveryStatus).toBe("already_recovered")
    await daemon.deploy({releaseId: "v3", releasePath: fixture.root, revision: "v3"})
    await expect(sendControlCommand({
        command: {
          command: "recover-generation-transition",
          previousReleaseId: "v1",
          releaseId: "v3",
          releasePath: fixture.root,
          revision: "v3"
        },
        path: fixture.config.control.path
      })).rejects.toThrow(/not a safe failed pre-commit transition/i)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("explicit recovery stops the exact failed candidate and fences degraded incumbent authority", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceActivateFailure: true, nonBlockingDrainWorker: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    const incumbentCoordinator = daemon.releases.get("v1")?.getProcess("beacon")

    if (!incumbentCoordinator) throw new Error("Missing required fixture: incumbentCoordinator")
    incumbentCoordinator.reactivateStrict = async () => { throw new Error("Cannot activate background jobs generation from retired") }
    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow(/Cannot activate background jobs generation from retired/i)

    const candidate = daemon.releases.get("v2")
    const transition = daemon.generationTransition
    const incumbentWebPid = statusRelease(daemon, "v1").processes.find(({id}) => id === "web")?.pid
    const exactRecovery = (overrides = {}) => sendControlCommand({
      command: {
        acceptRetiredIncumbent: true,
        command: "recover-generation-transition",
        previousReleaseId: "v1",
        releaseId: "v2",
        releasePath: fixture.root,
        revision: "v2",
        ...overrides
      },
      path: fixture.config.control.path
    })

    if (!(candidate && transition && incumbentWebPid)) throw new Error("Missing required fixture: candidate && transition && incumbentWebPid")
    // Ordinary failed compensation leaves the candidate draining.
    expect(candidate.state).toBe("draining")

    const retainedCandidateConfig = candidate.config

    candidate.config = {...candidate.config, releaseRetention: {...candidate.config.releaseRetention, keep: candidate.config.releaseRetention.keep + 1}}
    await expect(exactRecovery()).rejects.toThrow(/does not retain its exact path, revision, and config authority/i)
    candidate.config = retainedCandidateConfig
    await expect(exactRecovery({previousReleaseId: "wrong-v1"})).rejects.toThrow(/refusing stale recovery/i)
    await expect(exactRecovery({revision: "wrong-v2"})).rejects.toThrow(/exact same release, path, revision, and config authority/i)
    transition.phase = "retiring_failed_candidate"
    await expect(exactRecovery()).rejects.toThrow(/requires retiring_previous or restoring_previous/i)
    transition.phase = "restoring_previous"
    const terminalFailure = transition.compensationError

    transition.compensationError = "incumbent activation was temporarily unavailable"
    await expect(exactRecovery()).rejects.toThrow(/terminal retirement/i)
    transition.compensationError = terminalFailure
    await incumbentCoordinator.setLifecycleRole("retired")
    expect(incumbentCoordinator.status().lifecycleRole).toBe("retired")
    const checkpoint = daemon.checkpointGenerationTransition.bind(daemon)

    daemon.checkpointGenerationTransition = async () => { throw new Error("injected checkpoint failure") }
    await expect(exactRecovery()).rejects.toThrow(/checkpoint failed: injected checkpoint failure/i)
    expect(daemon.generationTransition).toBe(transition)
    daemon.checkpointGenerationTransition = checkpoint

    const eventsBeforeRecovery = await lifecycleEvents(fixture.lifecycleLogPath)
    const recovery = await exactRecovery()

    expect(recovery.recoveryStatus).toBe("retired_incumbent_accepted")
    expect(recovery.jobsStatus).toBe("degraded")
    expect(daemon.status().generationTransition?.phase).toBe("degraded_active")
    expect(statusRelease(daemon, "v1").processes.find(({id}) => id === "web")?.pid).toBe(incumbentWebPid)
    expect(await fetchText(daemon, "/release")).toBe("v1")
    // Guarded recovery returns before failed-candidate drain completion.
    expect(["draining", "stopped"].includes(candidate.state)).toBe(true)
    // Recovery must not activate either retained generation.
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(eventsBeforeRecovery)
    const persisted = /** @type {{generationTransition?: import("../src/json.js").JsonValue} | undefined} */ (await readState(fixture.statePath))

    expect(/** @type {{phase?: string} | undefined} */ (persisted?.generationTransition)?.phase).toBe("degraded_active")

    transition.phase = "retiring_previous"
    transition.error = "Release v1 retirement quiescence failed: quiet command exited non-zero with status 1"
    transition.compensationError = undefined
    candidate.state = "starting"
    await daemon.checkpointGenerationTransition()
    const legacyRecovery = await exactRecovery()

    expect(legacyRecovery.recoveryStatus).toBe("retired_incumbent_accepted")
    // Guarded recovery migrates a legacy terminal retirement fence.
    expect(daemon.status().generationTransition?.phase).toBe("degraded_active")

    transition.phase = "restoring_previous"
    transition.compensationError = "Process background-jobs-main is not retained for reactivation"
    daemon.releases.get("v1")?.processes.delete("beacon")
    await daemon.checkpointGenerationTransition()
    const absentCoordinatorRecovery = await exactRecovery()

    expect(absentCoordinatorRecovery.jobsStatus).toBe("degraded")
    // Terminally absent incumbent coordinator remains guarded jobs-degraded authority.
    expect(daemon.status().generationTransition?.phase).toBe("degraded_active")
    await expect(daemon.deploy({releaseId: "bad-v3", releasePath: fixture.root, revision: "bad-v3"})).rejects.toThrow(/health check failed/i)
    expect(daemon.status().generationTransition?.phase).toBe("degraded_active")
    expect(statusRelease(daemon, "v1").processes.find(({id}) => id === "web")?.pid).toBe(incumbentWebPid)
    expect(await fetchText(daemon, "/release")).toBe("v1")
    await daemon.deploy({releaseId: "v3", releasePath: fixture.root, revision: "v3"})
    expect(daemon.status().activeReleaseId).toBe("v3")
    expect(daemon.status().generationTransition?.phase).toBe("committed")
    expect(await fetchText(daemon, "/release")).toBe("v3")
    // Fresh deployment must not re-retire a degraded incumbent generation.
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1", "retire:v1", "retire:v2", "retire:bad-v3", "activate:v3"])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("candidate activation failure compensates to the incumbent and admits a different later release", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceActivateFailure: true, nonBlockingDrainWorker: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow(/activate command exited non-zero.*compensation restored incumbent v1 as authoritative and retired failed candidate v2/i)

    const compensated = daemon.status()

    expect(compensated.activeReleaseId).toBe("v1")
    expect(compensated.generationTransition).toBe(undefined)
    expect(await fetchText(daemon, "/release")).toBe("v1")
    expect(statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "worker")?.state).toBe("running")
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1", "retire:v1", "retire:v2", "activate:v1"])

    await daemon.deploy({releaseId: "v3", releasePath: fixture.root, revision: "v3"})

    expect(daemon.status().activeReleaseId).toBe("v3")
    expect(await fetchText(daemon, "/release")).toBe("v3")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("ambiguous candidate activation retires the candidate before reactivating the incumbent", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceActivateAmbiguousFailure: true, nonBlockingDrainWorker: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow(/activate command exited non-zero.*compensation restored incumbent v1 as authoritative and retired failed candidate v2/i)

    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual([
      "activate:v1",
      "retire:v1",
      "activate:v2",
      "retire:v2",
      "activate:v1"
    ])
    expect(daemon.status().activeReleaseId).toBe("v1")
    expect(daemon.status().generationTransition).toBe(undefined)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("candidate activation recovery reverses a worker-specific quiet hook before reporting active", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceActivateFailure: true, nonBlockingDrainWorker: true, webDependsOnService: true, workerReactivationLifecycle: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow(/compensation restored incumbent v1 as authoritative/i)

    const events = await lifecycleEvents(fixture.lifecycleLogPath)
    const candidateRetired = events.indexOf("worker-retire:v2")
    const workerReactivated = events.indexOf("worker-reactivate:v1")

    expect({value: Boolean(candidateRetired >= 0), context: JSON.stringify(events)}).toMatchObject({value: true})
    expect({value: Boolean(workerReactivated > candidateRetired), context: JSON.stringify(events)}).toMatchObject({value: true})
    expect(statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "worker")?.state).toBe("running")
    expect(daemon.status().activeReleaseId).toBe("v1")
    expect(daemon.status().generationTransition).toBe(undefined)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("candidate activation recovery keeps the fence when a worker-specific resume hook fails", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceActivateFailure: true, nonBlockingDrainWorker: true, webDependsOnService: true, workerReactivationFailure: true, workerReactivationLifecycle: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    const deployment = daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    await expect(deployment).rejects.toMatchObject({message: expect.stringMatching(/activate command exited non-zero/)})
    await expect(deployment).rejects.toMatchObject({message: expect.stringMatching(/reactivate command exited non-zero/)})

    const status = daemon.status()
    const restorationEvent = daemon.eventLog.recent().find((event) => event.message === "release generation compensation restoration failed")

    expect(status.activeReleaseId).toBe("v1")
    expect(status.generationTransition?.phase).toBe("restoring_previous")
    expect(String(status.generationTransition?.activationError)).toMatch(/activate command exited non-zero/)
    expect(String(status.generationTransition?.compensationError)).toMatch(/reactivate command exited non-zero/)
    expect(statusRelease(daemon, "v1").processes.find((processStatus) => processStatus.id === "worker")?.state).toBe("quiesced")
    expect(String(restorationEvent?.data.activationError)).toMatch(/activate command exited non-zero/)
    expect(String(restorationEvent?.data.error)).toMatch(/reactivate command exited non-zero/)
    await expect(daemon.deploy({releaseId: "v3", releasePath: fixture.root, revision: "v3"})).rejects.toThrow(/transition.*v2.*unresolved/i)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("compensation keeps the fence when the cleared checkpoint cannot be persisted", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceActivateFailure: true, nonBlockingDrainWorker: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    const checkpoint = daemon.checkpointGenerationTransition.bind(daemon)

    daemon.checkpointGenerationTransition = async () => {
      if (!daemon.generationTransition) throw new Error("cleared checkpoint unavailable")
      await checkpoint()
    }
    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow(/activate command exited non-zero.*compensation checkpoint clear failed: cleared checkpoint unavailable/i)

    expect(daemon.status().activeReleaseId).toBe("v1")
    expect(daemon.status().generationTransition?.phase).toBe("restoring_previous")
    const persisted = /** @type {{generationTransition?: {phase?: string}} | undefined} */ (await readState(fixture.statePath))

    expect(persisted?.generationTransition?.phase).toBe("restoring_previous")
    await expect(daemon.deploy({releaseId: "v3", releasePath: fixture.root, revision: "v3"})).rejects.toThrow(/transition.*v2.*unresolved/i)

    daemon.checkpointGenerationTransition = checkpoint
    const recovery = await sendControlCommand({
      command: {
        command: "recover-generation-transition",
        previousReleaseId: "v1",
        releaseId: "v2",
        releasePath: fixture.root,
        revision: "v2"
      },
      path: fixture.config.control.path
    })

    expect(recovery.recoveryStatus).toBe("recovered")
    expect(daemon.status().generationTransition).toBe(undefined)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("unresolved generation transition fences stop, restart, and rollback mutations", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceActivateFailure: true, nonBlockingDrainWorker: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    const incumbentCoordinator = daemon.releases.get("v1")?.getProcess("beacon")

    if (!incumbentCoordinator) throw new Error("Missing required fixture: incumbentCoordinator")
    incumbentCoordinator.reactivateStrict = async () => { throw new Error("incumbent restoration rejected") }
    await expect(daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})).rejects.toThrow(/activate command exited non-zero/)

    await expect(daemon.stopRelease("v2")).rejects.toThrow(/cannot stop.*generation transition.*unresolved/i)
    await expect(daemon.restartProcesses({processId: "beacon"})).rejects.toThrow(/cannot restart.*generation transition.*unresolved/i)
    await expect(daemon.rollback({releaseId: "v2"})).rejects.toThrow(/cannot rollback.*generation transition.*unresolved/i)

    expect(statusRelease(daemon, "v2").processes.find((entry) => entry.id === "web")?.state).not.toBe("stopped")
    expect(await fetchText(daemon, "/release")).toBe("v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("active generation restores its exact lifecycle role after coordinator auto-restart", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    const coordinator = statusRelease(daemon, "v1").processes.find((entry) => entry.id === "beacon")

    if (!coordinator?.pid) throw new Error("Missing required fixture: coordinator?.pid")
    process.kill(-coordinator.pid, "SIGKILL")
    await waitFor(async () => (await lifecycleEvents(fixture.lifecycleLogPath)).length === 2 && statusRelease(daemon, "v1").processes.find((entry) => entry.id === "beacon")?.state === "running", 3000)

    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1", "activate:v1"])
    expect(statusRelease(daemon, "v1").processes.find((entry) => entry.id === "beacon")?.state).toBe("running")
    expect(await fetchText(daemon, "/release")).toBe("v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("failed active-role restoration is loud and never reports the restarted coordinator running", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, handoffServiceActivateFailure: "v1", webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)

  await fs.writeFile(fixture.activationGatePath, "allow\n")

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await fs.rm(fixture.activationGatePath)
    const coordinator = statusRelease(daemon, "v1").processes.find((entry) => entry.id === "beacon")

    if (!coordinator?.pid) throw new Error("Missing required fixture: coordinator?.pid")
    process.kill(-coordinator.pid, "SIGKILL")
    await waitFor(() => {
      const status = statusRelease(daemon, "v1").processes.find((entry) => entry.id === "beacon")

      return status?.state === "failed" && status.restarts === 1
    }, 3000)

    const failed = statusRelease(daemon, "v1").processes.find((entry) => entry.id === "beacon")

    expect(failed?.lifecycleRole).toBe("active")
    // Role restoration failure must not create an internal retry loop.
    expect(failed?.restarts).toBe(1)
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1"])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("retired generation coordinator remains fenced after exit", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceActivate: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)
  /** @type {WebSocket | undefined} */
  let socket

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    socket = await openWebSocket(daemon)
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    await waitFor(() => statusRelease(daemon, "v1").processes.find((entry) => entry.id === "beacon")?.lifecycleRole === "retired")
    const coordinator = statusRelease(daemon, "v1").processes.find((entry) => entry.id === "beacon")
    const coordinatorProcess = daemon.releases.get("v1")?.getProcess("beacon")

    if (!coordinator?.pid) throw new Error("Missing required fixture: coordinator?.pid")
    if (!coordinatorProcess) throw new Error("Missing required fixture: coordinatorProcess")
    expect(coordinator.lifecycleRole).toBe("retired")
    // Retirement refresh must preserve exact guardian event routing.
    expect(daemon.guardian?.processes.get("release:v1:beacon")).toBe(coordinatorProcess)
    const exited = once(coordinatorProcess, "exit")

    process.kill(-coordinator.pid, "SIGKILL")
    const [exit] = await exited
    const stopped = coordinatorProcess.status()

    expect(exit.code).toBe(null)
    expect(exit.id).toBe("beacon")
    expect(exit.signal).toBe("SIGKILL")
    expect(await lifecycleEvents(fixture.lifecycleLogPath)).toEqual(["activate:v1", "retire:v1", "activate:v2"])
    expect(stopped.lifecycleRole).toBe("retired")
    expect(stopped.pid).toBe(undefined)
    expect(stopped.restarts).toBe(0)
    expect(stopped.state).toBe("stopped")
    // Retired process must not queue a restart.
    expect(coordinatorProcess.restartTimer).toBe(undefined)
  } finally {
    socket?.close()
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("multiple retired jobs generations keep distinct endpoints and live references until completion", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceQuiet: true, webDependsOnService: true})
  const daemon = await startDaemon(fixture.config)
  /** @type {WebSocket[]} */
  const sockets = []

  try {
    await Promise.all(["v1", "v2", "v3"].map((releaseId) => fs.mkdir(path.join(fixture.root, releaseId))))
    await daemon.deploy({releaseId: "v1", releasePath: path.join(fixture.root, "v1"), revision: "v1"})
    sockets.push(await openWebSocket(daemon))
    await daemon.deploy({releaseId: "v2", releasePath: path.join(fixture.root, "v2"), revision: "v2"})
    sockets.push(await openWebSocket(daemon))
    await daemon.deploy({releaseId: "v3", releasePath: path.join(fixture.root, "v3"), revision: "v3"})

    const status = daemon.status()
    const generations = ["v1", "v2", "v3"].map((releaseId) => statusRelease(daemon, releaseId))

    expect(generations.map((release) => release.state)).toEqual(["draining", "draining", "active"])
    expect(new Set(generations.map((release) => release.ports.beacon)).size).toBe(3)
    expect(status.releaseReferences.map((reference) => reference.releaseId)).toEqual(["v1", "v2", "v3"])
    expect(status.releaseReferences.map((reference) => reference.releasePath)).toEqual(["v1", "v2", "v3"].map((releaseId) => path.join(fixture.root, releaseId)))

    for (const socket of sockets.splice(0)) socket.close()
    await waitFor(() => statusRelease(daemon, "v1").state === "stopped" && statusRelease(daemon, "v2").state === "stopped")
    expect(daemon.status().releaseReferences.map((reference) => reference.releaseId)).toEqual(["v3"])
  } finally {
    for (const socket of sockets) socket.close()
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("candidate failure preserves old traffic, jobs generation, endpoint, and reference without quiescing it", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceQuiet: true, nonBlockingDrainWorker: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "good", releasePath: fixture.root, revision: "good"})
    const before = statusRelease(daemon, "good")
    const beforeService = before.processes.find((processStatus) => processStatus.id === "beacon")

    await expect(daemon.deploy({releaseId: "bad", releasePath: fixture.root, revision: "bad"})).rejects.toThrow(/Health check failed/)

    const after = statusRelease(daemon, "good")

    expect(await fetchText(daemon, "/release")).toBe("good")
    expect(after.state).toBe("active")
    expect(after.ports.beacon).toBe(before.ports.beacon)
    expect(after.processes.find((processStatus) => processStatus.id === "beacon")?.pid).toBe(beforeService?.pid)
    // Candidate cleanup must not quiesce the active generation.
    expect((await fs.readFile(fixture.serviceQuietPath, "utf8")).includes("good\n")).toBe(false)
    expect(daemon.status().releaseReferences.map((reference) => reference.releaseId)).toEqual(["good"])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("handoff-service quiescence failure is visible and leaves the generation alive", async () => {
  const fixture = await createFixture({handoffService: true, handoffServiceQuietFailure: true, nonBlockingDrainWorker: true, webDependsOnService: true})
  /** @type {{data?: Record<string, import("../src/json.js").JsonValue>, message: string}[]} */
  const logs = []
  const daemon = new RollbridgeDaemon({config: fixture.config, logger: (message, data) => logs.push({data, message})})

  try {
    await daemon.start()
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    const result = await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    const retired = statusRelease(daemon, "v1")

    expect(retired.state).toBe("draining")
    expect(String(retired.retirementError)).toMatch(/quiet command exited non-zero.*23/)
    expect(retired.processes.find((processStatus) => processStatus.id === "beacon")?.state).toBe("stopping")
    expect(retired.processes.find((processStatus) => processStatus.id === "worker")?.state).not.toBe("stopped")
    expect(logs.some((entry) => entry.message === "release retirement quiescence failed" && entry.data?.releaseId === "v1")).toBeTruthy()
    expect(result.retirement).toEqual({error: retired.retirementError, releaseId: "v1", status: "quiescence_failed"})
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("a replicated companion starts one instance per replica, and restart targets one or all", async () => {
  const fixture = await createFixture({companionReplicas: 3})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const release = daemon.status().releases.find((candidate) => candidate.state === "active")

    if (!release) throw new Error("Missing required fixture: release")

    const workerIds = release.processes.filter((processStatus) => processStatus.id.startsWith("worker")).map((processStatus) => processStatus.id).sort()

    expect(workerIds).toEqual(["worker#0", "worker#1", "worker#2"])

    // A specific replica id restarts only that replica.
    const one = await daemon.restartProcesses({processId: "worker#1"})

    expect(one.restarted).toEqual(["worker#1"])

    // The base id restarts every replica.
    const all = /** @type {string[]} */ ((await daemon.restartProcesses({processId: "worker"})).restarted)

    expect([...all].sort()).toEqual(["worker#0", "worker#1", "worker#2"])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("restart bounces a single process by id", async () => {
  const fixture = await createFixture({includeService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const before = pidsById(daemon.status())
    const result = await daemon.restartProcesses({processId: "beacon"})

    expect(result.restarted).toEqual(["beacon"])

    const after = pidsById(daemon.status())

    expect(before.beacon && after.beacon).toBeTruthy()
    expect(after.beacon).not.toBe(before.beacon)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("restart with no selector bounces every non-proxied process but not the proxied one", async () => {
  const fixture = await createFixture({includeCompanion: true, includeService: true, includeSingleton: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const before = pidsById(daemon.status())
    const result = await daemon.restartProcesses()
    const restarted = /** @type {string[]} */ (result.restarted)

    expect([...restarted].sort()).toEqual(["beacon", "jobs-main", "worker"])

    const after = pidsById(daemon.status())

    // Proxied process should not be restarted.
    expect(after.web).toBe(before.web)
    expect(after.beacon).not.toBe(before.beacon)
    expect(after["jobs-main"]).not.toBe(before["jobs-main"])
    expect(after.worker).not.toBe(before.worker)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("restart --policy targets only processes with that policy", async () => {
  const fixture = await createFixture({includeCompanion: true, includeService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const before = pidsById(daemon.status())
    const result = await daemon.restartProcesses({policy: "companion"})

    expect(result.restarted).toEqual(["worker"])

    const after = pidsById(daemon.status())

    expect(after.worker).not.toBe(before.worker)
    // The service should be left running.
    expect(after.beacon).toBe(before.beacon)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("restart refuses the proxied process and reports unknown ids", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    await expect(daemon.restartProcesses({processId: "web"})).rejects.toThrow(/proxied process cannot be restarted/)
    await expect(daemon.restartProcesses({policy: "proxied"})).rejects.toThrow(/proxied process cannot be restarted/)
    await expect(daemon.restartProcesses({processId: "missing"})).rejects.toThrow(/No managed process with id "missing"/)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("restart revives a stopped process instead of erroring", async () => {
  const fixture = await createFixture({includeCompanion: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // Simulate the worker having exited (e.g. crashed and exhausted its restart budget).
    const worker = daemon.activeRelease?.getProcess("worker")

    if (!worker) throw new Error("worker process should exist")
    await worker.stop()
    expect(worker.status().state).toBe("stopped")

    const result = await daemon.restartProcesses({processId: "worker"})

    expect(result.restarted).toEqual(["worker"])
    expect(worker.status().state).toBe("running")
    expect(worker.status().pid).toBeTruthy()
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("the restart control command bounces a process over the socket", async () => {
  const fixture = await createFixture({includeService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const before = pidsById(daemon.status())
    const response = await sendControlCommand({
      command: {command: "restart", processId: "beacon"},
      path: fixture.config.control.path
    })

    expect(response.restarted).toEqual(["beacon"])
    expect(pidsById(daemon.status()).beacon).not.toBe(before.beacon)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("status and events distinguish deploy starts from manual restarts", async () => {
  const fixture = await createFixture({includeService: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const afterDeploy = daemon.status().services.find((service) => service.id === "beacon")

    if (!afterDeploy) throw new Error("Missing required fixture: afterDeploy")
    expect(afterDeploy.process.lastStartReason).toBe("deploy")

    await daemon.restartProcesses({processId: "beacon"})

    const afterRestart = daemon.status().services.find((service) => service.id === "beacon")

    if (!afterRestart) throw new Error("Missing required fixture: afterRestart")
    expect(afterRestart.process.lastStartReason).toBe("manual")

    const events = /** @type {import("../src/event-log.js").DaemonEvent[]} */ ((await sendControlCommand({
      command: {command: "events"},
      path: fixture.config.control.path
    })).events)
    const startReasons = events.filter((event) => event.message === "process started").map((event) => event.data.reason)

    expect({value: Boolean(startReasons.includes("deploy")), context: JSON.stringify(startReasons)}).toMatchObject({value: true})
    expect({value: Boolean(startReasons.includes("manual")), context: JSON.stringify(startReasons)}).toMatchObject({value: true})
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("persists daemon state to statePath and removes it on a clean shutdown", async () => {
  const fixture = await createFixture({persistState: true})
  const daemon = await startDaemon(fixture.config)
  let stateAfterShutdown

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // The state write is fire-and-forget (deploy doesn't block on it), so wait for it to land.
    await waitFor(async () => {
      const persisted = /** @type {{activeReleaseId: string} | undefined} */ (await readState(fixture.statePath))

      return persisted?.activeReleaseId === "v1"
    })

    await daemon.shutdown()
    stateAfterShutdown = await readState(fixture.statePath)
  } finally {
    if (!daemon.stopping) await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }

  // State file removed on clean shutdown.
  expect(stateAfterShutdown).toBe(undefined)
})

test("persisted daemon state excludes process commands, environment values, and output", async () => {
  const secret = "state-secret-value"
  const fixture = await createFixture({persistState: true})
  const web = fixture.config.processes.find((processConfig) => processConfig.id === "web")

  if (!web) throw new Error("Missing required fixture: web")
  web.env.ROLLBRIDGE_TEST_SECRET = secret
  web.command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log(process.env.ROLLBRIDGE_TEST_SECRET); import(${JSON.stringify(pathToFileURL(dummyAppPath).href)})`)}`

  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    const webProcess = daemon.activeRelease?.getProcess("web")

    if (!webProcess) throw new Error("Missing required fixture: webProcess")
    await recordedLogLine(webProcess, secret)
    // Secret output must be retained before persistence.
    expect(webProcess.status().logs.some((entry) => entry.line === secret)).toBe(true)

    daemon.persistState()
    await waitFor(async () => (await fs.readFile(fixture.statePath, "utf8")).includes('"activeReleaseId": "v1"'))

    const persisted = await fs.readFile(fixture.statePath, "utf8")

    expect(persisted).not.toMatch(/state-secret-value/)
    expect(persisted).not.toMatch(/ROLLBRIDGE_TEST_SECRET/)
    expect(persisted).not.toMatch(/"command"/)
    expect(persisted).not.toMatch(/"logs"/)
    expect(liveProcesses(JSON.parse(persisted), () => true).map(({id, releaseId}) => ({id, releaseId}))).toEqual([{id: "web", releaseId: "v1"}])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("a clean shutdown clears the state file even when a persist write is in flight", async () => {
  const fixture = await createFixture({persistState: true})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // Shut down immediately — the deploy's fire-and-forget persist may still be in flight.
    await daemon.shutdown()

    // State file must not be recreated by an in-flight write.
    expect(await readState(fixture.statePath)).toBe(undefined)
  } finally {
    if (!daemon.stopping) await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("reports orphaned managed processes from a previous daemon's state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const statePath = path.join(dir, "state.json")
  // A live process standing in for a leftover managed child from a crashed daemon.
  const leftover = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"})

  await once(leftover, "spawn")

  /** @type {{data: Record<string, import("../src/json.js").JsonValue>, message: string}[]} */
  const logs = []
  const config = normalizeConfig({
    application: "rollbridge-test",
    control: {path: path.join(dir, "rollbridge.sock")},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0},
    statePath
  })
  const daemon = new RollbridgeDaemon({config, logger: (message, data = {}) => { logs.push({data, message}) }})

  try {
    // A prior daemon left a worker with this (still-alive) pid.
    await writeState(statePath, {
      activeReleaseId: "v1",
      releases: [{processes: [{id: "worker", pid: leftover.pid}], releaseId: "v1"}],
      services: [],
      singletons: []
    })

    await daemon.reportOrphans()

    expect({value: Boolean(logs.some((entry) => entry.message === "orphaned managed process detected" && entry.data.pid === leftover.pid)), context: JSON.stringify(logs)}).toMatchObject({value: true})

    // A dead pid is not reported.
    logs.length = 0
    await writeState(statePath, {
      activeReleaseId: "v1",
      releases: [{processes: [{id: "worker", pid: 2147483646}], releaseId: "v1"}],
      services: [],
      singletons: []
    })
    await daemon.reportOrphans()

    expect(!logs.some((entry) => entry.message === "orphaned managed process detected")).toBeTruthy()
  } finally {
    leftover.kill("SIGKILL")
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("status surfaces still-alive orphaned processes from a previous daemon and drops them once gone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const statePath = path.join(dir, "state.json")
  const leftover = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"})

  await once(leftover, "spawn")

  const config = normalizeConfig({
    application: "rollbridge-test",
    control: {path: path.join(dir, "rollbridge.sock")},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0},
    statePath
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  try {
    // A prior daemon left a worker with this (still-alive) pid.
    await writeState(statePath, {
      activeReleaseId: "v1",
      releases: [{processes: [{id: "worker", pid: leftover.pid}], releaseId: "v1"}],
      services: [],
      singletons: []
    })

    await daemon.reportOrphans()

    // status reflects the still-running child even though the daemon cannot re-manage it.
    expect(daemon.status().orphans).toEqual([{id: "worker", pid: leftover.pid, releaseId: "v1"}])

    // Once the leftover is stopped, status re-checks liveness and drops it.
    leftover.kill("SIGKILL")
    await waitFor(() => daemon.status().orphans.length === 0)
    expect(daemon.status().orphans).toEqual([])

    // The dead entry is pruned from the underlying list, not merely filtered, so a recycled pid
    // can't resurrect a cleared orphan.
    expect(daemon.orphans).toEqual([])
  } finally {
    leftover.kill("SIGKILL")
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("the daemon records a structured event history served by the events command", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const response = await sendControlCommand({
      command: {command: "events"},
      path: fixture.config.control.path
    })
    const events = /** @type {import("../src/event-log.js").DaemonEvent[]} */ (response.events)
    const messages = events.map((event) => event.message)

    expect({value: Boolean(messages.includes("deploy starting")), context: JSON.stringify(messages)}).toMatchObject({value: true})
    expect({value: Boolean(messages.includes("traffic switched")), context: JSON.stringify(messages)}).toMatchObject({value: true})

    const switched = events.find((event) => event.message === "traffic switched")

    if (!switched) throw new Error("Missing required fixture: switched")
    expect(switched.data.releaseId).toBe("v1")
    expect(switched.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("the events command honors --limit and records failed commands", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // An unknown command is rejected and recorded as a "command failed" event.
    await expect(sendControlCommand({
      command: {command: "bogus"},
      path: fixture.config.control.path
    })).rejects.toThrow()

    const all = /** @type {import("../src/event-log.js").DaemonEvent[]} */ ((await sendControlCommand({
      command: {command: "events"},
      path: fixture.config.control.path
    })).events)

    expect(all.some((event) => event.message === "command failed")).toBeTruthy()

    const limited = /** @type {import("../src/event-log.js").DaemonEvent[]} */ ((await sendControlCommand({
      command: {command: "events", limit: 1},
      path: fixture.config.control.path
    })).events)

    expect(limited.length).toBe(1)
    expect(limited[0]).toEqual(all[all.length - 1])
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

linuxTest("a process over its memory limit is restarted with reason memory", async () => {
  const limitBytes = 64 * 1024 * 1024
  const fixture = await createFixture({memoryLimitBytes: limitBytes})
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // The hog allocates ~4x the limit, so the monitor restarts it.
    await waitFor(() => (activeProcessStatus(daemon, "hog")?.memoryRestarts ?? 0) >= 1, 10000)

    const hog = activeProcessStatus(daemon, "hog")

    if (!hog) throw new Error("hog process should be present")
    expect({value: Boolean(hog.memoryRestarts >= 1), context: `expected a memory restart, got ${hog.memoryRestarts}`}).toMatchObject({value: true})
    expect(hog.lastStartReason).toBe("memory")
    expect(typeof hog.lastMemoryRestartAt).toBe("string")

    // Keep the replacement alive long enough to observe its next monitor sample. The fixture
    // remains over the configured limit after every launch, otherwise it can restart again and
    // clear rssBytes/children before this polling loop observes them on slower CI runners.
    const hogProcess = daemon.activeRelease?.processes.get("hog")

    if (!hogProcess?.memory) throw new Error("Missing required fixture: hogProcess?.memory")
    hogProcess.memory.limitBytes = Number.MAX_SAFE_INTEGER

    // rssBytes is sampled on the monitor's interval; wait for a measurement of the running process.
    await waitFor(() => {
      const rssBytes = activeProcessStatus(daemon, "hog")?.rssBytes

      return typeof rssBytes === "number" && rssBytes > 0
    }, 5000)

    // The same monitor sample reports the process tree.
    const monitored = activeProcessStatus(daemon, "hog")

    if (!monitored) throw new Error("Missing required fixture: monitored")
    expect(monitored.children.length >= 1).toBe(true)
    expect(monitored.children.some((child) => typeof child.rssBytes === "number" && child.rssBytes > 0)).toBeTruthy()
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("rollback re-activates the previous release and switches traffic back", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    expect(await fetchText(daemon, "/release")).toBe("v2")

    const result = await daemon.rollback()

    expect(result.activeReleaseId).toBe("v1")
    expect(result.previousReleaseId).toBe("v2")
    expect(daemon.status().activeReleaseId).toBe("v1")
    expect(await fetchText(daemon, "/release")).toBe("v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("rollback --release-id targets a specific retained release", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})
    await daemon.deploy({releaseId: "v3", releasePath: fixture.root, revision: "v3"})

    const result = await daemon.rollback({releaseId: "v1"})

    expect(result.activeReleaseId).toBe("v1")
    expect(await fetchText(daemon, "/release")).toBe("v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("rollback rejects no-previous, unknown, and already-active targets", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    await expect(daemon.rollback()).rejects.toThrow(/No previous release/)
    await expect(daemon.rollback({releaseId: "v1"})).rejects.toThrow(/already active/)
    await expect(daemon.rollback({releaseId: "nope"})).rejects.toThrow(/No retained release "nope"/)
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("rollback to a still-draining release stops the old instance instead of orphaning it", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)
  /** @type {WebSocket | undefined} */
  let socket

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    // An open WebSocket keeps v1's connection count > 0, so it stays draining after v2.
    socket = await openWebSocket(daemon)
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    const draining = statusRelease(daemon, "v1")

    expect(draining.state).toBe("draining")

    const oldWebPid = draining.processes.find((processStatus) => processStatus.id === "web")?.pid

    if (!oldWebPid) throw new Error("the draining release should have a running web process")

    await daemon.rollback({releaseId: "v1"})

    expect(daemon.status().activeReleaseId).toBe("v1")
    // The old draining instance was stopped before its id was reused, so its process is gone.
    await expect(() => process.kill(/** @type {number} */ (oldWebPid), 0)).toThrow(/ESRCH/)
  } finally {
    if (socket) socket.close()
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("the rollback control command switches traffic over the socket", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})
    await daemon.deploy({releaseId: "v2", releasePath: fixture.root, revision: "v2"})

    const response = await sendControlCommand({
      command: {command: "rollback"},
      path: fixture.config.control.path
    })

    expect(response.activeReleaseId).toBe("v1")
    expect(await fetchText(daemon, "/release")).toBe("v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("control socket accepts deploy and status commands", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await sendControlCommand({
      command: {
        command: "deploy",
        releaseId: "control-v1",
        releasePath: fixture.root,
        revision: "control-v1"
      },
      path: fixture.config.control.path
    })

    const status = await sendControlCommand({
      command: {command: "status"},
      path: fixture.config.control.path
    })

    expect(status.activeReleaseId).toBe("control-v1")
    expect(await fetchText(daemon, "/release")).toBe("control-v1")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("starting a second daemon on a live control socket reports the running daemon", async () => {
  const fixture = await createFixture()
  const daemon = await startDaemon(fixture.config)

  try {
    await daemon.deploy({releaseId: "v1", releasePath: fixture.root, revision: "v1"})

    const second = new RollbridgeDaemon({config: fixture.config, logger: () => {}})

    const preparation = second.prepareControlSocketPath()

    await expect(preparation).rejects.toBeInstanceOf(Error)
    await expect(preparation).rejects.toMatchObject({message: expect.stringMatching(/A Rollbridge daemon for application "rollbridge-test" is already running/)})
    await expect(preparation).rejects.toMatchObject({message: expect.stringMatching(/active release: v1/)})
    await expect(preparation).rejects.toMatchObject({message: expect.stringMatching(/rollbridge shutdown/)})

    // The original daemon keeps its socket and still answers control commands.
    const status = await sendControlCommand({command: {command: "status"}, path: fixture.config.control.path})
    expect(status.application).toBe("rollbridge-test")
  } finally {
    await daemon.shutdown()
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

linuxTest("the daemon applies control.owner and control.group to the bound socket", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const {uid, username} = os.userInfo()
  const gid = process.getgid?.() ?? 0
  const config = normalizeConfig({
    application: "rollbridge-test",
    // owner by name (resolved to the current uid); group by numeric id. Both are the current
    // user's, so a non-root daemon can chown the socket to itself.
    control: {group: gid, owner: username, path: socketPath},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0}
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  try {
    await daemon.start()

    const stats = await fs.stat(socketPath)

    expect(stats.uid).toBe(uid)
    expect(stats.gid).toBe(gid)
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("a control socket held by a non-Rollbridge process reports a generic conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const socketPath = path.join(root, "busy.sock")
  const connections = /** @type {Set<import("node:net").Socket>} */ (new Set())
  const stranger = net.createServer((socket) => {
    // Accept connections but never answer, so the probe falls through to its timeout.
    connections.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => connections.delete(socket))
  })

  await new Promise((resolve) => stranger.listen(socketPath, () => resolve(undefined)))

  const config = normalizeConfig({
    application: "rollbridge-test",
    control: {path: socketPath},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0}
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  try {
    await expect(daemon.prepareControlSocketPath()).rejects.toThrow(/The control socket .* is already in use by another process/)
  } finally {
    for (const socket of connections) socket.destroy()
    await new Promise((resolve) => stranger.close(() => resolve(undefined)))
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("applies the configured control socket permission mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const config = normalizeConfig({
    application: "rollbridge-test",
    control: {mode: "660", path: socketPath},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0}
  })
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  try {
    const stats = await fs.stat(socketPath)

    expect(stats.mode & 0o777).toBe(0o660)
  } finally {
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("deploy can ensure the daemon before sending the release command", async () => {
  const fixture = await createFixture()
  const configPath = await writeConfigFile(fixture.config, fixture.root)
  const logPath = path.join(fixture.root, "daemon.log")
  const pidPath = path.join(fixture.root, "daemon.pid")

  try {
    await runCli([
      "node",
      binPath,
      "deploy",
      "--ensure-daemon",
      "--config",
      configPath,
      "--release-path",
      fixture.root,
      "--release-id",
      "ensured-v1",
      "--daemon-log-path",
      logPath,
      "--daemon-pid-path",
      pidPath,
      "--daemon-runtime-path",
      path.join(fixture.root, "daemon-runtime")
    ])

    const status = await sendControlCommand({
      command: {command: "status"},
      path: fixture.config.control.path
    })

    const proxy = /** @type {{port: number}} */ (status.proxy)

    expect(status.activeReleaseId).toBe("ensured-v1")
    expect(status.bootstrap).toBe(undefined)
    expect(await fs.readFile(pidPath, "utf8")).toMatch(/\d+/)
    expect(await fetchTextFromPort(proxy.port, "/release")).toBe("ensured-v1")
  } finally {
    try {
      await sendControlCommand({
        command: {command: "shutdown"},
        path: fixture.config.control.path
      })
    } catch (_error) {
      // The daemon may have failed before it accepted commands.
    }

    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

/**
 * @param {{companionReplicas?: number, handoffService?: boolean, handoffServiceActivate?: boolean, handoffServiceActivateAmbiguousFailure?: boolean, handoffServiceActivateFailure?: boolean | string, handoffServiceQuiet?: boolean, handoffServiceQuietFailure?: boolean, includeCompanion?: boolean, includeService?: boolean, includeSingleton?: boolean, memoryLimitBytes?: number, nonBlockingDrainWorker?: boolean, persistState?: boolean, proxyHost?: string, singletonCwd?: string, webCommand?: string, webDependsOnService?: boolean, webHealthTimeoutMs?: number, workerReactivationFailure?: boolean, workerReactivationLifecycle?: boolean, workerStopDelayMs?: number}} [options] - Fixture options.
 * @returns {Promise<{activationGatePath: string, config: import("../src/config.js").RollbridgeConfig, lifecycleLogPath: string, retirementGatePath: string, root: string, serviceLogPath: string, serviceQuietPath: string, singletonLogPath: string, statePath: string}>} Fixture data.
 */
async function createFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-test-"))
  const serviceLogPath = path.join(root, "service.log")
  const serviceQuietPath = path.join(root, "service.quiet")
  const lifecycleLogPath = path.join(root, "service.lifecycle")
  const activationGatePath = path.join(root, "activation.allow")
  const retirementGatePath = path.join(root, "retirement.allow")
  const singletonLogPath = path.join(root, "singleton.log")
  const statePath = path.join(root, "rollbridge.state.json")
  /** @type {Array<Record<string, import("../src/json.js").JsonValue>>} */
  const processes = []

  if (options.includeService || options.handoffService) {
    const activationFailureRelease = typeof options.handoffServiceActivateFailure === "string" ? options.handoffServiceActivateFailure : "v2"
    const lifecycle = options.handoffServiceActivate ? {
      activateCommand: `${options.handoffServiceActivateFailure && !options.handoffServiceActivateAmbiguousFailure ? `[ "$ROLLBRIDGE_RELEASE_ID" != ${JSON.stringify(activationFailureRelease)} ] || [ -f ${JSON.stringify(activationGatePath)} ] || exit 24; ` : ""}printf 'activate:%s\\n' "$ROLLBRIDGE_RELEASE_ID" >> ${JSON.stringify(lifecycleLogPath)}${options.handoffServiceActivateAmbiguousFailure ? `; [ "$ROLLBRIDGE_RELEASE_ID" != ${JSON.stringify(activationFailureRelease)} ] || [ -f ${JSON.stringify(activationGatePath)} ] || exit 24` : ""}`,
      quietCommand: `${options.handoffServiceQuietFailure ? `[ -f ${JSON.stringify(retirementGatePath)} ] || exit 23; ` : ""}printf 'retire:%s\\n' "$ROLLBRIDGE_RELEASE_ID" >> ${JSON.stringify(lifecycleLogPath)}`
    } : options.handoffServiceQuiet || options.handoffServiceQuietFailure ? {
      quietCommand: options.handoffServiceQuietFailure ? "exit 23" : `printf '%s\\n' "$ROLLBRIDGE_RELEASE_ID" >> ${JSON.stringify(serviceQuietPath)}`
    } : undefined

    processes.push({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(serviceAppPath)} --release={{releaseId}}`,
      ...(options.handoffService ? {deployStrategy: "handoff"} : {}),
      env: {
        ROLLBRIDGE_SERVICE_LOG: serviceLogPath
      },
      id: "beacon",
      ...(lifecycle ? {lifecycle} : {}),
      policy: "service",
      port: options.handoffService ? {from: 15000, to: 15099} : {from: 0, to: 0},
      restartDelayMs: 50
    })
  }

  if (options.includeCompanion) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      id: "worker",
      policy: "companion"
    })
  }

  if (options.companionReplicas) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      id: "worker",
      policy: "companion",
      replicas: options.companionReplicas
    })
  }

  if (options.nonBlockingDrainWorker) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${options.workerStopDelayMs || 0})); setInterval(() => {}, 1000)`)}`,
      id: "worker",
      ...(options.workerReactivationLifecycle ? {lifecycle: {
        quietCommand: `printf 'worker-retire:%s\\n' "$ROLLBRIDGE_RELEASE_ID" >> ${JSON.stringify(lifecycleLogPath)}`,
        reactivateCommand: `${options.workerReactivationFailure ? "exit 25; " : ""}printf 'worker-reactivate:%s\\n' "$ROLLBRIDGE_RELEASE_ID" >> ${JSON.stringify(lifecycleLogPath)}`
      }} : {}),
      nonBlockingDrain: true,
      policy: "companion"
    })
  }

  if (options.memoryLimitBytes) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(memoryHogPath)}`,
      env: {
        ROLLBRIDGE_HOG_BYTES: String(options.memoryLimitBytes * 4)
      },
      id: "hog",
      memory: {checkIntervalMs: 100, limitBytes: options.memoryLimitBytes, warnBytes: 0},
      policy: "companion"
    })
  }

  processes.push({
    command: options.webCommand || (options.webDependsOnService
      ? `${JSON.stringify(process.execPath)} ${JSON.stringify(dependentAppPath)}`
      : `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`),
    health: {
      intervalMs: 50,
      path: "/ping",
      timeoutMs: options.webHealthTimeoutMs || 3000
    },
    id: "web",
    policy: "proxied",
    port: {from: 0, to: 0}
  })

  if (options.includeSingleton) {
    processes.push({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(singletonAppPath)}`,
      ...(options.singletonCwd ? {cwd: options.singletonCwd} : {}),
      env: {
        ROLLBRIDGE_SINGLETON_LOG: singletonLogPath
      },
      id: "jobs-main",
      policy: "singleton"
    })
  }

  const config = normalizeConfig({
    application: "rollbridge-test",
    control: {
      path: path.join(root, "rollbridge.sock")
    },
    processes,
    proxy: {
      drainTimeoutMs: 1000,
      forceStopTimeoutMs: 500,
      healthPath: "/ping",
      healthTimeoutMs: 3000,
      host: options.proxyHost || "127.0.0.1",
      port: 0
    },
    ...((options.persistState || options.handoffServiceActivate) ? {ownerRecovery: {reconnectGraceMs: 30000}, statePath} : {})
  })

  return {activationGatePath, config, lifecycleLogPath, retirementGatePath, root, serviceLogPath, serviceQuietPath, singletonLogPath, statePath}
}

/**
 * @param {string} lifecycleLogPath - Fixture lifecycle event file.
 * @returns {Promise<string[]>} Ordered lifecycle events.
 */
async function lifecycleEvents(lifecycleLogPath) {
  return (await fs.readFile(lifecycleLogPath, "utf8")).trim().split("\n").filter(Boolean)
}

/**
 * @param {import("../src/config.js").RollbridgeConfig} config - Config.
 * @returns {Promise<RollbridgeDaemon>} Started daemon.
 */
async function startDaemon(config) {
  const daemon = new RollbridgeDaemon({config, logger: () => {}})

  await daemon.start()

  return daemon
}

/**
 * @param {RollbridgeDaemon} daemon - Daemon.
 * @param {string} pathName - Path.
 * @returns {Promise<string>} Response text.
 */
async function fetchText(daemon, pathName) {
  return await fetchTextFromPort(Number(daemon.getProxyPort()), pathName)
}

/**
 * @param {number} port - Port.
 * @param {string} pathName - Path.
 * @returns {Promise<string>} Response text.
 */
async function fetchTextFromPort(port, pathName) {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`)

  expect(response.status).toBe(200)

  return (await response.text()).trim()
}

/**
 * @param {RollbridgeDaemon} daemon - Daemon.
 * @returns {Promise<WebSocket>} Open WebSocket.
 */
async function openWebSocket(daemon) {
  const websocket = new WebSocket(`ws://127.0.0.1:${daemon.getProxyPort()}/socket`)

  await new Promise((resolve, reject) => {
    websocket.addEventListener("open", () => resolve(undefined), {once: true})
    websocket.addEventListener("error", () => reject(new Error("WebSocket open failed")), {once: true})
  })

  return websocket
}

/**
 * @param {RollbridgeDaemon} daemon - Daemon.
 * @param {string} releaseId - Release id.
 * @returns {import("../src/release-group.js").ReleaseStatus} Release status.
 */
function statusRelease(daemon, releaseId) {
  const status = daemon.status()
  const release = status.releases.find((candidate) => candidate.releaseId === releaseId)

  if (!release) throw new Error(`Release ${releaseId} should be present`)

  return release
}

/**
 * Maps process id to pid across the active release, services, and singletons.
 * @param {import("../src/daemon.js").DaemonStatus} status - Daemon status payload.
 * @returns {Record<string, number | undefined>} Process id to current pid.
 */
function pidsById(status) {
  /** @type {Record<string, number | undefined>} */
  const pids = {}

  for (const release of status.releases) {
    if (release.state !== "active") continue

    for (const processStatus of release.processes) pids[processStatus.id] = processStatus.pid
  }

  for (const service of status.services) pids[service.id] = service.process.pid
  for (const singleton of status.singletons) pids[singleton.id] = singleton.process.pid

  return pids
}

/**
 * @param {string} logPath - Log path.
 * @returns {Promise<Array<{event: string, pid: number, releaseId: string}>>} Events.
 */
async function processEvents(logPath) {
  try {
    const text = await fs.readFile(logPath, "utf8")

    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return []
    }

    throw error
  }
}

/**
 * @param {import("../src/config.js").RollbridgeConfig} config - Config.
 * @param {string} root - Fixture root.
 * @returns {Promise<string>} Written config path.
 */
async function writeConfigFile(config, root) {
  const configPath = path.join(root, "rollbridge.mjs")

  await fs.writeFile(configPath, `export default ${JSON.stringify(config, null, 2)}\n`)

  return configPath
}

/**
 * @param {() => Promise<boolean> | boolean} callback - Probe callback.
 * @param {number} [timeoutMs] - How long to wait before giving up (default 3000).
 * @returns {Promise<void>} Resolves when callback returns true.
 */
async function waitFor(callback, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await callback()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error("Timed out waiting for condition")
}

/**
 * Resolves from retained output or the exact event that records it, and rejects if the
 * supervised process exits first.
 * @param {import("../src/managed-process.js").default} processInstance - Exact managed process.
 * @param {string} line - Complete output line to observe.
 * @returns {Promise<import("../src/managed-process.js").ManagedProcessLog>} Recorded log entry.
 */
async function recordedLogLine(processInstance, line) {
  const retained = processInstance.status().logs.find((entry) => entry.line === line)

  if (retained) return retained
  return await new Promise((resolve, reject) => {
    /** @param {import("../src/managed-process.js").ManagedProcessLog} entry - Newly retained output. */
    const onLog = (entry) => {
      if (entry.line !== line) return
      cleanup()
      resolve(entry)
    }
    /** @param {{code: number | null, signal: import("node:child_process").ChildProcess["signalCode"]}} exit - Exact process exit. */
    const onExit = (exit) => {
      cleanup()
      reject(new Error(`Process ${processInstance.id} exited before recording expected output ${JSON.stringify(line)}: ${JSON.stringify(exit)}`))
    }
    const cleanup = () => {
      processInstance.off("log", onLog)
      processInstance.off("exit", onExit)
    }

    processInstance.on("log", onLog)
    processInstance.once("exit", onExit)
  })
}

/**
 * @param {RollbridgeDaemon} daemon - Daemon.
 * @param {string} processId - Process id within the active release.
 * @returns {import("../src/managed-process.js").ManagedProcessStatus | undefined} The process status, if present.
 */
function activeProcessStatus(daemon, processId) {
  const release = daemon.status().releases.find((candidate) => candidate.state === "active")

  return release ? release.processes.find((processStatus) => processStatus.id === processId) : undefined
}
})
