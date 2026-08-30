// @ts-check

import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {once} from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import GuardianClient from "../src/guardian-client.js"
import {waitForProcessExit} from "./support/process.js"

const legacyGuardianPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pre-split3-process-guardian.js")
const recoveryOwnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "guardian-recovery-owner.js")

test("guardian bootstrap capability is absent from process argv", async () => {
  const fixture = await createGuardian()

  try {
    assert.deepEqual(await fixture.client.capabilities(), {daemonRecovery: 1})
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

test("guardian atomically updates process provenance with private owner state", async () => {
  const fixture = await createGuardian()
  const processInstance = fixture.client.process("service", definition("service"))
  const previousOwnerState = {authority: null, serviceReleaseIds: {service: "v1"}}
  const nextOwnerState = {authority: null, serviceReleaseIds: {service: "v2"}}

  try {
    await fixture.client.publishOwnerState(previousOwnerState)
    await processInstance.start()
    const previousProvenance = (await fixture.client.inventory())[0]?.provenance

    await processInstance.updateDefinition({...definition("service"), env: {RELEASE: "v2"}}, nextOwnerState)
    assert.deepEqual(await fixture.client.ownerState(), nextOwnerState)
    assert.notEqual((await fixture.client.inventory())[0]?.provenance, previousProvenance)
  } finally {
    await cleanupGuardian(fixture)
  }
})

test("guardian forwards each retained output line to its exact process proxy", async () => {
  const fixture = await createGuardian()
  const marker = "guardian-output-ready"
  const processInstance = fixture.client.process("output", {
    ...definition("output"),
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log(${JSON.stringify(marker)})`)}`
  })
  const logged = once(processInstance, "log")
  const forwarded = fixture.client.waitForEvent("process-log")
  const exitedFirst = once(processInstance, "exit").then(() => { throw new Error("Guardian process exited before forwarding retained output") })

  try {
    await processInstance.start()
    const [entry] = await Promise.race([logged, exitedFirst])
    const event = await forwarded

    assert.equal(entry.line, marker)
    assert.equal(event.status, undefined, "log events must not resend the complete retained process status")
    assert.ok(processInstance.status().logs.some((candidate) => candidate.line === marker))
  } finally {
    await cleanupGuardian(fixture)
  }
})

test("guardian delivers the final process status after dropping logs for a backpressured client", async () => {
  const fixture = await createGuardian()
  const gatePath = path.join(fixture.root, "write-output")
  const script = `const fs = require("node:fs"); const {once} = require("node:events"); (async () => { while (!fs.existsSync(${JSON.stringify(gatePath)})) await new Promise((resolve) => setTimeout(resolve, 5)); const line = "x".repeat(1024) + "\\n"; for (let index = 0; index < 8192; index += 1) if (!process.stdout.write(line)) await once(process.stdout, "drain"); })()`
  const processInstance = fixture.client.process("backpressured-output", {
    ...definition("backpressured-output"),
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
  })
  const socket = fixture.client.socket

  assert.ok(socket)
  try {
    await processInstance.start()
    const pid = processInstance.status().pid

    assert.ok(pid)
    const finalStatus = fixture.client.waitForEvent("process")

    socket.pause()
    await fs.writeFile(gatePath, "write\n")
    await waitForProcessExit(pid, 10000)
    socket.resume()
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeout

    try {
      await Promise.race([
        finalStatus,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Guardian did not flush the final process status after backpressure")), 3000) })
      ])
    } finally {
      clearTimeout(timeout)
    }
    assert.equal(processInstance.status().state, "failed")
  } finally {
    socket.resume()
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

test("guardian restart uses the latest accepted command and exact environment", async () => {
  const fixture = await createGuardian()
  const markerPath = path.join(fixture.root, "restarts.jsonl")
  const authority = {configDigest: "same", runtime: null}
  const replacement = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})

  try {
    await fixture.client.publishOwnerState(recoveryOwnerState(authority, markerPath, "old", 250))
    fixture.client.disconnect()
    await replacement.connect()
    await replacement.claimOwner(250, authority)
    await replacement.publishOwnerState(recoveryOwnerState(authority, markerPath, "new", 40))
    replacement.disconnect()

    const [restart] = await waitForRestartRecords(markerPath, 1)

    assert.deepEqual({home: restart.home, marker: restart.marker}, {home: null, marker: "new"})
  } finally {
    await reconnectAndShutdownGuardian(fixture, authority)
  }
})

test("guardian rearms recovery after an ownerless replacement aborts", async () => {
  const fixture = await createGuardian()
  const markerPath = path.join(fixture.root, "replacement-abort.jsonl")
  const authority = {configDigest: "same", runtime: null}
  const replacement = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})

  try {
    await fixture.client.publishOwnerState(recoveryOwnerState(authority, markerPath, "accepted", 40))
    fixture.client.disconnect()
    await replacement.connect()
    const prepared = await replacement.prepareOwnerReplacement(authority, authority)

    await new Promise((resolve) => setTimeout(resolve, 80))
    await replacement.abortOwnerReplacement(prepared.replacementId)
    assert.deepEqual((await waitForRestartRecords(markerPath, 1)).map(({home, marker}) => ({home, marker})), [{home: null, marker: "accepted"}])
  } finally {
    replacement.disconnect()
    await reconnectAndShutdownGuardian(fixture, authority)
  }
})

test("guardian retry backoff remains nonzero when reconnect grace is zero", async () => {
  const fixture = await createGuardian()
  const markerPath = path.join(fixture.root, "retry-backoff.jsonl")
  const authority = {configDigest: "same", runtime: null}

  try {
    await fixture.client.publishOwnerState(recoveryOwnerState(authority, markerPath, "retry", 0))
    fixture.client.disconnect()
    const records = await waitForRestartRecords(markerPath, 2)

    assert.equal(typeof records[0]?.at, "number")
    assert.equal(typeof records[1]?.at, "number")
    assert.ok(Number(records[1].at) - Number(records[0].at) >= 900, `failed owner recovery retried after ${Number(records[1].at) - Number(records[0].at)}ms`)
  } finally {
    await reconnectAndShutdownGuardian(fixture, authority)
  }
})

test("a retired guardian-started owner does not block recovery of its replacement", async () => {
  const fixture = await createGuardian()
  const firstMarkerPath = path.join(fixture.root, "first-owner.pid")
  const secondMarkerPath = path.join(fixture.root, "second-owner.jsonl")
  const authority = {configDigest: "same", runtime: null}
  const replacement = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  let firstOwnerPid

  try {
    await fixture.client.publishOwnerState(claimingRecoveryOwnerState(fixture, authority, firstMarkerPath))
    fixture.client.disconnect()
    firstOwnerPid = Number((await waitForFileText(firstMarkerPath)).trim())
    await replacement.connect()
    const prepared = await replacement.prepareOwnerReplacement(authority, authority)
    const committed = replacement.waitForEvent("replacement-committed")

    await replacement.stageOwnerReplacement(prepared.replacementId, recoveryOwnerState(authority, secondMarkerPath, "replacement", 20))
    process.kill(firstOwnerPid, "SIGUSR1")
    await committed
    replacement.disconnect()

    assert.deepEqual((await waitForRestartRecords(secondMarkerPath, 1)).map(({home, marker}) => ({home, marker})), [{home: null, marker: "replacement"}])
  } finally {
    replacement.disconnect()
    if (firstOwnerPid) {
      try { process.kill(firstOwnerPid, "SIGKILL") } catch (_error) { /* Exact retired fixture owner already exited. */ }
    }
    await reconnectAndShutdownGuardian(fixture, authority)
  }
})

test("guardian terminates a restart attempt that never claims ownership", async () => {
  const fixture = await createGuardian()
  const markerPath = path.join(fixture.root, "hung-owner.pid")
  const authority = {configDigest: "same", runtime: null}
  let hungPid

  try {
    await fixture.client.publishOwnerState({
      authority,
      recovery: {
        command: {
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", markerPath],
          cwd: fixture.root,
          env: {},
          executable: process.execPath
        },
        reconnectGraceMs: 0,
        startupTimeoutMs: 1000
      },
      snapshot: {activeReleaseId: null}
    })
    fixture.client.disconnect()
    hungPid = Number((await waitForFileText(markerPath)).trim())

    await waitForProcessExit(hungPid)
  } finally {
    if (hungPid) {
      try { process.kill(hungPid, "SIGKILL") } catch (_error) { /* Exact hung fixture owner already exited. */ }
    }
    await reconnectAndShutdownGuardian(fixture, authority)
  }
})

test("guardian terminates descendants when a restart leader exits before claiming ownership", async () => {
  const fixture = await createGuardian()
  const descendantPath = path.join(fixture.root, "early-exit-descendant.pid")
  const authority = {configDigest: "same", runtime: null}
  let descendantPid

  try {
    await fixture.client.publishOwnerState({
      authority,
      recovery: {
        command: {
          args: ["-e", `const {spawn} = require("node:child_process"); const fs = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"}); fs.writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid)); child.unref()`],
          cwd: fixture.root,
          env: {},
          executable: process.execPath
        },
        reconnectGraceMs: 0,
        startupTimeoutMs: 1000
      },
      snapshot: {activeReleaseId: null}
    })
    fixture.client.disconnect()
    descendantPid = Number((await waitForFileText(descendantPath)).trim())

    await waitForProcessExit(descendantPid)
  } finally {
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL") } catch (_error) { /* Exact descendant already exited. */ }
    }
    await reconnectAndShutdownGuardian(fixture, authority)
  }
})

test("guardian terminates a restarted owner process group that claims but never becomes ready", async () => {
  const fixture = await createGuardian()
  const descendantPath = path.join(fixture.root, "claimed-hung-descendant.pid")
  const markerPath = path.join(fixture.root, "claimed-hung-owner.pid")
  const authority = {configDigest: "same", runtime: null}
  let descendantPid
  let ownerPid

  try {
    await fixture.client.publishOwnerState(claimingRecoveryOwnerState(fixture, authority, markerPath, {
      descendantPath,
      ready: false,
      startupTimeoutMs: 100
    }))
    fixture.client.disconnect()
    ownerPid = Number((await waitForFileText(markerPath)).trim())
    descendantPid = Number((await waitForFileText(descendantPath)).trim())

    await Promise.all([waitForProcessExit(ownerPid), waitForProcessExit(descendantPid)])
  } finally {
    if (ownerPid) killExactProcessGroup(ownerPid)
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL") } catch (_error) { /* Exact descendant already exited. */ }
    }
    await reconnectAndShutdownGuardian(fixture, authority)
  }
})

test("guardian backs off when a restarted owner exits after claiming but before readiness", async () => {
  const fixture = await createGuardian()
  const descendantPath = path.join(fixture.root, "post-claim-descendant.pid")
  const markerPath = path.join(fixture.root, "post-claim-exit.pid")
  const startedLogPath = path.join(fixture.root, "post-claim-starts.jsonl")
  const authority = {configDigest: "same", runtime: null}
  let descendantPid

  try {
    await fixture.client.publishOwnerState(claimingRecoveryOwnerState(fixture, authority, markerPath, {
      descendantPath,
      exitAfterClaim: true,
      startedLogPath
    }))
    fixture.client.disconnect()
    descendantPid = Number((await waitForFileText(descendantPath)).trim())
    const records = await waitForRestartRecords(startedLogPath, 2)

    await waitForProcessExit(descendantPid)
    assert.ok(Number(records[1].at) - Number(records[0].at) >= 900, `post-claim failure retried after ${Number(records[1].at) - Number(records[0].at)}ms`)
  } finally {
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL") } catch (_error) { /* Exact descendant already exited. */ }
    }
    await reconnectAndShutdownGuardian(fixture, authority)
  }
})

test("guardian preserves restart backoff when an unready owner disconnect aborts a prepared replacement", async () => {
  const fixture = await createGuardian()
  const markerPath = path.join(fixture.root, "prepared-post-claim-exit.pid")
  const startedLogPath = path.join(fixture.root, "prepared-post-claim-starts.jsonl")
  const authority = {configDigest: "same", runtime: null}
  const replacement = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})

  try {
    await fixture.client.publishOwnerState(claimingRecoveryOwnerState(fixture, authority, markerPath, {
      ready: false,
      startedLogPath,
      startupTimeoutMs: 150
    }))
    fixture.client.disconnect()
    await waitForFileText(markerPath)
    await replacement.connect()
    const aborted = replacement.waitForEvent("replacement-aborted")

    await replacement.prepareOwnerReplacement(authority, authority)
    await aborted
    const records = await waitForRestartRecords(startedLogPath, 2)

    assert.ok(Number(records[1].at) - Number(records[0].at) >= 900, `replacement abort retried after ${Number(records[1].at) - Number(records[0].at)}ms`)
  } finally {
    replacement.disconnect()
    await reconnectAndShutdownGuardian(fixture, authority)
  }
})

test("replacement commit preserves a claimed guardian restart child through listener retirement", async () => {
  const fixture = await createGuardian()
  const claimedPath = path.join(fixture.root, "claimed-restart-owner.pid")
  const committedPath = path.join(fixture.root, "claimed-restart-owner-committed.txt")
  const preparedPath = path.join(fixture.root, "claimed-restart-owner-prepared.txt")
  const authority = {configDigest: "old", runtime: null}
  const nextAuthority = {configDigest: "new", runtime: null}
  const candidate = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  /** @type {number | undefined} */
  let recoveredOwnerPid

  try {
    await fixture.client.publishOwnerState(claimingRecoveryOwnerState(fixture, authority, claimedPath, {
      ready: false,
      replacementCommittedPath: committedPath,
      replacementPreparedPath: preparedPath,
      startupTimeoutMs: 5000
    }))
    fixture.client.disconnect()
    const incumbentPid = Number((await waitForFileText(claimedPath)).trim())

    recoveredOwnerPid = incumbentPid
    await candidate.connect()
    const prepared = await candidate.prepareOwnerReplacement(authority, nextAuthority)

    await waitForFileText(preparedPath, new RegExp(prepared.replacementId))
    await candidate.stageOwnerReplacement(prepared.replacementId, {authority: nextAuthority, snapshot: {activeReleaseId: null}})
    const published = candidate.waitForEvent("replacement-committed")

    process.kill(incumbentPid, "SIGUSR2")
    await Promise.race([waitForFileText(committedPath, new RegExp(prepared.replacementId)), published])
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.doesNotThrow(() => process.kill(incumbentPid, 0), "claimed incumbent must survive replacement commit until its listeners retire")

    process.kill(incumbentPid, "SIGUSR1")
    await published
    await candidate.shutdown()
    await fixture.client.guardianExit()
  } finally {
    candidate.disconnect()
    if (recoveredOwnerPid) {
      try { process.kill(-recoveredOwnerPid, "SIGKILL") } catch (_error) { /* Exact recovered fixture owner already exited. */ }
    }
    await cleanupGuardian(fixture)
  }
})

test("ownerless replacement commit kills a superseded restart candidate", async () => {
  const fixture = await createGuardian()
  const delayedClaimPath = path.join(fixture.root, "delayed-claim.pid")
  const firstMarkerPath = path.join(fixture.root, "delayed-owner-started.pid")
  const secondMarkerPath = path.join(fixture.root, "committed-replacement.jsonl")
  const authority = {configDigest: "old", runtime: null}
  const nextAuthority = {configDigest: "new", runtime: null}
  const replacement = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  let delayedOwnerPid
  let staged = false

  try {
    await fixture.client.publishOwnerState(claimingRecoveryOwnerState(fixture, authority, delayedClaimPath, {claimDelayMs: 500, startedPath: firstMarkerPath}))
    fixture.client.disconnect()
    delayedOwnerPid = Number((await waitForFileText(firstMarkerPath)).trim())
    await replacement.connect()
    const prepared = await replacement.prepareOwnerReplacement(authority, nextAuthority)

    await waitForProcessExit(delayedOwnerPid)
    const committed = replacement.waitForEvent("replacement-committed")

    await replacement.stageOwnerReplacement(prepared.replacementId, recoveryOwnerState(nextAuthority, secondMarkerPath, "committed", 20))
    staged = true
    await committed
    replacement.disconnect()

    assert.deepEqual((await waitForRestartRecords(secondMarkerPath, 1)).map(({home, marker}) => ({home, marker})), [{home: null, marker: "committed"}])
  } finally {
    replacement.disconnect()
    if (delayedOwnerPid) {
      try { process.kill(delayedOwnerPid, "SIGKILL") } catch (_error) { /* Exact superseded fixture owner already exited. */ }
    }
    await reconnectAndShutdownGuardian(fixture, staged ? nextAuthority : authority)
  }
})

test("guardian logs an asynchronous daemon spawn failure before retrying", async () => {
  const fixture = await createGuardian()
  const logPath = path.join(fixture.root, "daemon.log")
  const authority = {configDigest: "same", runtime: null}
  const privateArgs = "private-argument-value"
  const privateEnvironment = "private-environment-value"
  const privateExecutable = path.join(fixture.root, "private-runtime", "missing-rollbridge")

  try {
    await fixture.client.publishOwnerState({
      authority,
      recovery: {
        command: {
          args: [privateArgs],
          cwd: fixture.root,
          env: {PRIVATE_ENVIRONMENT: privateEnvironment},
          executable: privateExecutable,
          logPath
        },
        reconnectGraceMs: 0,
        startupTimeoutMs: 1000
      },
      snapshot: {activeReleaseId: null}
    })
    fixture.client.disconnect()
    const diagnosticPattern = /"code":"ENOENT".*"message":"guardian failed to restart daemon"/
    const diagnostic = await waitForFileText(logPath, diagnosticPattern)

    assert.match(diagnostic, diagnosticPattern)
    for (const privateValue of [privateArgs, privateEnvironment, privateExecutable, fixture.root, logPath]) {
      assert.ok(!diagnostic.includes(privateValue), `guardian diagnostic exposed ${privateValue}`)
    }
  } finally {
    await reconnectAndShutdownGuardian(fixture, authority)
  }
})

test("guardian publishes the authenticated ready owner's PID file", async () => {
  const fixture = await createGuardian()
  const pidPath = path.join(fixture.root, "run", "daemon.pid")
  const victimPath = path.join(fixture.root, "victim")
  const authority = {configDigest: "same", runtime: null}

  try {
    await fixture.client.publishOwnerState({
      authority,
      recovery: {
        command: {
          args: [],
          cwd: fixture.root,
          env: {},
          executable: process.execPath,
          pidPath
        },
        reconnectGraceMs: 10,
        startupTimeoutMs: 1000
      },
      snapshot: {activeReleaseId: null}
    })
    await fs.mkdir(path.dirname(pidPath), {recursive: true})
    await fs.writeFile(victimPath, "unchanged\n")
    await fs.symlink(victimPath, pidPath)
    await fixture.client.ownerReady()

    assert.equal(await fs.readFile(pidPath, "utf8"), `${process.pid}\n`)
    assert.equal(await fs.readFile(victimPath, "utf8"), "unchanged\n")
  } finally {
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

test("retired owner replacement commit carries its exact recovered process key", async () => {
  const client = new GuardianClient({socketPath: "/unused", token: "authenticated-capability"})
  const replacementId = "prepared-replacement"
  const processKey = "release:v1:worker"

  client.request = async (request) => {
    if (!request.key) throw new Error(`Guardian ${request.command} requires a process key`)
    assert.deepEqual(request, {command: "commit-retired-owner-replacement", key: processKey, replacementId})
    return {committed: true}
  }

  await client.commitRetiredOwnerReplacement(replacementId, processKey)
})

test("reserved process recovery rejects a reconstructed definition with different provenance", async () => {
  const fixture = await createGuardian()
  const candidate = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  const processKey = "release:v1:worker"

  try {
    await fixture.client.process(processKey, definition("worker")).recover()
    const [registration] = await fixture.client.inventory()

    assert.ok(registration)
    await candidate.connect()
    candidate.reserveProcessRecovery(processKey, registration.provenance)
    await assert.rejects(
      () => candidate.process(processKey, definition("different-worker")).recover(),
      /provenance mismatch for reserved process/
    )
    assert.deepEqual((await fixture.client.inventory()).map(({key}) => key), [processKey])
  } finally {
    candidate.disconnect()
    await cleanupGuardian(fixture)
  }
})

test("retired owner replacement rejects a registered process absent from committed owner state", async () => {
  const fixture = await createGuardian()
  const candidate = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  const committedProcessKey = "release:v1:worker"
  const candidateProcessKey = "release:candidate:worker"
  const authority = {configDigest: "owner", runtime: null}
  const snapshot = {
    activeReleaseId: "v1",
    control: {path: path.join(fixture.root, "rollbridge.sock")},
    releases: [{processes: [{id: "worker"}], releaseId: "v1"}],
    services: [],
    singletons: []
  }
  const candidateSnapshot = {
    ...snapshot,
    releases: [...snapshot.releases, {processes: [{id: "worker"}], releaseId: "candidate"}]
  }

  try {
    await fixture.client.process(committedProcessKey, definition("worker")).recover()
    await fixture.client.process(candidateProcessKey, definition("candidate-worker")).recover()
    await fixture.client.publishOwnerState({authority, snapshot})
    await candidate.connect()
    const prepared = await candidate.prepareOwnerReplacement(authority, authority)

    await candidate.stageOwnerReplacement(prepared.replacementId, {authority, snapshot: candidateSnapshot})
    await assert.rejects(
      () => candidate.commitRetiredOwnerReplacement(prepared.replacementId, candidateProcessKey),
      /process .* does not belong to the committed owner/
    )
  } finally {
    candidate.disconnect()
    await cleanupGuardian(fixture)
  }
})

test("retired owner replacement requires unchanged authority and the exact control path absent", async () => {
  const fixture = await createGuardian()
  const candidate = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  const contender = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  const controlPath = path.join(fixture.root, "rollbridge.sock")
  const processKey = "release:v1:worker"
  const authority = {configDigest: "incumbent", runtime: null}
  const nextAuthority = {configDigest: "candidate", runtime: null}
  const snapshot = {
    activeReleaseId: "v1",
    control: {path: controlPath},
    releases: [{processes: [{id: "worker"}], releaseId: "v1"}],
    services: [],
    singletons: []
  }

  try {
    await fixture.client.process(processKey, definition("worker")).recover()
    await fixture.client.publishOwnerState({authority, snapshot})
    await candidate.connect()
    const changed = await candidate.prepareOwnerReplacement(authority, nextAuthority)

    await candidate.stageOwnerReplacement(changed.replacementId, {authority: nextAuthority, snapshot})
    await assert.rejects(() => candidate.commitRetiredOwnerReplacement(changed.replacementId, processKey), /unchanged owner authority/)
    await candidate.abortOwnerReplacement(changed.replacementId)

    const occupied = await candidate.prepareOwnerReplacement(authority, authority)

    await candidate.stageOwnerReplacement(occupied.replacementId, {authority, snapshot})
    await fs.writeFile(controlPath, "occupied\n")
    await assert.rejects(() => candidate.commitRetiredOwnerReplacement(occupied.replacementId, processKey), /control socket .* still exists/)
    await candidate.abortOwnerReplacement(occupied.replacementId)

    await fs.rm(controlPath)
    const ready = await candidate.prepareOwnerReplacement(authority, authority)

    await candidate.stageOwnerReplacement(ready.replacementId, {authority, snapshot})
    await contender.connect()
    await assert.rejects(
      () => contender.request({command: "commit-retired-owner-replacement", key: processKey, replacementId: ready.replacementId}),
      /not the prepared candidate/
    )
    await assert.rejects(
      () => candidate.commitRetiredOwnerReplacement("stale-replacement", processKey),
      /not the prepared candidate/
    )
    await assert.rejects(
      () => candidate.commitRetiredOwnerReplacement(ready.replacementId, "release:v1:wrong"),
      /process .* is not registered/
    )
    const committed = candidate.waitForEvent("replacement-committed")
    const retirementRequested = fixture.client.waitForEvent("replacement-retirement-requested")
    const connectionState = candidate.waitForEvent("owner-connection-state")

    await candidate.commitRetiredOwnerReplacement(ready.replacementId, processKey)
    await retirementRequested
    await fixture.client.publishOwnerConnectionState(ready.replacementId, "v1", {http: 1, websocket: 2})
    assert.deepEqual(await connectionState, {connections: {http: 1, websocket: 2}, event: "owner-connection-state", releaseId: "v1"})
    await fixture.client.finalizeOwnerReplacement(ready.replacementId)
    await committed
    await candidate.shutdown()
    await fixture.client.guardianExit()
  } finally {
    contender.disconnect()
    candidate.disconnect()
    await cleanupGuardian(fixture)
  }
})

test("explicit replacement abort notifies the incumbent owner", async () => {
  const fixture = await createGuardian()
  const candidate = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  const authority = {configDigest: "incumbent", runtime: null}
  const nextAuthority = {configDigest: "candidate", runtime: null}

  try {
    await fixture.client.publishOwnerState({authority, snapshot: {activeReleaseId: "v1"}})
    await candidate.connect()
    const aborted = fixture.client.waitForEvent("replacement-aborted")
    const prepared = await candidate.prepareOwnerReplacement(authority, nextAuthority)

    await candidate.abortOwnerReplacement(prepared.replacementId)
    await aborted
    await fixture.client.shutdown()
    await fixture.client.guardianExit()
  } finally {
    candidate.disconnect()
    await cleanupGuardian(fixture)
  }
})

test("queued owner claim is revalidated against the latest committed authority", async () => {
  const fixture = await createGuardian()
  const contender = new GuardianClient({socketPath: fixture.client.socketPath, token: fixture.token})
  const authority = {configDigest: "old", runtime: null}
  const nextAuthority = {configDigest: "new", runtime: null}

  try {
    await fixture.client.publishOwnerState({authority, snapshot: {activeReleaseId: null}})
    await contender.connect()
    const claim = contender.claimOwner(500, authority)

    await new Promise((resolve) => setTimeout(resolve, 20))
    await fixture.client.publishOwnerState({authority: nextAuthority, snapshot: {activeReleaseId: null}})
    fixture.client.disconnect()
    await assert.rejects(claim, /authority changed while the claim was queued/)
    await contender.claimOwner(500, nextAuthority)
    await contender.shutdown()
    await fixture.client.guardianExit()
  } finally {
    contender.disconnect()
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
    await assert.rejects(() => fixture.client.capabilities(), /Guardian capabilities requires a process key/)
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

test("split guardian rejects an owner-state update when its nested legacy definition update fails", async () => {
  const fixture = await createLegacyGuardian()
  const processDefinition = definition("legacy-worker")
  const legacyProcess = fixture.client.process("release:v1:legacy-worker", processDefinition)
  const authority = {configDigest: "legacy-config", runtime: {digest: "legacy-runtime", format: 1, path: "/legacy", version: "0.1.28"}}
  const nextAuthority = {...authority, runtime: {...authority.runtime, digest: "candidate-runtime", path: "/candidate"}}
  const ownerState = {
    authority,
    snapshot: {activeReleaseId: "v1", releases: [{processes: [{id: "legacy-worker"}], releaseId: "v1"}], services: [], singletons: []}
  }
  let upgraded

  try {
    await legacyProcess.start()
    upgraded = await fixture.client.upgradeLegacyGuardian({
      ownerState,
      socketPath: path.join(fixture.root, "guardian-v2.sock"),
      token: "candidate-guardian-capability"
    })
    const prepared = await upgraded.prepareOwnerReplacement(authority, nextAuthority)
    const committedOwnerState = {authority: nextAuthority, snapshot: ownerState.snapshot}

    await upgraded.stageOwnerReplacement(prepared.replacementId, committedOwnerState)
    const restored = upgraded.process("release:v1:legacy-worker", processDefinition)

    await restored.recover()
    await legacyProcess.updateDefinition({...processDefinition, env: {REVISION: "external"}})
    await assert.rejects(
      () => restored.updateDefinition({...processDefinition, env: {REVISION: "candidate"}}, {authority: nextAuthority, snapshot: {...ownerState.snapshot, serviceReleaseIds: {service: "v2"}}}),
      /provenance mismatch/
    )
    assert.deepEqual(await upgraded.ownerState(), committedOwnerState)
  } finally {
    await legacyProcess.stop().catch(() => {})
    upgraded?.disconnect()
    fixture.client.disconnect()
    if (upgraded?.pid) killExactProcessGroup(upgraded.pid)
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("split guardian defers owner handoff until a nested legacy definition update commits", async () => {
  const fixture = await createLegacyGuardian()
  const processDefinition = definition("legacy-worker")
  const legacyProcess = fixture.client.process("release:v1:legacy-worker", processDefinition)
  const authority = {configDigest: "legacy-config", runtime: {digest: "legacy-runtime", format: 1, path: "/legacy", version: "0.1.28"}}
  const nextAuthority = {...authority, runtime: {...authority.runtime, digest: "candidate-runtime", path: "/candidate"}}
  const ownerState = {
    authority,
    snapshot: {activeReleaseId: "v1", releases: [{processes: [{id: "legacy-worker"}], releaseId: "v1"}], services: [], singletons: []}
  }
  const socketPath = path.join(fixture.root, "guardian-v2.sock")
  const token = "candidate-guardian-capability"
  const gatePath = path.join(fixture.root, "legacy-update.allow")
  const committedOwnerState = {authority: nextAuthority, snapshot: {...ownerState.snapshot, update: "committed"}}
  const contender = new GuardianClient({socketPath, token})
  let upgraded

  try {
    await legacyProcess.start()
    upgraded = await fixture.client.upgradeLegacyGuardian({ownerState, socketPath, token})
    const prepared = await upgraded.prepareOwnerReplacement(authority, nextAuthority)

    await upgraded.stageOwnerReplacement(prepared.replacementId, {authority: nextAuthority, snapshot: ownerState.snapshot})
    const restored = upgraded.process("release:v1:legacy-worker", processDefinition)

    await restored.recover()
    await contender.connect()
    const updateResult = restored.updateDefinition({...processDefinition, env: {ROLLBRIDGE_TEST_UPDATE_GATE: gatePath}}, committedOwnerState)
      .then(() => undefined, (error) => error)

    await waitForFileText(`${gatePath}.waiting`)
    const claim = contender.claimOwner(1000, nextAuthority)
    let claimSettled = false

    void claim.finally(() => { claimSettled = true })
    upgraded.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(claimSettled, false, "owner handoff must wait for the nested definition update")

    await fs.writeFile(gatePath, "allow\n")
    await claim
    const updateError = await updateResult

    assert.match(String(updateError), /connection closed while awaiting update/)
    assert.deepEqual(await contender.ownerState(), committedOwnerState)
  } finally {
    await fs.writeFile(gatePath, "allow\n").catch(() => {})
    await contender.shutdown().catch(() => {})
    contender.disconnect()
    upgraded?.disconnect()
    await legacyProcess.stop().catch(() => {})
    fixture.client.disconnect()
    if (upgraded?.pid) killExactProcessGroup(upgraded.pid)
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL")
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
})

test("a disconnected legacy upgrade candidate does not strand its bridge guardian", async () => {
  const fixture = await createLegacyGuardian()
  const authority = {configDigest: "legacy-config", runtime: {digest: "legacy-runtime", format: 1, path: "/legacy", version: "0.1.28"}}
  const ownerState = {
    authority,
    snapshot: {activeReleaseId: null, releases: [], services: [], singletons: []}
  }
  let upgraded
  let bridgeExited = false

  try {
    upgraded = await fixture.client.upgradeLegacyGuardian({
      ownerState,
      socketPath: path.join(fixture.root, "guardian-v2.sock"),
      token: "candidate-guardian-capability"
    })
    await upgraded.prepareOwnerReplacement(authority, {...authority, runtime: {...authority.runtime, digest: "candidate-runtime"}})
    upgraded.disconnect()
    let timeout = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined)

    await Promise.race([
      upgraded.guardianExit(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Legacy upgrade bridge guardian did not exit after candidate disconnect")), 1000) })
    ]).finally(() => { if (timeout) clearTimeout(timeout) })
    bridgeExited = true
    assert.equal(fixture.child.exitCode, null, "the pre-split guardian must remain available after bridge abandonment")
  } finally {
    upgraded?.disconnect()
    if (!bridgeExited && upgraded?.pid) killExactProcessGroup(upgraded.pid)
    await cleanupGuardian({client: fixture.client, root: fixture.root})
  }
})

test("a legacy bridge remains discoverable when its candidate disconnects after the disruptive boundary", async () => {
  const fixture = await createLegacyGuardian()
  const statePath = path.join(fixture.root, "state.json")
  const authority = {configDigest: "legacy-config", runtime: {digest: "legacy-runtime", format: 1, path: "/legacy", version: "0.1.28"}}
  const nextAuthority = {...authority, runtime: {...authority.runtime, digest: "candidate-runtime"}}
  const ownerState = {
    authority,
    config: {statePath},
    snapshot: {activeReleaseId: null, control: {path: path.join(fixture.root, "control.sock")}, releases: [], services: [], singletons: []}
  }
  const incumbent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {detached: true, stdio: "ignore"})
  let upgraded
  let replacement

  incumbent.unref()
  try {
    const identity = {socketPath: path.join(fixture.root, "guardian-v2.sock"), token: "candidate-guardian-capability"}

    upgraded = await fixture.client.upgradeLegacyGuardian({ownerState, ...identity})
    const prepared = await upgraded.prepareOwnerReplacement(authority, nextAuthority)
    const recoverySnapshot = {
      ...ownerState.snapshot,
      recovery: {configDigest: authority.configDigest, format: 1, guardian: {...identity, pid: upgraded.pid}, reconnectGraceMs: 3000}
    }

    assert.ok(incumbent.pid)
    await fs.writeFile(statePath, `${JSON.stringify(ownerState.snapshot, null, 2)}\n`)
    await upgraded.request({
      command: "cross-legacy-upgrade-boundary",
      incumbentPid: incumbent.pid,
      recoverySnapshot,
      replacementId: prepared.replacementId,
      statePath
    })
    await waitForProcessExit(incumbent.pid)
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), recoverySnapshot)
    upgraded.disconnect()

    replacement = new GuardianClient({...identity, pid: upgraded.pid})
    await replacement.connect()
    const resumed = await replacement.prepareOwnerReplacement(authority, nextAuthority)
    const committed = replacement.waitForEvent("replacement-committed")

    assert.deepEqual(await replacement.stageOwnerReplacement(resumed.replacementId, {authority: nextAuthority, config: {statePath}, snapshot: ownerState.snapshot}), {committed: true})
    await committed
    await replacement.shutdown()
    await upgraded.guardianExit()
  } finally {
    upgraded?.disconnect()
    replacement?.disconnect()
    if (incumbent.pid) killExactProcessGroup(incumbent.pid)
    await cleanupGuardian({client: fixture.client, root: fixture.root})
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
 * @param {Record<string, import("../src/json.js").JsonValue>} authority - Recovery authority.
 * @param {string} markerPath - Restart marker path.
 * @param {string} marker - Expected accepted command marker.
 * @param {number} reconnectGraceMs - Initial reconnect grace.
 * @returns {Record<string, import("../src/json.js").JsonValue>} Guardian owner state.
 */
function recoveryOwnerState(authority, markerPath, marker, reconnectGraceMs) {
  return {
    authority,
    recovery: {
      command: {
        args: ["-e", "require('node:fs').appendFileSync(process.argv[1], JSON.stringify({at: Date.now(), home: process.env.HOME ?? null, marker: process.env.RESTART_MARKER}) + '\\n')", markerPath],
        cwd: path.dirname(markerPath),
        env: {RESTART_MARKER: marker},
        executable: process.execPath
      },
      reconnectGraceMs,
      startupTimeoutMs: 1000
    },
    snapshot: {activeReleaseId: null}
  }
}

/**
 * @param {{client: GuardianClient, root: string, token: string}} fixture - Guardian fixture.
 * @param {Record<string, import("../src/json.js").JsonValue>} authority - Recovery authority.
 * @param {string} markerPath - Claim marker path.
 * @param {{claimDelayMs?: number, descendantPath?: string, exitAfterClaim?: boolean, ready?: boolean, replacementCommittedPath?: string, replacementPreparedPath?: string, startedLogPath?: string, startedPath?: string, startupTimeoutMs?: number}} [options] - Optional recovery behavior.
 * @returns {Record<string, import("../src/json.js").JsonValue>} Guardian owner state.
 */
function claimingRecoveryOwnerState(fixture, authority, markerPath, options = {}) {
  return {
    authority,
    recovery: {
      command: {
        args: [recoveryOwnerPath],
        cwd: fixture.root,
        env: {
          GUARDIAN_AUTHORITY: JSON.stringify(authority),
          GUARDIAN_CLAIM_DELAY_MS: String(options.claimDelayMs || 0),
          ...(options.descendantPath ? {GUARDIAN_DESCENDANT_PATH: options.descendantPath} : {}),
          ...(options.exitAfterClaim ? {GUARDIAN_EXIT_AFTER_CLAIM: "1"} : {}),
          GUARDIAN_MARKER_PATH: markerPath,
          ...(options.replacementCommittedPath ? {GUARDIAN_REPLACEMENT_COMMITTED_PATH: options.replacementCommittedPath} : {}),
          ...(options.replacementPreparedPath ? {GUARDIAN_REPLACEMENT_PREPARED_PATH: options.replacementPreparedPath} : {}),
          ...(options.ready === false ? {GUARDIAN_SKIP_READY: "1"} : {}),
          GUARDIAN_SOCKET_PATH: fixture.client.socketPath,
          ...(options.startedLogPath ? {GUARDIAN_STARTED_LOG_PATH: options.startedLogPath} : {}),
          ...(options.startedPath ? {GUARDIAN_STARTED_PATH: options.startedPath} : {}),
          GUARDIAN_TOKEN: fixture.token
        },
        executable: process.execPath
      },
      reconnectGraceMs: 10,
      startupTimeoutMs: options.startupTimeoutMs || 1000
    },
    snapshot: {activeReleaseId: null}
  }
}

/**
 * @param {string} markerPath - Restart marker path.
 * @returns {Promise<Record<string, import("../src/json.js").JsonValue>[]>} Restart records.
 */
async function restartRecords(markerPath) {
  try {
    return (await fs.readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

/**
 * @param {string} markerPath - Restart marker path.
 * @param {number} count - Required record count.
 * @returns {Promise<Record<string, import("../src/json.js").JsonValue>[]>} Restart records.
 */
async function waitForRestartRecords(markerPath, count) {
  const deadline = Date.now() + 3000

  while (Date.now() < deadline) {
    const records = await restartRecords(markerPath)

    if (records.length >= count) return records
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${count} guardian restart record${count === 1 ? "" : "s"}`)
}

/**
 * @param {string} filePath - File to read after creation.
 * @param {RegExp} [expected] - Content that must be present before returning.
 * @returns {Promise<string>} Non-empty accepted file contents.
 */
async function waitForFileText(filePath, expected) {
  const deadline = Date.now() + 3000

  while (Date.now() < deadline) {
    try {
      const contents = await fs.readFile(filePath, "utf8")

      if (contents && (!expected || expected.test(contents))) return contents
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

/**
 * @param {{client: GuardianClient, root: string, token: string}} fixture - Guardian fixture.
 * @param {Record<string, import("../src/json.js").JsonValue>} authority - Committed authority.
 */
async function reconnectAndShutdownGuardian(fixture, authority) {
  const cleanup = new GuardianClient({pid: fixture.client.pid, socketPath: fixture.client.socketPath, token: fixture.token})

  try {
    await cleanup.connect()
    await cleanup.claimOwner(500, authority)
    await cleanup.shutdown()
  } finally {
    cleanup.disconnect()
    await fixture.client.guardianExit().catch(() => {})
    await fs.rm(fixture.root, {force: true, recursive: true})
  }
}

/**
 * @param {string} id - Process id.
 * @returns {Parameters<GuardianClient["process"]>[1] & import("../src/managed-process.js").ManagedProcessDefinition} Managed process definition.
 */
function definition(id) {
  return {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    cwd: undefined,
    env: {},
    id,
    lifecycle: {drainTimeoutMs: 0},
    logger: () => {},
    memory: undefined,
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
