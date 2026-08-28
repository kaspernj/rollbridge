// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import GuardianClient from "../src/guardian-client.js"

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
    assert.ok(contender.socket)
    const contenderClosed = new Promise((resolve) => contender.socket?.once("close", () => resolve(undefined)))
    const waitingClaim = contender.claimOwner(250)
    const rejectedClaim = assert.rejects(waitingClaim, /connection closed/)

    await fixture.client.shutdown()
    await rejectedClaim
    await contenderClosed
    await assert.rejects(() => contender.inventory(), /not connected/)
    await assert.rejects(fs.access(fixture.client.socketPath), {code: "ENOENT"})
    await fixture.client.guardianExit()
  } finally {
    contender.disconnect()
    await cleanupGuardian(fixture)
  }
})

/** @returns {Promise<{client: GuardianClient, root: string, token: string}>} Started guardian fixture. */
async function createGuardian() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-guardian-client-"))
  const token = "capability-must-not-appear-in-argv"
  const client = new GuardianClient({socketPath: path.join(root, "guardian.sock"), token})

  await client.launch()
  await client.claimOwner(0)
  return {client, root, token}
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
