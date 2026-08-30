// @ts-check

import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import GuardianClient from "../src/guardian-client.js"

const legacyGuardianPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pre-split3-process-guardian.js")

test("guardian bootstrap capability is absent from process argv", async () => {
  const fixture = await createGuardian()

  try {
    const commandLine = await fs.readFile(`/proc/${fixture.client.pid}/cmdline`, "utf8")
    const environment = await fs.readFile(`/proc/${fixture.client.pid}/environ`, "utf8")
    const status = await fs.readFile(`/proc/${fixture.client.pid}/status`, "utf8")
    const inventory = JSON.stringify(await fixture.client.inventory())

    assert.ok(commandLine.includes("process-guardian.js"))
    assert.ok(!commandLine.includes(fixture.token), "guardian capability must not be exposed through argv")
    assert.ok(!environment.includes(fixture.token), "guardian capability must not be exposed through env")
    assert.ok(!status.includes(fixture.token), "guardian capability must not be exposed through process status/title")
    assert.ok(!inventory.includes(fixture.token), "guardian capability must not be exposed through guardian status")
  } finally {
    await cleanupGuardian(fixture)
  }
})

test("guardian inventory removes only an exact owned provenance", async () => {
  const fixture = await createGuardian()
  const processInstance = fixture.client.process("candidate", definition("candidate"))

  try {
    await processInstance.start()
    const inventory = await fixture.client.inventory()
    const candidate = inventory.find((entry) => entry.key === "candidate")

    assert.ok(candidate)
    await assert.rejects(() => fixture.client.remove("candidate", `${candidate.provenance}-wrong`), /provenance mismatch/)
    assert.equal((await fixture.client.inventory()).length, 1)
    await fixture.client.remove("candidate", candidate.provenance)
    assert.deepEqual(await fixture.client.inventory(), [])
  } finally {
    await cleanupGuardian(fixture)
  }
})

test("guardian runs a strict activation lifecycle command for the exact registered process", async () => {
  const fixture = await createGuardian()
  const activationPath = path.join(fixture.root, "activated")
  const processInstance = fixture.client.process("candidate-activation", {
    ...definition("candidate-activation"),
    lifecycle: {activateCommand: `printf activated > ${JSON.stringify(activationPath)}`, drainTimeoutMs: 0}
  })

  try {
    await processInstance.start()
    await processInstance.activateStrict()
    assert.equal(await fs.readFile(activationPath, "utf8"), "activated")
  } finally {
    await cleanupGuardian(fixture)
  }
})

test("guardian shutdown reports an exact owned process stop failure", async () => {
  const fixture = await createGuardian()
  const processInstance = fixture.client.process("broken-stop", {...definition("broken-stop"), stopSignal: "NOT_A_SIGNAL"})
  const replacement = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})

  try {
    await processInstance.start()
    const [entry] = await fixture.client.inventory()

    assert.ok(entry)
    fixture.client.disconnect()
    await replacement.connect()
    await replacement.claimOwner(0, null)
    await assert.rejects(() => replacement.reconcileInventory(), /NOT_A_SIGNAL|Unknown signal/)
    assert.deepEqual((await replacement.inventory()).map(({key, provenance}) => ({key, provenance})), [{key: entry.key, provenance: entry.provenance}], "failed reconciliation must retain the exact registration")
    await assert.rejects(() => replacement.shutdown(), /NOT_A_SIGNAL|Unknown signal/)
  } finally {
    const inventory = await replacement.inventory().catch(() => [])
    const entry = inventory[0]
    if (entry?.status.pid) {
      try { process.kill(-entry.status.pid, "SIGKILL") } catch (_error) { /* Exact fixture process already exited. */ }
    }
    if (fixture.client.pid) {
      try { process.kill(fixture.client.pid, "SIGKILL") } catch (_error) { /* Guardian already exited. */ }
    }
    replacement.disconnect()
    fixture.client.disconnect()
    await fixture.client.guardianExit().catch(() => {})
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("successful guardian shutdown closes an authenticated waiting contender before exit", async () => {
  const fixture = await createGuardian()
  const contender = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})

  try {
    await contender.connect()
    assert.ok(fixture.client.socket)
    assert.ok(contender.socket)
    const shutdownOrder = /** @type {string[]} */ ([])
    const onData = fixture.client.onData.bind(fixture.client)

    fixture.client.onData = (chunk) => {
      onData(chunk)
      if (chunk.includes('"stopped":true')) shutdownOrder.push("response")
    }
    fixture.client.socket.once("close", () => shutdownOrder.push("caller-close"))
    const contenderClosed = new Promise((resolve) => contender.socket?.once("close", () => resolve(undefined)))
    const waitingClaim = contender.claimOwner(250, null)
    const rejectedClaim = assert.rejects(waitingClaim, /connection closed/)

    await fixture.client.shutdown()
    await rejectedClaim
    await contenderClosed
    assert.deepEqual(shutdownOrder, ["response", "caller-close"], "shutdown success must be received before the caller connection closes")
    await assert.rejects(() => contender.inventory(), /not connected/)
    await assert.rejects(fs.access(fixture.client.socketPath), {code: "ENOENT"})
    await fixture.client.guardianExit()
  } finally {
    contender.disconnect()
    await cleanupGuardian(fixture)
  }
})

test("replacement commit notification waits for incumbent listener retirement", async () => {
  const fixture = await createGuardian()
  const candidate = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  const authority = {configDigest: "incumbent", runtime: null}
  const nextAuthority = {configDigest: "candidate", runtime: null}
  let committed = false

  try {
    await fixture.client.publishOwnerState({authority, snapshot: {activeReleaseId: "v1"}})
    await candidate.connect()
    const prepared = await candidate.prepareOwnerReplacement(authority, nextAuthority)
    await candidate.stageOwnerReplacement(prepared.replacementId, {authority: nextAuthority, snapshot: {activeReleaseId: "v1"}})
    const notification = candidate.waitForEvent("replacement-committed").then(() => { committed = true })

    await fixture.client.commitOwnerReplacement(prepared.replacementId)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(committed, false, "candidate publication must remain fenced while incumbent listener retirement is delayed")
    await fixture.client.request({command: "finalize-owner-replacement", replacementId: prepared.replacementId})
    await notification
    assert.equal(committed, true)
    await candidate.shutdown()
    await fixture.client.guardianExit()
  } finally {
    candidate.disconnect()
    await cleanupGuardian(fixture)
  }
})

test("replacement staging rejects owner state published after prepare", async () => {
  const fixture = await createGuardian()
  const candidate = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  const authority = {configDigest: "incumbent", runtime: null}
  const nextAuthority = {configDigest: "candidate", runtime: null}

  try {
    await fixture.client.publishOwnerState({authority, snapshot: {activeReleaseId: "v1"}})
    await candidate.connect()
    const prepared = await candidate.prepareOwnerReplacement(authority, nextAuthority)

    await fixture.client.publishOwnerState({authority, snapshot: {activeReleaseId: "v2"}})
    await assert.rejects(
      () => candidate.stageOwnerReplacement(prepared.replacementId, {authority: nextAuthority, snapshot: {activeReleaseId: "v1"}}),
      /owner state changed after prepare/i
    )
    await candidate.abortOwnerReplacement(prepared.replacementId)
    const fresh = await candidate.prepareOwnerReplacement(authority, nextAuthority)

    assert.deepEqual(fresh.ownerState, {authority, snapshot: {activeReleaseId: "v2"}})
    await candidate.abortOwnerReplacement(fresh.replacementId)
    await fixture.client.shutdown()
    await fixture.client.guardianExit()
  } finally {
    candidate.disconnect()
    await cleanupGuardian(fixture)
  }
})

test("retired owner replacement requires unchanged authority and the exact control path absent", async () => {
  const fixture = await createGuardian()
  const candidate = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  const controlPath = path.join(fixture.root, "rollbridge.sock")
  const authority = {configDigest: "incumbent", runtime: null}
  const nextAuthority = {configDigest: "candidate", runtime: null}
  const snapshot = {activeReleaseId: "v1", control: {path: controlPath}}

  try {
    await fixture.client.publishOwnerState({authority, snapshot})
    await candidate.connect()
    const changed = await candidate.prepareOwnerReplacement(authority, nextAuthority)

    await candidate.stageOwnerReplacement(changed.replacementId, {authority: nextAuthority, snapshot})
    await assert.rejects(() => candidate.commitRetiredOwnerReplacement(changed.replacementId), /unchanged owner authority/)
    await candidate.abortOwnerReplacement(changed.replacementId)

    const occupied = await candidate.prepareOwnerReplacement(authority, authority)

    await candidate.stageOwnerReplacement(occupied.replacementId, {authority, snapshot})
    await fs.writeFile(controlPath, "occupied\n")
    await assert.rejects(() => candidate.commitRetiredOwnerReplacement(occupied.replacementId), /control socket .* still exists/)
    await candidate.abortOwnerReplacement(occupied.replacementId)
    await fixture.client.shutdown()
    await fixture.client.guardianExit()
  } finally {
    candidate.disconnect()
    await cleanupGuardian(fixture)
  }
})

test("first upgrade migrates a real pre-split guardian without replacing its owned process", async () => {
  const fixture = await createLegacyGuardian()
  const processDefinition = definition("legacy-worker")
  const legacyProcess = fixture.client.process("release:v1:legacy-worker", processDefinition)
  let upgraded
  let legacyPid

  try {
    await legacyProcess.start()
    legacyPid = legacyProcess.status().pid
    const authority = {configDigest: "legacy-config", runtime: {digest: "legacy-runtime", format: 1, path: "/legacy", version: "0.1.28"}}
    const nextAuthority = {...authority, runtime: {...authority.runtime, digest: "candidate-runtime", path: "/candidate"}}
    const ownerState = {
      authority,
      snapshot: {
        activeReleaseId: "v1",
        releases: [{processes: [{id: "legacy-worker"}], releaseId: "v1"}],
        services: [],
        singletons: []
      }
    }

    assert.ok(legacyPid)
    upgraded = await fixture.client.upgradeLegacyGuardian({
      ownerState,
      socketPath: path.join(fixture.root, "guardian-v2.sock"),
      token: "candidate-guardian-capability"
    })
    const prepared = await upgraded.prepareOwnerReplacement(authority, nextAuthority)
    const committed = upgraded.waitForEvent("replacement-committed")
    const restored = upgraded.process("release:v1:legacy-worker", processDefinition)

    await restored.recover()
    assert.equal(restored.status().pid, legacyPid)
    assert.deepEqual(prepared.ownerState, ownerState)
    assert.deepEqual(await upgraded.stageOwnerReplacement(prepared.replacementId, {authority: nextAuthority, snapshot: ownerState.snapshot}), {committed: true})
    await committed
    assert.equal(restored.status().pid, legacyPid)
    await upgraded.shutdown()
    await upgraded.guardianExit()
  } finally {
    upgraded?.disconnect()
    fixture.client.disconnect()
    if (legacyPid) killExactProcessGroup(legacyPid)
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

/** @returns {Promise<{client: GuardianClient, root: string, token: string}>} Started guardian fixture. */
async function createGuardian() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-guardian-client-"))
  const token = "capability-must-not-appear-in-argv"
  const client = new GuardianClient({socketPath: path.join(root, "guardian.sock"), token})

  await client.launch()
  await client.claimOwner(0, null)
  return {client, root, token}
}

/** @returns {Promise<{child: import("node:child_process").ChildProcess, client: GuardianClient, root: string}>} Real pre-split guardian fixture. */
async function createLegacyGuardian() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-legacy-guardian-"))
  const token = "legacy-guardian-capability"
  const socketPath = path.join(root, "guardian.sock")
  const child = spawn(process.execPath, [legacyGuardianPath, socketPath], {detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"]})

  await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => reject(new Error(`Legacy guardian exited before readiness with status ${code}`)))
    child.once("message", resolve)
    child.send({token}, (error) => {
      if (error) reject(error)
    })
  })
  if (child.connected) await new Promise((resolve) => child.once("disconnect", resolve))
  child.unref()
  const client = new GuardianClient({pid: child.pid, socketPath, token})

  await client.connect()
  await client.claimOwner(0, null)
  return {child, client, root}
}

/** @param {{client: GuardianClient, root: string}} fixture - Exact guardian fixture. */
async function cleanupGuardian(fixture) {
  let stopped = false

  try {
    await fixture.client.shutdown()
    stopped = true
  } catch (_error) {
    // Exact fixture cleanup continues below.
  }
  fixture.client.disconnect()
  if (!stopped && fixture.client.pid) {
    try { process.kill(fixture.client.pid, "SIGKILL") } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error
    }
  }
  await fixture.client.guardianExit().catch(() => {})
  await fs.rm(fixture.root, {force: true, recursive: true})
}

/**
 * @param {string} id - Process id.
 * @returns {Parameters<GuardianClient["process"]>[1]} Managed process definition.
 */
function definition(id) {
  return {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    cwd: undefined,
    env: {},
    id,
    lifecycle: {drainTimeoutMs: 0},
    logger: () => {},
    outputLines: 10,
    restart: {backoffFactor: 1, maxDelayMs: 0, maxRestarts: 0, windowMs: 0},
    restartDelayMs: 0,
    shouldRestart: () => false,
    stopSignal: "SIGTERM",
    stopTimeoutMs: 100
  }
}

/** @param {number} pid - Exact fixture process group leader. */
function killExactProcessGroup(pid) {
  try { process.kill(-pid, "SIGKILL") } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error
  }
}
