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
import {sendControlCommand} from "../src/control-client.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const binPath = path.join(repoRoot, "bin", "rollbridge")
const dummyAppPath = path.join(repoRoot, "test", "fixtures", "dummy-app.js")

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

/**
 * @param {{controlPath: string, extraCompanion: boolean, statePath: string}} options - Fixture options.
 * @returns {Record<string, import("../src/json.js").JsonValue>} Raw fixture config.
 */
function config({controlPath, extraCompanion, statePath}) {
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

  if (extraCompanion) processes.splice(1, 0, {command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`, id: "metrics", policy: "companion"})
  return {
    application: "owner-replacement-test",
    control: {path: controlPath},
    ownerRecovery: {reconnectGraceMs: 3000},
    processes,
    proxy: {drainTimeoutMs: 100, forceStopTimeoutMs: 100, host: "127.0.0.1", port: 0},
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

    assert.ok(source.includes(marker))
    await fs.writeFile(clientPath, source.replace(marker, injected))
  }
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
 * @param {string} command - Executable.
 * @param {string[]} args - Arguments.
 * @returns {Promise<{code: number, stderr: string, stdout: string}>} Child result.
 */
async function run(command, args) {
  const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]})
  let stdout = ""
  let stderr = ""

  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const [code] = await once(child, "exit")
  return {code, stderr, stdout}
}

/**
 * @param {import("node:child_process").ChildProcess} child - Daemon.
 * @param {string} message - Log message.
 * @returns {Promise<void>} Resolves after the matching log event.
 */
async function waitForLog(child, message) {
  assert.ok(child.stdout)
  child.stdout.setEncoding("utf8")
  await new Promise((resolve, reject) => {
    let buffer = ""
    const onExit = () => finish(new Error(`daemon exited before ${message}`))
    const onData = (/** @type {string} */ chunk) => {
      buffer += chunk
      for (const line of buffer.split("\n")) {
        if (line && JSON.parse(line).message === message) return finish(undefined)
      }
    }
    const finish = (/** @type {Error | undefined} */ error) => {
      child.off("exit", onExit)
      child.stdout?.off("data", onData)
      if (error) reject(error)
      else resolve(undefined)
    }

    child.once("exit", onExit)
    child.stdout?.on("data", onData)
  })
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
    const pid = state.recovery?.guardian?.pid

    if (typeof pid === "number") {
      const command = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ")

      if (!command.includes("process-guardian.js") || !command.includes(statePath)) throw new Error(`Refusing to stop unverified fixture guardian pid ${pid}`)
      process.kill(pid, "SIGKILL")
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || !["ENOENT", "ESRCH"].includes(String(error.code))) throw error
  }
}
