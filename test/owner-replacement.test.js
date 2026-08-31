// @ts-check

import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {once} from "node:events"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import {normalizeConfig} from "../src/config.js"
import {sendControlCommand} from "../src/control-client.js"
import RollbridgeDaemon, {isLegacyGuardianPrepareDiagnostic} from "../src/daemon.js"
import GuardianClient from "../src/guardian-client.js"
import {findAvailablePort} from "../src/port-allocator.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const binPath = path.join(repoRoot, "bin", "rollbridge")
const dummyAppPath = path.join(repoRoot, "test", "fixtures", "dummy-app.js")
const legacyDaemonPath = path.join(repoRoot, "test", "fixtures", "pre-split3-daemon-runner.js")
const partialGuardianPath = path.join(repoRoot, "test", "fixtures", "partial-owner-replacement-process-guardian.js")

test("partial owner-replacement guardian crosses the authenticated legacy bridge before retired-owner commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-partial-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const daemonPidPath = path.join(root, "daemon.pid")
  const releasePath = path.join(root, "v1")
  const packagePath = path.join(root, "candidate-package")
  const runtimePath = path.join(root, "runtime")
  const partialSocketPath = path.join(root, "partial-guardian.sock")
  let owner
  let partialGuardian
  let retainedConnection
  let backendGuardianIdentity

  try {
    await fs.mkdir(releasePath)
    await makeFifo(path.join(releasePath, "worker.fifo"))
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    assert.ok(owner.pid)
    await fs.writeFile(daemonPidPath, `${owner.pid}\n`)
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: socketPath})
    const before = await sendControlCommand({command: {command: "status"}, path: socketPath})
    const workerPid = releaseProcessPid(before, "v1", "worker")
    const webPid = releaseProcessPid(before, "v1", "web")
    const proxyPort = /** @type {{port?: number}} */ (before.proxy).port
    const state = JSON.parse(await fs.readFile(statePath, "utf8"))

    if (typeof proxyPort !== "number") throw new Error("Partial guardian fixture proxy is missing its bound port")

    backendGuardianIdentity = {...state.recovery.guardian}
    partialGuardian = await startPartialGuardian({
      backendPath: state.recovery.guardian.socketPath,
      mode: "partial",
      socketPath: partialSocketPath,
      token: state.recovery.guardian.token
    })
    state.recovery.guardian = {...state.recovery.guardian, pid: partialGuardian.pid, socketPath: partialSocketPath}
    await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)
    retainedConnection = await openWebSocket(proxyPort)
    const retainedClosed = once(retainedConnection, "close")
    await fs.rm(socketPath)
    await prepareCandidatePackage(packagePath)
    const ownerExit = once(owner, "exit")
    const ensured = await runEnsureDaemon({configPath, daemonPidPath, logPath: path.join(root, "candidate.log"), packagePath, runtimePath})

    assert.equal(ensured.code, 0, `${ensured.stderr}\n${await fs.readFile(path.join(root, "candidate.log"), "utf8")}`)
    assert.deepEqual(await ownerExit, [null, "SIGKILL"], "the exact authenticated incumbent boundary is crossed once")
    await retainedClosed
    const status = await sendControlCommand({command: {command: "status"}, path: socketPath})

    assert.equal(status.activeReleaseId, "v1")
    assert.equal(releaseProcessPid(status, "v1", "worker"), workerPid)
    assert.equal(releaseProcessPid(status, "v1", "web"), webPid)
    assert.deepEqual(status.ownerTransition, {
      disruptive: true,
      mode: "legacy-first-upgrade",
      reason: "retained guardian and daemon lacked atomic replacement protocol"
    })
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: socketPath})

    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    retainedConnection?.destroy()
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, "exit")

      owner.kill("SIGKILL")
      await exited
    }
    partialGuardian?.kill("SIGTERM")
    if (partialGuardian && partialGuardian.exitCode === null && partialGuardian.signalCode === null) await once(partialGuardian, "exit")
    if (backendGuardianIdentity) {
      const state = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "null"))

      if (state?.recovery?.guardian?.socketPath === partialSocketPath) {
        state.recovery.guardian = backendGuardianIdentity
        await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)
      }
    }
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("partial guardian replacement remains fenced through coordinator reconstruction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-partial-fence-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const releasePath = path.join(root, "v1")
  const partialSocketPath = path.join(root, "partial-guardian.sock")
  const restoreStarted = deferred()
  const continueRestore = deferred()
  let owner
  let partialGuardian
  let candidate = /** @type {RollbridgeDaemon | undefined} */ (undefined)
  let contender = /** @type {GuardianClient | undefined} */ (undefined)
  let backendGuardianIdentity
  let replacementPromise = /** @type {Promise<void> | undefined} */ (undefined)

  try {
    await fs.mkdir(releasePath)
    await makeFifo(path.join(releasePath, "worker.fifo"))
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    assert.ok(owner.pid)
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: socketPath})
    const state = JSON.parse(await fs.readFile(statePath, "utf8"))

    backendGuardianIdentity = {...state.recovery.guardian}
    partialGuardian = await startPartialGuardian({
      backendPath: backendGuardianIdentity.socketPath,
      mode: "partial",
      socketPath: partialSocketPath,
      token: backendGuardianIdentity.token
    })
    state.recovery.guardian = {...backendGuardianIdentity, pid: partialGuardian.pid, socketPath: partialSocketPath}
    await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)
    const replacement = new RollbridgeDaemon({
      config: normalizeConfig(config({controlPath: socketPath, extraCompanion: false, statePath})),
      configPath,
      legacyIncumbentPid: owner.pid,
      logger: () => {}
    })
    candidate = replacement
    replacement.restoreOwnerState = async () => {
      restoreStarted.resolve(undefined)
      await continueRestore.promise
      throw new Error("injected reconstruction stop after fence audit")
    }
    replacementPromise = replacement.replaceIncompatibleOwner()
    void replacementPromise.catch(() => {})
    await restoreStarted.promise
    assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).recovery.guardian.socketPath, partialSocketPath)

    let mutationError

    try {
      await sendControlCommand({command: {command: "restart", processId: "missing"}, path: socketPath})
    } catch (error) {
      mutationError = error
    }
    contender = new GuardianClient({pid: partialGuardian.pid, socketPath: partialSocketPath, token: backendGuardianIdentity.token})
    await contender.connect()
    let contenderError
    let contenderPrepared

    try {
      contenderPrepared = await contender.prepareOwnerReplacement(
        {configDigest: state.recovery.configDigest, runtime: state.daemonRuntime ?? null},
        {configDigest: "contender", runtime: null}
      )
    } catch (error) {
      contenderError = error
    }
    if (contenderPrepared) await contender.abortOwnerReplacement(contenderPrepared.replacementId)
    contender.disconnect()
    contender = undefined
    continueRestore.resolve(undefined)
    await assert.rejects(replacementPromise, /injected reconstruction stop after fence audit/)
    replacementPromise = undefined
    assert.match(mutationError instanceof Error ? mutationError.message : "", /fenced while an owner replacement is prepared/)
    assert.match(contenderError instanceof Error ? contenderError.message : "", /another owner replacement candidate is already prepared/i)
    assert.notEqual(JSON.parse(await fs.readFile(statePath, "utf8")).recovery.guardian.socketPath, `${statePath}.split3-guardian.sock`)
    assert.equal((await sendControlCommand({command: {command: "status"}, path: socketPath})).daemonPid, owner.pid)
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: socketPath})

    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    continueRestore.resolve(undefined)
    contender?.disconnect()
    await replacementPromise?.catch(() => undefined)
    candidate?.guardian?.disconnect()
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, "exit")

      owner.kill("SIGKILL")
      await exited
    }
    partialGuardian?.kill("SIGTERM")
    if (partialGuardian && partialGuardian.exitCode === null && partialGuardian.signalCode === null) await once(partialGuardian, "exit")
    if (backendGuardianIdentity) {
      const state = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "null"))

      if (state?.recovery?.guardian?.socketPath === partialSocketPath) {
        state.recovery.guardian = backendGuardianIdentity
        await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)
      }
    }
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("partial guardian replacement persists the coordinator only after ownership confirmation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-partial-persist-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const releasePath = path.join(root, "v1")
  const partialSocketPath = path.join(root, "partial-guardian.sock")
  const ownershipConfirmationStarted = deferred()
  const continueOwnershipConfirmation = deferred()
  let owner
  let partialGuardian
  let candidate = /** @type {RollbridgeDaemon | undefined} */ (undefined)
  let backendGuardianIdentity
  let replacementPromise = /** @type {Promise<void> | undefined} */ (undefined)

  try {
    await fs.mkdir(releasePath)
    await makeFifo(path.join(releasePath, "worker.fifo"))
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    assert.ok(owner.pid)
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: socketPath})
    const state = JSON.parse(await fs.readFile(statePath, "utf8"))

    backendGuardianIdentity = {...state.recovery.guardian}
    partialGuardian = await startPartialGuardian({
      backendPath: backendGuardianIdentity.socketPath,
      mode: "partial",
      socketPath: partialSocketPath,
      token: backendGuardianIdentity.token
    })
    state.recovery.guardian = {...backendGuardianIdentity, pid: partialGuardian.pid, socketPath: partialSocketPath}
    await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)
    const replacement = new RollbridgeDaemon({
      config: normalizeConfig(config({controlPath: socketPath, extraCompanion: false, statePath})),
      configPath,
      legacyIncumbentPid: owner.pid,
      logger: () => {}
    })
    const restoreOwnerState = replacement.restoreOwnerState.bind(replacement)

    candidate = replacement
    replacement.restoreOwnerState = async (...args) => {
      await restoreOwnerState(...args)
      const coordinator = replacement.guardian

      if (!coordinator) throw new Error("Partial guardian persistence fixture is missing its coordinator")
      const completeLegacyOwnerClaim = coordinator.completeLegacyOwnerClaim.bind(coordinator)

      coordinator.completeLegacyOwnerClaim = async (replacementId) => {
        ownershipConfirmationStarted.resolve(undefined)
        await continueOwnershipConfirmation.promise
        await completeLegacyOwnerClaim(replacementId)
      }
    }
    replacementPromise = replacement.replaceIncompatibleOwner()
    void replacementPromise.catch(() => {})
    await ownershipConfirmationStarted.promise
    assert.notEqual(
      JSON.parse(await fs.readFile(statePath, "utf8")).recovery.guardian.socketPath,
      `${statePath}.split3-guardian.sock`,
      "durable state must not name the coordinator before its legacy ownership claim is confirmed"
    )
    continueOwnershipConfirmation.resolve(undefined)
    await replacementPromise
    replacementPromise = undefined
    const shutdown = replacement.shutdown()

    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
    candidate = undefined
  } finally {
    continueOwnershipConfirmation.resolve(undefined)
    await replacementPromise?.catch(() => undefined)
    if (candidate?.controlServer || candidate?.proxyServer) {
      const shutdown = candidate.shutdown().catch(() => undefined)

      await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n").catch(() => undefined)
      await shutdown
    }
    candidate?.guardian?.disconnect()
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, "exit")

      owner.kill("SIGKILL")
      await exited
    }
    partialGuardian?.kill("SIGTERM")
    if (partialGuardian && partialGuardian.exitCode === null && partialGuardian.signalCode === null) await once(partialGuardian, "exit")
    if (backendGuardianIdentity) {
      const state = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "null"))

      if (state?.recovery?.guardian?.socketPath === partialSocketPath) {
        state.recovery.guardian = backendGuardianIdentity
        await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)
      }
    }
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("failed partial upgrade resumes an incumbent retired release drain", {timeout: 5000}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-partial-drain-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const v1Path = path.join(root, "v1")
  const v2Path = path.join(root, "v2")
  const partialSocketPath = path.join(root, "partial-guardian.sock")
  let owner
  let partialGuardian
  let retainedConnection
  let candidate = /** @type {RollbridgeDaemon | undefined} */ (undefined)
  let backendGuardianIdentity

  try {
    await Promise.all([fs.mkdir(v1Path), fs.mkdir(v2Path)])
    await Promise.all([makeFifo(path.join(v1Path, "worker.fifo")), makeFifo(path.join(v2Path, "worker.fifo"))])
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    assert.ok(owner.pid)
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath: v1Path, revision: "v1"}, path: socketPath})
    const v1Status = await sendControlCommand({command: {command: "status"}, path: socketPath})
    const proxyPort = /** @type {{port?: number}} */ (v1Status.proxy).port

    if (typeof proxyPort !== "number") throw new Error("Partial guardian drain fixture proxy is missing its bound port")
    retainedConnection = await openWebSocket(proxyPort)
    await sendControlCommand({command: {command: "deploy", releaseId: "v2", releasePath: v2Path, revision: "v2"}, path: socketPath})
    const draining = await sendControlCommand({command: {command: "status"}, path: socketPath})

    assert.equal(releaseState(draining, "v1"), "draining")
    const state = JSON.parse(await fs.readFile(statePath, "utf8"))

    backendGuardianIdentity = {...state.recovery.guardian}
    partialGuardian = await startPartialGuardian({
      backendPath: backendGuardianIdentity.socketPath,
      mode: "wrong-provenance",
      socketPath: partialSocketPath,
      token: backendGuardianIdentity.token
    })
    state.recovery.guardian = {...backendGuardianIdentity, pid: partialGuardian.pid, socketPath: partialSocketPath}
    await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)
    const replacement = new RollbridgeDaemon({
      config: normalizeConfig(config({controlPath: socketPath, extraCompanion: false, statePath})),
      configPath,
      legacyIncumbentPid: owner.pid,
      logger: () => {}
    })

    candidate = replacement
    await assert.rejects(() => replacement.replaceIncompatibleOwner(), /provenance mismatch/)
    assert.equal(owner.exitCode, null)
    assert.equal(owner.signalCode, null)
    const releaseDrained = waitForLog(owner, "release drained")

    retainedConnection.destroy()
    await fs.writeFile(path.join(v1Path, "worker.fifo"), "drained\n")
    await releaseDrained
    assert.equal(releaseState(await sendControlCommand({command: {command: "status"}, path: socketPath}), "v1"), "stopped")
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: socketPath})

    await fs.writeFile(path.join(v2Path, "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    retainedConnection?.destroy()
    candidate?.guardian?.disconnect()
    if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    partialGuardian?.kill("SIGTERM")
    if (partialGuardian && partialGuardian.exitCode === null && partialGuardian.signalCode === null) await once(partialGuardian, "exit")
    if (backendGuardianIdentity) {
      const state = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "null"))

      if (state?.recovery?.guardian?.socketPath === partialSocketPath) {
        state.recovery.guardian = backendGuardianIdentity
        await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)
      }
    }
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("partial guardian classification failures preserve the incumbent, children, and retained stream", async (t) => {
  for (const fault of ["malformed-capability", "wrong-pid", "wrong-provenance"]) {
    await t.test(fault, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `rollbridge-owner-replacement-partial-${fault}-`))
      const socketPath = path.join(root, "rollbridge.sock")
      const statePath = path.join(root, "state.json")
      const configPath = path.join(root, "rollbridge.cjs")
      const releasePath = path.join(root, "v1")
      const partialSocketPath = path.join(root, "partial-guardian.sock")
      let owner
      let partialGuardian
      let retainedConnection
      let candidate = /** @type {RollbridgeDaemon | undefined} */ (undefined)

      try {
        await fs.mkdir(releasePath)
        await makeFifo(path.join(releasePath, "worker.fifo"))
        await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, statePath}))
        owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
        await waitForLog(owner, "control socket listening")
        assert.ok(owner.pid)
        await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: socketPath})
        const before = await sendControlCommand({command: {command: "status"}, path: socketPath})
        const processPids = [releaseProcessPid(before, "v1", "worker"), releaseProcessPid(before, "v1", "web")]
        const proxyPort = /** @type {{port?: number}} */ (before.proxy).port
        const state = JSON.parse(await fs.readFile(statePath, "utf8"))
        const backendIdentity = {...state.recovery.guardian}

        if (typeof proxyPort !== "number") throw new Error("Partial guardian failure fixture proxy is missing its bound port")
        partialGuardian = await startPartialGuardian({
          backendPath: backendIdentity.socketPath,
          mode: fault === "wrong-provenance" ? fault : fault === "malformed-capability" ? fault : "partial",
          socketPath: partialSocketPath,
          token: backendIdentity.token
        })
        state.recovery.guardian = {
          ...backendIdentity,
          pid: fault === "wrong-pid" ? backendIdentity.pid : partialGuardian.pid,
          socketPath: partialSocketPath
        }
        await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)
        retainedConnection = await openWebSocket(proxyPort)
        let retainedClosed = false

        retainedConnection.once("close", () => { retainedClosed = true })
        const replacement = new RollbridgeDaemon({
          config: normalizeConfig(config({controlPath: socketPath, extraCompanion: false, statePath})),
          configPath,
          legacyIncumbentPid: owner.pid,
          logger: () => {}
        })
        candidate = replacement
        const expected = fault === "malformed-capability"
          ? /invalid owner-replacement capability response/
          : fault === "wrong-pid"
            ? /does not own socket|does not match the retained guardian command and socket/
            : /provenance mismatch/

        await assert.rejects(() => replacement.replaceIncompatibleOwner(), expected)
        assert.equal(owner.exitCode, null)
        assert.equal(owner.signalCode, null)
        assert.equal(retainedClosed, false)
        assert.equal(retainedConnection.destroyed, false)
        for (const pid of processPids) assert.doesNotThrow(() => process.kill(pid, 0))
        assert.equal(releaseProcessPid(await sendControlCommand({command: {command: "status"}, path: socketPath}), "v1", "worker"), processPids[0])
        await assert.rejects(fs.access(`${statePath}.split3-guardian.sock`), {code: "ENOENT"})

        const shutdown = sendControlCommand({command: {command: "shutdown"}, path: socketPath})

        await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
        await shutdown
      } finally {
        retainedConnection?.destroy()
        candidate?.guardian?.disconnect()
        if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
        partialGuardian?.kill("SIGTERM")
        if (partialGuardian && partialGuardian.exitCode === null && partialGuardian.signalCode === null) await once(partialGuardian, "exit")
        await stopGuardian(statePath)
        await fs.rm(root, {force: true, recursive: true})
      }
    })
  }
})

test("first pre-split package upgrade is explicitly disruptive and later replacements are atomic", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-legacy-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const nextSocketPath = path.join(root, "next.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const daemonPidPath = path.join(root, "daemon.pid")
  const releasePath = path.join(root, "v1")
  const runtimePath = path.join(root, "runtime")
  const firstPackagePath = path.join(root, "first-package")
  const secondPackagePath = path.join(root, "second-package")
  const proxyPort = await findAvailablePort({host: "127.0.0.1", range: {from: 25000, to: 25999}, usedPorts: new Set()})
  let owner
  let interruptedConnection
  let retainedConnection
  let blockedUpgradeGuardian
  let currentControlPath = socketPath

  try {
    await fs.mkdir(releasePath)
    await makeFifo(path.join(releasePath, "worker.fifo"))
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, proxyPort, statePath}))
    owner = spawn(process.execPath, [legacyDaemonPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    assert.ok(owner.pid)
    await fs.writeFile(daemonPidPath, `${owner.pid}\n`)
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: socketPath})
    const legacyStatus = await sendControlCommand({command: {command: "status"}, path: socketPath})
    const legacyWorkerPid = releaseProcessPid(legacyStatus, "v1", "worker")

    interruptedConnection = await openWebSocket(proxyPort)
    const interrupted = once(interruptedConnection, "close")
    await prepareCandidatePackage(firstPackagePath)
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: true, proxyPort, statePath}))
    const mismatchedUpgrade = await runEnsureDaemon({configPath, daemonPidPath, logPath: path.join(root, "mismatch.log"), packagePath: firstPackagePath, runtimePath})

    assert.equal(mismatchedUpgrade.code, 1)
    assert.match(await fs.readFile(path.join(root, "mismatch.log"), "utf8"), /legacy guardian bridge requires the incumbent config identity unchanged/)
    assert.equal(interruptedConnection.destroyed, false, "config mismatch must leave the legacy listener serving")
    assert.equal(releaseProcessPid(await sendControlCommand({command: {command: "status"}, path: socketPath}), "v1", "worker"), legacyWorkerPid)
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, proxyPort, statePath}))
    blockedUpgradeGuardian = net.createServer()

    await listenUnix(blockedUpgradeGuardian, `${statePath}.split3-guardian.sock`)
    const blockedUpgrade = await runEnsureDaemon({configPath, daemonPidPath, logPath: path.join(root, "blocked.log"), packagePath: firstPackagePath, runtimePath})

    assert.equal(blockedUpgrade.code, 1)
    assert.match(await fs.readFile(path.join(root, "blocked.log"), "utf8"), /Legacy upgrade guardian socket .* already exists; refusing legacy upgrade/)
    assert.equal(interruptedConnection.destroyed, false, "candidate preparation failure must leave the legacy listener serving")
    assert.equal(releaseProcessPid(await sendControlCommand({command: {command: "status"}, path: socketPath}), "v1", "worker"), legacyWorkerPid)
    await closeServer(blockedUpgradeGuardian)
    const firstUpgrade = await run(process.execPath, [
      path.join(firstPackagePath, "bin", "rollbridge"), "ensure-daemon", "--config", configPath,
      "--daemon-runtime-path", runtimePath, "--daemon-log-path", path.join(root, "first.log"),
      "--daemon-pid-path", daemonPidPath, "--daemon-start-timeout-ms", "3000"
    ])

    assert.equal(firstUpgrade.code, 0, `${firstUpgrade.stderr}\n${await fs.readFile(path.join(root, "first.log"), "utf8")}`)
    assert.deepEqual(JSON.parse(firstUpgrade.stdout).ownerTransition, {
      disruptive: true,
      mode: "legacy-first-upgrade",
      reason: "retained guardian and daemon lacked atomic replacement protocol"
    })
    await interrupted
    const bridged = await sendControlCommand({command: {command: "status"}, path: socketPath})

    assert.deepEqual(bridged.ownerTransition, {
      disruptive: true,
      mode: "legacy-first-upgrade",
      reason: "retained guardian and daemon lacked atomic replacement protocol"
    })
    assert.equal(releaseProcessPid(bridged, "v1", "worker"), legacyWorkerPid)
    assert.equal(bridged.activeReleaseId, "v1")

    retainedConnection = await openWebSocket(proxyPort)
    let retainedConnectionClosed = false
    retainedConnection.once("close", () => { retainedConnectionClosed = true })
    await prepareCandidatePackage(secondPackagePath)
    await writeConfig(configPath, config({controlPath: nextSocketPath, extraCompanion: true, proxyPort, statePath}))
    const secondUpgrade = await run(process.execPath, [
      path.join(secondPackagePath, "bin", "rollbridge"), "ensure-daemon", "--config", configPath,
      "--daemon-runtime-path", runtimePath, "--daemon-log-path", path.join(root, "second.log"),
      "--daemon-pid-path", daemonPidPath, "--daemon-start-timeout-ms", "3000"
    ])

    assert.equal(secondUpgrade.code, 0, `${secondUpgrade.stderr}\n${await fs.readFile(path.join(root, "second.log"), "utf8")}`)
    currentControlPath = nextSocketPath
    assert.equal(retainedConnectionClosed, false, "protocol-capable replacement must retain established proxy connections")
    const replaced = await sendControlCommand({command: {command: "status"}, path: nextSocketPath})

    assert.equal(releaseProcessPid(replaced, "v1", "worker"), legacyWorkerPid)
    assert.equal(replaced.activeReleaseId, "v1")
    retainedConnection.destroy()
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: nextSocketPath})
    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    interruptedConnection?.destroy()
    retainedConnection?.destroy()
    if (blockedUpgradeGuardian?.listening) await closeServer(blockedUpgradeGuardian).catch(() => undefined)
    if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    try {
      const status = await sendControlCommand({command: {command: "status"}, path: currentControlPath})

      if (status.activeReleaseId) {
        const shutdown = sendControlCommand({command: {command: "shutdown"}, path: currentControlPath}).catch(() => undefined)
        await Promise.all([fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n").catch(() => undefined), shutdown])
      }
    } catch (_error) {
      // The exact fixture daemon is already stopped or failed before publishing control.
    }
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("ensure-daemon owns and reports the exact candidate exit before readiness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-candidate-exit-"))
  const configPath = path.join(root, "rollbridge.cjs")
  const evidencePath = path.join(root, "candidate.json")
  const packagePath = path.join(root, "candidate-package")
  const runtimePath = path.join(root, "runtime")
  const socketPath = path.join(root, "rollbridge.sock")
  const statePath = path.join(root, "state.json")

  try {
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, statePath}))
    await prepareCandidatePackage(packagePath)
    await installCandidateExit(packagePath, evidencePath, 47)
    const ensured = await run(process.execPath, [
      path.join(packagePath, "bin", "rollbridge"), "ensure-daemon", "--config", configPath,
      "--daemon-runtime-path", runtimePath, "--daemon-log-path", path.join(root, "daemon.log"),
      "--daemon-pid-path", path.join(root, "daemon.pid"), "--daemon-start-timeout-ms", "3000"
    ])
    const candidate = JSON.parse(await fs.readFile(evidencePath, "utf8"))

    assert.equal(candidate.ppid, ensured.pid, "the recorded process must be the candidate spawned by this exact ensuring CLI")
    assert.notEqual(candidate.pid, ensured.pid)
    assert.deepEqual(candidate.argv.slice(2), ["daemon", "--config", configPath])
    assert.equal(ensured.code, 1)
    assert.match(ensured.stderr, new RegExp(`Rollbridge daemon candidate ${candidate.pid} exited before readiness \\(code 47, signal none\\)`))
    assert.doesNotMatch(ensured.stderr, /did not become ready within/)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("legacy disruptive bridge rejects non-protocol guardian failures exactly", () => {
  assert.equal(isLegacyGuardianPrepareDiagnostic("Guardian prepare-owner-replacement requires a process key"), true)
  assert.equal(isLegacyGuardianPrepareDiagnostic("Unknown guardian command: prepare-owner-replacement"), true)
  for (const diagnostic of [
    "Unknown guardian command: deploy",
    "Unknown guardian command: prepare-owner-replacement ",
    "Guardian authentication failed",
    "connect ECONNREFUSED /tmp/guardian.sock",
    "Process guardian connection closed while awaiting prepare-owner-replacement",
    "Guardian owner authority mismatch",
    "Malformed guardian response"
  ]) assert.equal(isLegacyGuardianPrepareDiagnostic(diagnostic), false, diagnostic)
})

test("ensure-daemon atomically replaces incompatible config, socket, and package authority", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-"))
  const oldSocketPath = path.join(root, "old.sock")
  const newSocketPath = path.join(root, "new.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const runtimePath = path.join(root, "runtime")
  const packagePath = path.join(root, "candidate-package")
  const v1Path = path.join(root, "v1")
  const v2Path = path.join(root, "v2")
  let owner

  try {
    await Promise.all([fs.mkdir(v1Path), fs.mkdir(v2Path)])
    await makeFifo(path.join(v1Path, "worker.fifo"))
    await makeFifo(path.join(v2Path, "worker.fifo"))
    await writeConfig(configPath, config({controlPath: oldSocketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath: v1Path, revision: "v1"}, path: oldSocketPath})
    const before = await sendControlCommand({command: {command: "status"}, path: oldSocketPath})
    const oldRuntime = /** @type {{digest: string}} */ (before.daemonRuntime)
    const workerPid = releaseProcessPid(before, "v1", "worker")

    await prepareCandidatePackage(packagePath, {dropCommitResponse: true})
    await writeConfig(configPath, config({controlPath: newSocketPath, extraCompanion: true, statePath}))
    const ensured = await run(process.execPath, [
      path.join(packagePath, "bin", "rollbridge"), "ensure-daemon", "--config", configPath,
      "--daemon-runtime-path", runtimePath, "--daemon-log-path", path.join(root, "daemon.log"),
      "--daemon-pid-path", path.join(root, "daemon.pid"), "--daemon-start-timeout-ms", "3000"
    ])

    const daemonLog = await fs.readFile(path.join(root, "daemon.log"), "utf8")

    assert.equal(ensured.code, 0, `${ensured.stderr}\n${daemonLog}`)
    const transferred = await sendControlCommand({command: {command: "status"}, path: newSocketPath})
    const newRuntime = /** @type {{digest: string, path: string}} */ (transferred.daemonRuntime)

    assert.equal(transferred.activeReleaseId, "v1")
    assert.deepEqual(transferred.releaseReferences, [{releaseId: "v1", releasePath: v1Path}])
    assert.equal(releaseProcessPid(transferred, "v1", "worker"), workerPid)
    assert.notEqual(newRuntime.digest, oldRuntime.digest)
    assert.equal(path.dirname(newRuntime.path), runtimePath)

    await fs.rm(packagePath, {force: true, recursive: true})
    await sendControlCommand({command: {command: "deploy", releaseId: "v2", releasePath: v2Path, revision: "v2"}, path: newSocketPath})
    const deployed = await sendControlCommand({command: {command: "status"}, path: newSocketPath})

    assert.equal(deployed.activeReleaseId, "v2")
    assert.deepEqual(deployed.releaseReferences, [
      {releaseId: "v1", releasePath: v1Path},
      {releaseId: "v2", releasePath: v2Path}
    ])
    assert.equal(releaseProcessPid(deployed, "v1", "worker"), workerPid)

    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: newSocketPath})
    await Promise.all([
      fs.writeFile(path.join(v1Path, "worker.fifo"), "drained\n"),
      fs.writeFile(path.join(v2Path, "worker.fifo"), "drained\n")
    ])
    await shutdown
  } finally {
    if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("cross-version replacement fails closed without dropping a retained WebSocket after the public socket is removed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-retired-control-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const statePath = path.join(root, "state.json")
  const compatibilitySocketPath = path.join(root, "retained-guardian.sock")
  const configPath = path.join(root, "rollbridge.cjs")
  const releasePath = path.join(root, "v1")
  const compatibilitySockets = new Set()
  let compatibilityGuardian
  let committedProcessKey
  let retainedGuardianSocketPath = /** @type {string | undefined} */ (undefined)
  let owner = /** @type {import("node:child_process").ChildProcess | undefined} */ (undefined)
  let replacement = /** @type {RollbridgeDaemon | undefined} */ (undefined)
  let retainedConnection
  let retainedConnectionClosed = false
  let transactionAudit

  try {
    await fs.mkdir(releasePath)
    await makeFifo(path.join(releasePath, "worker.fifo"))
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: socketPath})
    const retired = await sendControlCommand({command: {command: "status"}, path: socketPath})
    const retiredReleases = /** @type {{processes: {id: string, pid?: number, state: string}[]}[]} */ (retired.releases)
    const processState = retiredReleases[0]?.processes.map(({id, pid, state}) => ({id, pid, state}))
    const proxyPort = /** @type {{port?: number}} */ (retired.proxy).port

    assert.deepEqual(processState?.map(({state}) => state), ["running", "running"])
    if (typeof proxyPort !== "number") throw new Error("Retained owner proxy is missing its port")
    retainedConnection = await openWebSocket(proxyPort)
    retainedConnection.once("close", () => { retainedConnectionClosed = true })
    await fs.rm(socketPath)
    await assert.rejects(fs.access(socketPath), {code: "ENOENT"})
    const state = JSON.parse(await fs.readFile(statePath, "utf8"))
    const guardianSocketPath = state.recovery.guardian.socketPath
    const expectedProcessKey = "release:v1:worker"

    if (typeof guardianSocketPath !== "string") throw new Error("Retained guardian state is missing its socket path")
    retainedGuardianSocketPath = guardianSocketPath

    compatibilityGuardian = net.createServer((candidateSocket) => {
      const guardianSocket = net.createConnection(guardianSocketPath)
      let buffer = ""

      compatibilitySockets.add(candidateSocket)
      compatibilitySockets.add(guardianSocket)
      candidateSocket.setEncoding("utf8")
      candidateSocket.once("close", () => {
        compatibilitySockets.delete(candidateSocket)
        guardianSocket.destroy()
      })
      guardianSocket.once("close", () => {
        compatibilitySockets.delete(guardianSocket)
        candidateSocket.destroy()
      })
      guardianSocket.on("data", (chunk) => candidateSocket.write(chunk))
      candidateSocket.on("data", (chunk) => {
        buffer += chunk
        let newline = buffer.indexOf("\n")

        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          const request = JSON.parse(line)

          buffer = buffer.slice(newline + 1)
          if (request.command === "commit-retired-owner-replacement") {
            if (request.key !== expectedProcessKey) {
              candidateSocket.write(`${JSON.stringify({error: `Guardian ${request.command} requires a process key`, id: request.id})}\n`)
            } else {
              committedProcessKey = request.key
              candidateSocket.write(`${JSON.stringify({error: `Guardian ${request.command} requires the committed owner`, id: request.id})}\n`)
            }
            newline = buffer.indexOf("\n")
            continue
          }
          guardianSocket.write(`${line}\n`)
          newline = buffer.indexOf("\n")
        }
      })
    })
    await listenUnix(compatibilityGuardian, compatibilitySocketPath)
    state.recovery.guardian.socketPath = compatibilitySocketPath
    await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)

    const incumbentPid = owner.pid

    assert.ok(incumbentPid)
    const candidate = new RollbridgeDaemon({
      config: normalizeConfig(config({controlPath: socketPath, extraCompanion: false, statePath})),
      configPath,
      legacyIncumbentPid: incumbentPid,
      logger: () => {}
    })
    replacement = candidate
    await assert.rejects(
      () => candidate.replaceIncompatibleOwner(),
      /cannot safely complete atomic owner replacement through the older retained guardian while the incumbent control socket is absent; incumbent owner and connections were preserved/i
    )
    assert.equal(committedProcessKey, expectedProcessKey)
    assert.equal(owner.exitCode, null)
    assert.equal(owner.signalCode, null)
    assert.doesNotThrow(() => process.kill(incumbentPid, 0))
    assert.equal(retainedConnectionClosed, false, "failed compatibility handoff must leave retained connections serving")
    assert.equal(retainedConnection.destroyed, false, "failed compatibility handoff must preserve the incumbent listener")
    for (const {pid} of processState || []) {
      if (typeof pid !== "number") throw new Error("Retained process is missing its PID")
      assert.doesNotThrow(() => process.kill(pid, 0))
    }
    transactionAudit = new GuardianClient(state.recovery.guardian)
    await transactionAudit.connect()
    const transactionStatus = /** @type {{committedReplacementId: string | null, ownerClaimed: boolean, retirementPending?: boolean}} */ (await transactionAudit.replacementStatus())

    assert.equal(transactionStatus.committedReplacementId, null)
    assert.equal(transactionStatus.ownerClaimed, true)
    assert.equal(transactionStatus.retirementPending, false)
  } finally {
    if (replacement?.controlCommandsReady) {
      await Promise.all([
        fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n").catch(() => {}),
        replacement.shutdown().catch(() => {})
      ])
    }
    transactionAudit?.disconnect()
    retainedConnection?.destroy()
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL")
      await once(owner, "exit")
    }
    replacement?.guardian?.disconnect()
    for (const socket of compatibilitySockets) socket.destroy()
    if (compatibilityGuardian?.listening) await closeServer(compatibilityGuardian)
    if (retainedGuardianSocketPath) {
      const cleanupState = JSON.parse(await fs.readFile(statePath, "utf8"))

      cleanupState.recovery.guardian.socketPath = retainedGuardianSocketPath
      await fs.writeFile(statePath, `${JSON.stringify(cleanupState)}\n`)
    }
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("cross-version replacement preserves committed-owner proof until commit then recovers every process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-committed-proof-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const statePath = path.join(root, "state.json")
  const compatibilitySocketPath = path.join(root, "retained-guardian.sock")
  const releasePath = path.join(root, "v1")
  const daemonConfig = normalizeConfig(config({controlPath: socketPath, extraCompanion: false, statePath}))
  const owner = new RollbridgeDaemon({config: daemonConfig, logger: () => {}})
  const compatibilitySockets = new Set()
  const candidateProcessKey = "release:candidate:worker"
  const committedOwnerProcessKey = "release:v1:worker"
  const candidateRecoveredKeys = new Set()
  let compatibilityGuardian
  let committedProcessKey
  let recoveredKeysAtCommit = /** @type {Set<string> | undefined} */ (undefined)
  let retainedConnection
  let retainedConnectionClosed = false
  let retainedGuardianSocketPath = /** @type {string | undefined} */ (undefined)
  /** @type {RollbridgeDaemon | undefined} */
  let replacement

  try {
    await fs.mkdir(releasePath)
    await makeFifo(path.join(releasePath, "worker.fifo"))
    await owner.start()
    await owner.deploy({releaseId: "v1", releasePath, revision: "v1"})
    const ownerProcess = owner.guardian?.processes.values().next().value

    assert.ok(owner.guardian)
    assert.ok(ownerProcess)
    await owner.guardian.request({
      command: "register",
      definition: ownerProcess.definition,
      key: candidateProcessKey,
      provenance: ownerProcess.provenance
    })
    const running = owner.status()
    const processState = running.releases[0]?.processes.map(({id, pid, state}) => ({id, pid, state}))
    const expectedProcessKeys = new Set(running.releases[0]?.processes.map(({id}) => `release:v1:${id}`))
    const proxyPort = /** @type {{port?: number}} */ (running.proxy).port

    assert.deepEqual(processState?.map(({state}) => state), ["running", "running"])
    if (typeof proxyPort !== "number") throw new Error("Retained owner proxy is missing its port")
    retainedConnection = await openWebSocket(proxyPort)
    retainedConnection.once("close", () => { retainedConnectionClosed = true })
    await owner.closeServer(owner.controlServer)
    await owner.removeControlSocket()
    const state = JSON.parse(await fs.readFile(statePath, "utf8"))
    const guardianSocketPath = state.recovery.guardian.socketPath

    if (typeof guardianSocketPath !== "string") throw new Error("Retained guardian state is missing its socket path")
    retainedGuardianSocketPath = guardianSocketPath
    compatibilityGuardian = net.createServer((candidateSocket) => {
      const guardianSocket = net.createConnection(guardianSocketPath)
      let buffer = ""

      compatibilitySockets.add(candidateSocket)
      compatibilitySockets.add(guardianSocket)
      candidateSocket.setEncoding("utf8")
      candidateSocket.once("close", () => {
        compatibilitySockets.delete(candidateSocket)
        guardianSocket.destroy()
      })
      guardianSocket.once("close", () => {
        compatibilitySockets.delete(guardianSocket)
        candidateSocket.destroy()
      })
      guardianSocket.on("data", (chunk) => candidateSocket.write(chunk))
      candidateSocket.on("data", (chunk) => {
        buffer += chunk
        let newline = buffer.indexOf("\n")

        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          const request = JSON.parse(line)

          buffer = buffer.slice(newline + 1)
          if (request.command === "register") candidateRecoveredKeys.add(request.key)
          if (request.command === "commit-retired-owner-replacement") {
            committedProcessKey = request.key
            recoveredKeysAtCommit = new Set(candidateRecoveredKeys)
            if (candidateRecoveredKeys.has(request.key)) {
              candidateSocket.write(`${JSON.stringify({error: `Guardian ${request.command} requires the committed owner`, id: request.id})}\n`)
              newline = buffer.indexOf("\n")
              continue
            }
          }
          guardianSocket.write(`${line}\n`)
          newline = buffer.indexOf("\n")
        }
      })
    })
    await listenUnix(compatibilityGuardian, compatibilitySocketPath)
    state.recovery.guardian.socketPath = compatibilitySocketPath
    await fs.writeFile(statePath, `${JSON.stringify(state)}\n`)

    assert.equal((await owner.guardian?.replacementStatus())?.ownerClaimed, true)
    await assert.rejects(fs.access(socketPath), {code: "ENOENT"})

    replacement = new RollbridgeDaemon({
      config: daemonConfig,
      logger: (message) => {
        if (message !== "owner replacement candidate prepared" || !replacement?.guardian) return
        const guardian = replacement.guardian
        const recoveredProcess = guardian.processes.values().next().value

        if (!recoveredProcess) throw new Error("Replacement did not reconstruct a guardian process")
        guardian.processes = new Map([[candidateProcessKey, recoveredProcess], ...guardian.processes])
        const commitRetiredOwnerReplacement = guardian.commitRetiredOwnerReplacement.bind(guardian)

        guardian.commitRetiredOwnerReplacement = async (replacementId, processKey) => {
          committedProcessKey = processKey
          await commitRetiredOwnerReplacement(replacementId, processKey)
        }
      }
    })
    await replacement.replaceIncompatibleOwner()
    const recovered = await sendControlCommand({command: {command: "status"}, path: socketPath})
    const recoveredReleases = /** @type {{processes: {id: string, pid?: number, state: string}[]}[]} */ (recovered.releases)

    assert.equal(recovered.activeReleaseId, "v1")
    assert.equal(committedProcessKey, committedOwnerProcessKey)
    assert.equal(recoveredKeysAtCommit?.has(committedOwnerProcessKey), false)
    assert.deepEqual(candidateRecoveredKeys, expectedProcessKeys)
    assert.equal([...replacement.guardian?.processes.keys() || []][0], candidateProcessKey)
    assert.equal(retainedConnectionClosed, false, "successful compatibility handoff must preserve retained connections")
    assert.equal(retainedConnection.destroyed, false, "successful compatibility handoff must leave the retained listener serving")
    assert.deepEqual(recovered.releaseReferences, [{releaseId: "v1", releasePath}])
    assert.deepEqual(recoveredReleases[0]?.processes.map(({id, pid, state}) => ({id, pid, state})), processState)
    for (const {pid} of processState || []) {
      if (typeof pid !== "number") throw new Error("Retained process is missing its PID")
      assert.doesNotThrow(() => process.kill(pid, 0))
    }
  } finally {
    if (retainedGuardianSocketPath) {
      const cleanupState = JSON.parse(await fs.readFile(statePath, "utf8"))

      cleanupState.recovery.guardian.socketPath = retainedGuardianSocketPath
      await fs.writeFile(statePath, `${JSON.stringify(cleanupState)}\n`)
    }
    const shutdown = replacement?.controlCommandsReady ? replacement.shutdown().catch(() => {}) : owner.shutdown().catch(() => {})

    retainedConnection?.destroy()
    await owner.closeServer(owner.proxyServer)
    await Promise.all([fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n").catch(() => {}), shutdown])
    owner.guardian?.disconnect()
    replacement?.guardian?.disconnect()
    for (const socket of compatibilitySockets) socket.destroy()
    if (compatibilityGuardian?.listening) await closeServer(compatibilityGuardian)
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("replacement refuses to overwrite an unrelated live final control socket and preserves the owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-fence-"))
  const oldSocketPath = path.join(root, "old.sock")
  const occupiedSocketPath = path.join(root, "occupied.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const blockerSockets = new Set()
  const blocker = net.createServer((socket) => {
    blockerSockets.add(socket)
    socket.once("close", () => blockerSockets.delete(socket))
    socket.end(`${JSON.stringify({application: "unrelated", status: "success"})}\n`)
  })
  let owner

  try {
    await fs.mkdir(path.join(root, "v1"))
    await makeFifo(path.join(root, "v1", "worker.fifo"))
    await writeConfig(configPath, config({controlPath: oldSocketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath: path.join(root, "v1"), revision: "v1"}, path: oldSocketPath})
    await new Promise((resolve, reject) => blocker.listen(occupiedSocketPath, () => resolve(undefined)).once("error", reject))
    await writeConfig(configPath, config({controlPath: occupiedSocketPath, extraCompanion: true, statePath}))

    const replacement = await run(process.execPath, [
      binPath, "ensure-daemon", "--config", configPath,
      "--daemon-runtime-path", path.join(root, "runtime"), "--daemon-log-path", path.join(root, "daemon.log"),
      "--daemon-pid-path", path.join(root, "daemon.pid"), "--daemon-start-timeout-ms", "1500"
    ])

    assert.notEqual(replacement.code, 0)
    assert.match(await fs.readFile(path.join(root, "daemon.log"), "utf8"), /final control socket.*already answers another live process/)
    assert.equal((await sendControlCommand({command: {command: "status"}, path: oldSocketPath})).activeReleaseId, "v1")

    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: oldSocketPath})
    await fs.writeFile(path.join(root, "v1", "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    for (const socket of blockerSockets) socket.destroy()
    if (blocker.listening) await new Promise((resolve) => blocker.close(() => resolve(undefined)))
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("a committed replacement crash converges from stale public state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-crash-"))
  const oldSocketPath = path.join(root, "old.sock")
  const newSocketPath = path.join(root, "new.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const releasePath = path.join(root, "v1")
  let owner
  let candidate
  let recovered

  try {
    await fs.mkdir(releasePath)
    await makeFifo(path.join(releasePath, "worker.fifo"))
    await writeConfig(configPath, config({controlPath: oldSocketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: oldSocketPath})
    const staleState = await fs.readFile(statePath, "utf8")

    await writeConfig(configPath, config({controlPath: newSocketPath, extraCompanion: true, statePath}))
    candidate = spawn(process.execPath, [binPath, "daemon", "--config", configPath, "--replace-owner"], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(candidate, "owner replacement committed")
    candidate.kill("SIGKILL")
    await once(candidate, "exit")
    await fs.writeFile(statePath, staleState)

    recovered = spawn(process.execPath, [binPath, "daemon", "--config", configPath, "--replace-owner"], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(recovered, "owner replacement committed")
    const status = await sendControlCommand({command: {command: "status"}, path: newSocketPath})

    assert.equal(status.activeReleaseId, "v1")
    assert.deepEqual(status.releaseReferences, [{releaseId: "v1", releasePath}])
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: newSocketPath})
    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    for (const child of [owner, candidate, recovered]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("replacement transfers an unchanged fixed proxy listener without reusePort", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-fixed-proxy-"))
  const oldSocketPath = path.join(root, "old.sock")
  const newSocketPath = path.join(root, "new.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const releasePath = path.join(root, "v1")
  const proxyPort = await findAvailablePort({host: "127.0.0.1", range: {from: 24000, to: 24999}, usedPorts: new Set()})
  let owner
  let candidate

  try {
    await fs.mkdir(releasePath)
    await makeFifo(path.join(releasePath, "worker.fifo"))
    await writeConfig(configPath, config({controlPath: oldSocketPath, extraCompanion: false, proxyPort, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: oldSocketPath})
    await writeConfig(configPath, config({controlPath: newSocketPath, extraCompanion: true, proxyPort, statePath}))

    candidate = spawn(process.execPath, [binPath, "daemon", "--config", configPath, "--replace-owner"], {stdio: ["ignore", "pipe", "pipe"]})
    const output = await collectUntilExitOrLog(candidate, "owner replacement committed")

    assert.equal(output.message, "owner replacement committed", output.output)
    const status = await sendControlCommand({command: {command: "status"}, path: newSocketPath})
    const proxy = /** @type {{port: number}} */ (status.proxy)

    assert.equal(proxy.port, proxyPort)
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: newSocketPath})
    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    for (const child of [owner, candidate]) if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("owner replacement preserves committed generation metadata without firing lifecycle hooks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-generation-"))
  const oldSocketPath = path.join(root, "old.sock")
  const newSocketPath = path.join(root, "new.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const releasePath = path.join(root, "v1")
  const lifecycleLogPath = path.join(root, "generation.lifecycle")
  let owner
  let candidate

  try {
    await fs.mkdir(releasePath)
    await makeFifo(path.join(releasePath, "worker.fifo"))
    await writeConfig(configPath, config({activationLogPath: lifecycleLogPath, controlPath: oldSocketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: oldSocketPath})
    assert.equal(await fs.readFile(lifecycleLogPath, "utf8"), "activate:v1\n")

    await writeConfig(configPath, config({activationLogPath: lifecycleLogPath, controlPath: newSocketPath, extraCompanion: true, statePath}))
    candidate = spawn(process.execPath, [binPath, "daemon", "--config", configPath, "--replace-owner"], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(candidate, "owner replacement committed")

    const status = await sendControlCommand({command: {command: "status"}, path: newSocketPath})
    const generationTransition = status.generationTransition

    assert.equal(status.activeReleaseId, "v1")
    assert.ok(generationTransition && typeof generationTransition === "object" && !Array.isArray(generationTransition))
    assert.equal(generationTransition.phase, "committed")
    assert.equal(await fs.readFile(lifecycleLogPath, "utf8"), "activate:v1\n", "owner replacement must not reactivate an already committed generation")

    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: newSocketPath})
    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    for (const child of [owner, candidate]) if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("owner replacement excludes stopped retained releases from reserved process recovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-stopped-proof-"))
  const oldSocketPath = path.join(root, "old.sock")
  const newSocketPath = path.join(root, "new.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const v1Path = path.join(root, "v1")
  const v2Path = path.join(root, "v2")
  let owner
  let candidate

  try {
    await Promise.all([fs.mkdir(v1Path), fs.mkdir(v2Path)])
    await Promise.all([makeFifo(path.join(v1Path, "worker.fifo")), makeFifo(path.join(v2Path, "worker.fifo"))])
    await writeConfig(configPath, config({controlPath: oldSocketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath: v1Path, revision: "v1"}, path: oldSocketPath})
    const stopped = sendControlCommand({command: {command: "stop", releaseId: "v1"}, path: oldSocketPath})

    await fs.writeFile(path.join(v1Path, "worker.fifo"), "drained\n")
    await stopped
    await sendControlCommand({command: {command: "deploy", releaseId: "v2", releasePath: v2Path, revision: "v2"}, path: oldSocketPath})
    const before = await sendControlCommand({command: {command: "status"}, path: oldSocketPath})
    const activeWorkerPid = releaseProcessPid(before, "v2", "worker")
    const retained = /** @type {{releaseId: string, state: string}[]} */ (before.releases)

    assert.equal(retained.find(({releaseId}) => releaseId === "v1")?.state, "stopped")
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"))
    const guardian = new GuardianClient(persisted.recovery.guardian)

    await guardian.connect()
    assert.ok((await guardian.inventory()).some(({key}) => key === "release:v1:worker"), "stopped release registration remains in authenticated guardian inventory")
    guardian.disconnect()
    await writeConfig(configPath, config({controlPath: newSocketPath, extraCompanion: true, statePath}))
    candidate = spawn(process.execPath, [binPath, "daemon", "--config", configPath, "--replace-owner"], {stdio: ["ignore", "pipe", "pipe"]})
    const output = await collectUntilExitOrLog(candidate, "owner replacement committed")

    assert.equal(output.message, "owner replacement committed", output.output)
    const recovered = await sendControlCommand({command: {command: "status"}, path: newSocketPath})

    assert.equal(recovered.activeReleaseId, "v2")
    assert.equal(releaseProcessPid(recovered, "v2", "worker"), activeWorkerPid)
    assert.equal(/** @type {{releaseId: string}[]} */ (recovered.releases).some(({releaseId}) => releaseId === "v1"), false)
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: newSocketPath})

    await fs.writeFile(path.join(v2Path, "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    for (const child of [owner, candidate]) if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("owner replacement preserves a failed generation transition without retrying its hook", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-failed-generation-"))
  const oldSocketPath = path.join(root, "old.sock")
  const newSocketPath = path.join(root, "new.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const lifecycleLogPath = path.join(root, "generation.lifecycle")
  const v1Path = path.join(root, "v1")
  const v2Path = path.join(root, "v2")
  let owner
  let candidate
  const failedConfig = (/** @type {string} */ controlPath, /** @type {boolean} */ extraCompanion) => {
    const raw = config({activationLogPath: lifecycleLogPath, controlPath, extraCompanion, statePath})
    const processes = /** @type {Record<string, import("../src/json.js").JsonValue>[]} */ (raw.processes)
    const generationMain = processes.find((processConfig) => processConfig.id === "generation-main")
    const lifecycle = /** @type {Record<string, import("../src/json.js").JsonValue>} */ (generationMain?.lifecycle)

    lifecycle.activateCommand = `[ "$ROLLBRIDGE_RELEASE_ID" != v2 ] || exit 24; printf 'activate:%s\\n' "$ROLLBRIDGE_RELEASE_ID" >> ${JSON.stringify(lifecycleLogPath)}`
    return raw
  }

  try {
    await Promise.all([fs.mkdir(v1Path), fs.mkdir(v2Path)])
    await Promise.all([makeFifo(path.join(v1Path, "worker.fifo")), makeFifo(path.join(v2Path, "worker.fifo"))])
    await writeConfig(configPath, failedConfig(oldSocketPath, false))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath: v1Path, revision: "v1"}, path: oldSocketPath})
    await assert.rejects(sendControlCommand({command: {command: "deploy", releaseId: "v2", releasePath: v2Path, revision: "v2"}, path: oldSocketPath}), /activate command exited non-zero/)
    assert.equal(await fs.readFile(lifecycleLogPath, "utf8"), "activate:v1\nretire:v1\n")

    await writeConfig(configPath, failedConfig(newSocketPath, true))
    candidate = spawn(process.execPath, [binPath, "daemon", "--config", configPath, "--replace-owner"], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(candidate, "owner replacement committed")
    const status = await sendControlCommand({command: {command: "status"}, path: newSocketPath})
    const generationTransition = status.generationTransition

    assert.ok(generationTransition && typeof generationTransition === "object" && !Array.isArray(generationTransition))
    assert.equal(generationTransition.phase, "activating_candidate")
    assert.match(String(generationTransition.error), /activate command exited non-zero/)
    assert.equal(await fs.readFile(lifecycleLogPath, "utf8"), "activate:v1\nretire:v1\n", "replacement must preserve, not retry, the failed activation")

    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: newSocketPath})
    await Promise.all([v1Path, v2Path].map((releasePath) => fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")))
    await shutdown
  } finally {
    for (const child of [owner, candidate]) if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("replacement publishes an unchanged control path only after incumbent retirement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-same-control-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const releasePath = path.join(root, "v1")
  let owner
  let candidate

  try {
    await fs.mkdir(releasePath)
    await makeFifo(path.join(releasePath, "worker.fifo"))
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath, revision: "v1"}, path: socketPath})
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: true, statePath}))

    candidate = spawn(process.execPath, [binPath, "daemon", "--config", configPath, "--replace-owner"], {stdio: ["ignore", "pipe", "pipe"]})
    const output = await collectUntilExitOrLog(candidate, "owner replacement committed")

    assert.equal(output.message, "owner replacement committed", output.output)
    assert.equal((await sendControlCommand({command: {command: "status"}, path: socketPath})).activeReleaseId, "v1")
    const shutdown = sendControlCommand({command: {command: "shutdown"}, path: socketPath})
    await fs.writeFile(path.join(releasePath, "worker.fifo"), "drained\n")
    await shutdown
  } finally {
    for (const child of [owner, candidate]) if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("prepared replacement fences incumbent mutations until abort", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-owner-replacement-cas-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const statePath = path.join(root, "state.json")
  const configPath = path.join(root, "rollbridge.cjs")
  const v1Path = path.join(root, "v1")
  const v2Path = path.join(root, "v2")
  let owner
  let transactionClient
  let v2Started = false

  try {
    await Promise.all([fs.mkdir(v1Path), fs.mkdir(v2Path)])
    await Promise.all([makeFifo(path.join(v1Path, "worker.fifo")), makeFifo(path.join(v2Path, "worker.fifo"))])
    await writeConfig(configPath, config({controlPath: socketPath, extraCompanion: false, statePath}))
    owner = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {stdio: ["ignore", "pipe", "pipe"]})
    await waitForLog(owner, "control socket listening")
    await sendControlCommand({command: {command: "deploy", releaseId: "v1", releasePath: v1Path, revision: "v1"}, path: socketPath})
    const state = JSON.parse(await fs.readFile(statePath, "utf8"))
    const authority = {configDigest: state.recovery.configDigest, runtime: state.daemonRuntime}

    transactionClient = new GuardianClient(state.recovery.guardian)
    await transactionClient.connect()
    const prepared = await transactionClient.prepareOwnerReplacement(authority, {...authority, configDigest: "candidate-authority"})

    await assert.rejects(
      sendControlCommand({command: {command: "deploy", releaseId: "v2", releasePath: v2Path, revision: "v2"}, path: socketPath})
        .then((response) => {
          v2Started = true
          return response
        }),
      /replacement.*prepared|mutation.*fenced/i
    )
    const retained = await sendControlCommand({command: {command: "status"}, path: socketPath})
    assert.equal(retained.activeReleaseId, "v1")
    assert.deepEqual(retained.releaseReferences, [{releaseId: "v1", releasePath: v1Path}])
    await transactionClient.abortOwnerReplacement(prepared.replacementId)
    await sendControlCommand({command: {command: "deploy", releaseId: "v2", releasePath: v2Path, revision: "v2"}, path: socketPath})
    v2Started = true
    const afterAbort = await sendControlCommand({command: {command: "status"}, path: socketPath})

    assert.equal(afterAbort.activeReleaseId, "v2")
    assert.deepEqual(afterAbort.releaseReferences, [
      {releaseId: "v1", releasePath: v1Path},
      {releaseId: "v2", releasePath: v2Path}
    ])
  } finally {
    transactionClient?.disconnect()
    await new Promise((resolve) => setImmediate(resolve))
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      const shutdown = sendControlCommand({command: {command: "shutdown"}, path: socketPath}).catch(() => undefined)
      const drains = [fs.writeFile(path.join(v1Path, "worker.fifo"), "drained\n").catch(() => undefined)]

      if (v2Started) drains.push(fs.writeFile(path.join(v2Path, "worker.fifo"), "drained\n").catch(() => undefined))
      await Promise.all([...drains, shutdown])
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
    }
    await stopGuardian(statePath)
    await fs.rm(root, {force: true, recursive: true})
  }
})

/**
 * @param {{activationLogPath?: string, controlPath: string, extraCompanion: boolean, proxyPort?: number, statePath: string}} options - Fixture options.
 * @returns {Record<string, import("../src/json.js").JsonValue>} Raw fixture config.
 */
function config({activationLogPath, controlPath, extraCompanion, proxyPort = 0, statePath}) {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`
  const processes = /** @type {Record<string, import("../src/json.js").JsonValue>[]} */ ([
    {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      id: "worker",
      lifecycle: {drainCommand: "read released < \"$ROLLBRIDGE_RELEASE_PATH/worker.fifo\"", drainTimeoutMs: 60000},
      nonBlockingDrain: true,
      policy: "companion"
    },
    {command, health: {intervalMs: 25, path: "/ping", timeoutMs: 3000}, id: "web", policy: "proxied", port: {from: 0, to: 0}}
  ])

  if (activationLogPath) processes.unshift({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    deployStrategy: "handoff",
    id: "generation-main",
    lifecycle: {
      activateCommand: `printf 'activate:%s\\n' "$ROLLBRIDGE_RELEASE_ID" >> ${JSON.stringify(activationLogPath)}`,
      quietCommand: `printf 'retire:%s\\n' "$ROLLBRIDGE_RELEASE_ID" >> ${JSON.stringify(activationLogPath)}`
    },
    policy: "service",
    port: {from: 23000, to: 23999}
  })
  if (extraCompanion) processes.splice(1, 0, {command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`, id: "metrics", policy: "companion"})
  return {
    application: "owner-replacement-test",
    control: {path: controlPath},
    ownerRecovery: {reconnectGraceMs: 3000},
    processes,
    proxy: {drainTimeoutMs: 100, forceStopTimeoutMs: 100, host: "127.0.0.1", port: proxyPort},
    statePath
  }
}

/**
 * @param {string} destination - Candidate package path.
 * @param {{dropCommitResponse?: boolean}} [options] - Fault injection.
 * @returns {Promise<void>} Package preparation completion.
 */
async function prepareCandidatePackage(destination, options = {}) {
  const {dropCommitResponse = false} = options

  await fs.mkdir(destination, {recursive: true})
  await Promise.all([
    fs.cp(path.join(repoRoot, "bin"), path.join(destination, "bin"), {recursive: true}),
    fs.cp(path.join(repoRoot, "src"), path.join(destination, "src"), {recursive: true}),
    fs.cp(path.join(repoRoot, "node_modules"), path.join(destination, "node_modules"), {dereference: true, recursive: true}),
    fs.copyFile(path.join(repoRoot, "package.json"), path.join(destination, "package.json"))
  ])
  await fs.appendFile(path.join(destination, "src", "cli.js"), "\n// distinct owner-replacement candidate closure\n")
  if (dropCommitResponse) {
    const clientPath = path.join(destination, "src", "control-client.js")
    const source = await fs.readFile(clientPath, "utf8")
    const marker = "export async function sendControlCommand({command, path}) {\n"
    const injected = `${marker}  if (command.command === "commit-owner-replacement") {\n    return await new Promise((resolve, reject) => {\n      const socket = net.createConnection(path)\n      socket.once("error", reject)\n      socket.once("data", () => { socket.destroy(); reject(new Error("injected lost commit response")) })\n      socket.once("connect", () => socket.write(\`${"${JSON.stringify(command)}"}\\n\`))\n    })\n  }\n\n`
    const sessionMarker = "    this.socket.write(`${JSON.stringify(command)}\\n`)\n    return await response\n"
    const sessionInjection = "    this.socket.write(`${JSON.stringify(command)}\\n`)\n    const result = await response\n    if (command.command === \"commit-owner-replacement\") throw new Error(\"injected lost commit response\")\n    return result\n"

    assert.ok(source.includes(marker))
    assert.ok(source.includes(sessionMarker))
    await fs.writeFile(clientPath, source.replace(marker, injected).replace(sessionMarker, sessionInjection))
  }
}

/**
 * Replaces only the copied package's daemon entry with an exact early-exit fixture.
 * @param {string} packagePath - Copied candidate package root.
 * @param {string} evidencePath - Exact candidate identity record.
 * @param {number} exitCode - Distinct candidate exit code.
 * @returns {Promise<void>} Fixture installation completion.
 */
async function installCandidateExit(packagePath, evidencePath, exitCode) {
  const binPath = path.join(packagePath, "bin", "rollbridge")
  const source = `#!/usr/bin/env node
import fs from "node:fs"

if (process.argv[2] === "daemon") {
  fs.writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({argv: process.argv, pid: process.pid, ppid: process.ppid}))
  process.exit(${exitCode})
}

const {runCli} = await import("../src/cli.js")
await runCli(process.argv)
`

  await fs.writeFile(binPath, source, {mode: 0o755})
}

/**
 * @param {{configPath: string, daemonPidPath: string, logPath: string, packagePath: string, runtimePath: string}} options - Ensure fixture paths.
 * @returns {Promise<{code: number, stderr: string, stdout: string}>} Ensure result.
 */
async function runEnsureDaemon({configPath, daemonPidPath, logPath, packagePath, runtimePath}) {
  return await run(process.execPath, [
    path.join(packagePath, "bin", "rollbridge"), "ensure-daemon", "--config", configPath,
    "--daemon-runtime-path", runtimePath, "--daemon-log-path", logPath,
    "--daemon-pid-path", daemonPidPath, "--daemon-start-timeout-ms", "3000"
  ])
}

/**
 * Starts an authenticated protocol proxy that exposes the exact partial guardian surface.
 * @param {{backendPath: string, mode: string, socketPath: string, token: string}} options - Fixture identity.
 * @returns {Promise<import("node:child_process").ChildProcess>} Ready guardian proxy.
 */
async function startPartialGuardian({backendPath, mode, socketPath, token}) {
  const child = spawn(process.execPath, [partialGuardianPath, socketPath, backendPath, mode], {
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  })

  await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => reject(new Error(`Partial guardian exited before readiness with status ${code}`)))
    child.once("message", (message) => {
      if (message && typeof message === "object" && "error" in message) reject(new Error(String(message.error)))
      else resolve(undefined)
    })
    child.send({token}, (error) => {
      if (error) reject(error)
    })
  })
  if (child.connected) await once(child, "disconnect")
  assert.ok(child.pid)
  return child
}

/**
 * @param {net.Server} server - Unix server.
 * @param {string} socketPath - Unix socket path.
 * @returns {Promise<void>} Listen completion.
 */
async function listenUnix(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve(undefined))
  })
}

/**
 * @param {net.Server} server - Server to close.
 * @returns {Promise<void>} Close completion.
 */
async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve(undefined)))
}

/**
 * @param {string} fifoPath - FIFO path.
 * @returns {Promise<void>} FIFO creation completion.
 */
async function makeFifo(fifoPath) {
  const child = spawn("mkfifo", [fifoPath])
  assert.equal((await once(child, "exit"))[0], 0)
}

/**
 * @param {Record<string, import("../src/json.js").JsonValue>} status - Status.
 * @param {string} releaseId - Release id.
 * @param {string} processId - Process id.
 * @returns {number} Managed process pid.
 */
function releaseProcessPid(status, releaseId, processId) {
  const releases = /** @type {{releaseId: string, processes: {id: string, pid?: number}[]}[]} */ (status.releases)
  const pid = releases.find((release) => release.releaseId === releaseId)?.processes.find((processStatus) => processStatus.id === processId)?.pid

  if (typeof pid !== "number") throw new Error(`Missing ${processId} pid for release ${releaseId}`)
  return pid
}

/**
 * @param {Record<string, import("../src/json.js").JsonValue>} status - Daemon status.
 * @param {string} releaseId - Release identity.
 * @returns {string} Release lifecycle state.
 */
function releaseState(status, releaseId) {
  const releases = /** @type {{releaseId: string, state: string}[]} */ (status.releases)
  const state = releases.find((release) => release.releaseId === releaseId)?.state

  if (!state) throw new Error(`Missing release state for ${releaseId}`)
  return state
}

/** @returns {{promise: Promise<void>, resolve: (value: void) => void}} Controllable event barrier. */
function deferred() {
  let resolve = /** @type {(value: void) => void} */ (() => {})
  const promise = new Promise((promiseResolve) => { resolve = promiseResolve })

  return {promise, resolve}
}

/**
 * @param {string} command - Executable.
 * @param {string[]} args - Arguments.
 * @returns {Promise<{code: number, pid: number, stderr: string, stdout: string}>} Child result.
 */
async function run(command, args) {
  const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]})
  let stdout = ""
  let stderr = ""

  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const [code] = await once(child, "exit")
  assert.ok(child.pid)
  return {code, pid: child.pid, stderr, stdout}
}

/**
 * @param {import("node:child_process").ChildProcess} child - Daemon.
 * @param {string} message - Log message.
 * @returns {Promise<void>} Resolves after the matching log event.
 */
async function waitForLog(child, message) {
  assert.ok(child.stdout)
  assert.ok(child.stderr)
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  await new Promise((resolve, reject) => {
    let buffer = ""
    let errors = ""
    const onExit = () => finish(new Error(`daemon exited before ${message}: ${errors}`))
    const onData = (/** @type {string} */ chunk) => {
      buffer += chunk
      for (const line of buffer.split("\n")) {
        if (line && JSON.parse(line).message === message) return finish(undefined)
      }
    }
    const finish = (/** @type {Error | undefined} */ error) => {
      child.off("exit", onExit)
      child.stdout?.off("data", onData)
      child.stderr?.off("data", onError)
      if (error) reject(error)
      else resolve(undefined)
    }

    child.once("exit", onExit)
    child.stdout?.on("data", onData)
    const onError = (/** @type {string} */ chunk) => { errors += chunk }

    child.stderr?.on("data", onError)
  })
}

/**
 * @param {import("node:child_process").ChildProcess} child - Daemon.
 * @param {string} message - Expected log message.
 * @returns {Promise<{message?: string, output: string}>} Exit output or matched message.
 */
async function collectUntilExitOrLog(child, message) {
  assert.ok(child.stdout)
  assert.ok(child.stderr)
  const stdout = child.stdout
  const stderr = child.stderr

  stdout.setEncoding("utf8")
  stderr.setEncoding("utf8")
  let output = ""

  return await new Promise((resolve) => {
    const onData = (/** @type {string} */ chunk) => {
      output += chunk
      for (const line of output.split("\n")) {
        if (!line) continue
        try {
          if (JSON.parse(line).message === message) return finish(message)
        } catch (_error) {
          // Non-JSON stderr remains part of the assertion diagnostic.
        }
      }
    }
    const finish = (/** @type {string | undefined} */ matched) => {
      child.off("exit", onExit)
      stdout.off("data", onData)
      stderr.off("data", onData)
      resolve({message: matched, output})
    }
    const onExit = () => finish(undefined)

    child.once("exit", onExit)
    stdout.on("data", onData)
    stderr.on("data", onData)
  })
}

/**
 * Opens a live WebSocket through the Rollbridge proxy without a client dependency.
 * @param {number} port - Proxy port.
 * @returns {Promise<net.Socket>} Upgraded socket.
 */
async function openWebSocket(port) {
  const socket = net.createConnection({host: "127.0.0.1", port})

  await once(socket, "connect")
  socket.write([
    "GET /socket HTTP/1.1",
    "Host: 127.0.0.1",
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "\r\n"
  ].join("\r\n"))
  const [response] = await once(socket, "data")

  assert.match(String(response), /^HTTP\/1\.1 101 /)
  return socket
}

/**
 * @param {string} configPath - Config path.
 * @param {Record<string, import("../src/json.js").JsonValue>} value - Config.
 * @returns {Promise<void>} Config write completion.
 */
async function writeConfig(configPath, value) {
  await fs.writeFile(configPath, `module.exports = ${JSON.stringify(value, null, 2)}\n`)
}

/** @param {string} statePath - State path. */
async function stopGuardian(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"))
    const identity = state.recovery?.guardian
    const pid = identity?.pid

    if (identity?.socketPath && identity.token) {
      const client = new GuardianClient(identity)

      try {
        await client.connect()
        for (const entry of await client.inventory()) {
          if (entry.status.pid) {
            try { process.kill(-entry.status.pid, "SIGKILL") } catch (error) {
              if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error
            }
          }
        }
      } finally {
        client.disconnect()
      }
    }

    if (typeof pid === "number") {
      const command = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ")

      if (!command.includes("process-guardian.js") || !command.includes(statePath)) throw new Error(`Refusing to stop unverified fixture guardian pid ${pid}`)
      process.kill(pid, "SIGKILL")
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || !["ENOENT", "ESRCH"].includes(String(error.code))) throw error
  }
}
