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
const dummyAppPath = path.join(repoRoot, "test", "fixtures", "dummy-app.js")

test("detached daemon survives deletion of the release-local Rollbridge installation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-retention-"))
  const releaseA = path.join(root, "releases", "A")
  const releaseB = path.join(root, "releases", "B")
  const socketPath = path.join(root, "control.sock")
  const configPath = path.join(root, "rollbridge.js")
  const logPath = path.join(root, "daemon.log")
  const pidPath = path.join(root, "daemon.pid")
  const runtimePath = path.join(root, "runtime")

  try {
    await Promise.all([prepareRelease(releaseA, true), prepareRelease(releaseB, true)])
    await fs.writeFile(configPath, `export default ${JSON.stringify({
      application: "runtime-retention-test",
      control: {path: socketPath},
      processes: [{
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`,
        health: {intervalMs: 25, path: "/ping", timeoutMs: 3000},
        id: "web",
        policy: "proxied",
        port: {from: 0, to: 0}
      }],
      proxy: {drainTimeoutMs: 100, forceStopTimeoutMs: 100, host: "127.0.0.1", port: 0}
    }, null, 2)}\n`)

    await runReleaseCli(releaseA, [
      "deploy", "--ensure-daemon", "--config", configPath,
      "--release-path", releaseA, "--release-id", "A",
      "--daemon-log-path", logPath, "--daemon-pid-path", pidPath,
      "--daemon-runtime-path", runtimePath
    ])
    await runReleaseCli(releaseB, [
      "deploy", "--ensure-daemon", "--config", configPath,
      "--release-path", releaseB, "--release-id", "B",
      "--daemon-log-path", logPath, "--daemon-pid-path", pidPath,
      "--daemon-runtime-path", runtimePath
    ])

    await fs.rm(path.join(releaseA, "node_modules"), {recursive: true})

    const status = await sendControlCommand({command: {command: "status"}, path: socketPath})
    const proxyPort = /** @type {{port: number}} */ (status.proxy).port
    const response = await fetch(`http://127.0.0.1:${proxyPort}/deferred-runtime`)
    const runtime = /** @type {{digest: string, format: number, path: string, version: string}} */ (status.daemonRuntime)

    assert.equal(status.activeReleaseId, "B")
    assert.equal(runtime.format, 1)
    assert.match(runtime.digest, /^[a-f0-9]{64}$/)
    assert.equal(path.dirname(runtime.path), runtimePath)
    assert.ok(!runtime.path.startsWith(releaseA), `runtime must be outside release A: ${runtime.path}`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), "deferred runtime loaded\n")
  } finally {
    try {
      await sendControlCommand({command: {command: "shutdown"}, path: socketPath})
    } catch {
      const pid = Number.parseInt(await fs.readFile(pidPath, "utf8").catch(() => ""), 10)
      if (Number.isInteger(pid)) process.kill(pid, "SIGKILL")
    }

    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runtime preparation failure prevents daemon startup and deploy handoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-failure-"))
  const release = path.join(root, "release")
  const socketPath = path.join(root, "control.sock")
  const configPath = path.join(root, "rollbridge.js")
  const invalidRuntimePath = path.join(root, "not-a-directory")

  try {
    await prepareRelease(release, false)
    await fs.writeFile(invalidRuntimePath, "occupied\n")
    await fs.writeFile(configPath, `export default ${JSON.stringify(basicConfig(socketPath), null, 2)}\n`)

    await assert.rejects(
      () => runReleaseCli(release, [
        "deploy", "--ensure-daemon", "--config", configPath,
        "--release-path", release, "--release-id", "blocked",
        "--daemon-runtime-path", invalidRuntimePath
      ]),
      /EEXIST|not a directory|ENOTDIR/
    )
    await assert.rejects(() => fs.stat(socketPath), {code: "ENOENT"})
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("ensure-daemon refuses a responsive legacy daemon before deploy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-legacy-"))
  const release = path.join(root, "release")
  const socketPath = path.join(root, "control.sock")
  const configPath = path.join(root, "rollbridge.js")
  let deployReceived = false
  const legacyDaemon = net.createServer((socket) => {
    socket.setEncoding("utf8")
    socket.on("data", (contents) => {
      const command = JSON.parse(String(contents).trim())

      if (command.command === "deploy") deployReceived = true
      socket.end(`${JSON.stringify({activeReleaseId: null, application: "runtime-retention-test", releases: []})}\n`)
    })
  })

  try {
    await prepareRelease(release, false)
    await fs.writeFile(configPath, `export default ${JSON.stringify(basicConfig(socketPath), null, 2)}\n`)
    await new Promise((resolve, reject) => {
      legacyDaemon.once("error", reject)
      legacyDaemon.listen(socketPath, () => resolve(undefined))
    })

    await assert.rejects(
      () => runReleaseCli(release, [
        "deploy", "--ensure-daemon", "--config", configPath,
        "--release-path", release, "--release-id", "must-not-deploy",
        "--daemon-runtime-path", path.join(root, "runtime")
      ]),
      /legacy or mismatched runtime.*deploy was not sent/s
    )

    assert.equal(deployReceived, false)
  } finally {
    await new Promise((resolve) => legacyDaemon.close(resolve))
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("ensure-daemon refuses a mismatched runtime attestation before deploy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-mismatch-"))
  const release = path.join(root, "release")
  const socketPath = path.join(root, "control.sock")
  const configPath = path.join(root, "rollbridge.js")
  let deployReceived = false
  const daemon = net.createServer((socket) => {
    socket.setEncoding("utf8")
    socket.on("data", (contents) => {
      const command = JSON.parse(String(contents).trim())

      if (command.command === "deploy") deployReceived = true
      socket.end(`${JSON.stringify({
        activeReleaseId: "current",
        application: "runtime-retention-test",
        daemonRuntime: {digest: "0".repeat(64), format: 1, path: "/durable/runtime", version: "0.1.14"},
        releases: []
      })}\n`)
    })
  })

  try {
    await prepareRelease(release, false)
    await fs.writeFile(configPath, `export default ${JSON.stringify(basicConfig(socketPath), null, 2)}\n`)
    await new Promise((resolve, reject) => {
      daemon.once("error", reject)
      daemon.listen(socketPath, () => resolve(undefined))
    })

    await assert.rejects(
      () => runReleaseCli(release, [
        "deploy", "--ensure-daemon", "--config", configPath,
        "--release-path", release, "--release-id", "must-not-deploy",
        "--daemon-runtime-path", path.join(root, "runtime")
      ]),
      /legacy or mismatched runtime.*deploy was not sent/s
    )
    assert.equal(deployReceived, false)
  } finally {
    await new Promise((resolve) => daemon.close(resolve))
    await fs.rm(root, {force: true, recursive: true})
  }
})

/**
 * Creates a release-local Rollbridge package with production dependencies and,
 * for release A, a daemon module that performs one deliberately deferred import.
 * @param {string} releasePath - Release directory.
 * @param {boolean} deferredImport - Whether to add the deferred daemon route.
 * @returns {Promise<void>} Resolves when prepared.
 */
async function prepareRelease(releasePath, deferredImport) {
  const packagePath = path.join(releasePath, "node_modules", "rollbridge")

  await fs.mkdir(path.dirname(packagePath), {recursive: true})
  await fs.cp(repoRoot, packagePath, {
    filter: (source) => {
      const relative = path.relative(repoRoot, source)

      return relative !== ".git" && relative !== "node_modules" && relative !== "test" && relative !== "tmp"
    },
    recursive: true
  })

  for (const dependency of ["commander", "eventemitter3", "follow-redirects", "http-proxy", "requires-port"]) {
    await fs.symlink(path.join(repoRoot, "node_modules", dependency), path.join(releasePath, "node_modules", dependency), "dir")
  }

  if (!deferredImport) return

  const daemonPath = path.join(packagePath, "src", "daemon.js")
  const source = await fs.readFile(daemonPath, "utf8")
  const marker = "  proxyHttp(request, response) {\n"
  const deferredRoute = `${marker}    if (request.url === "/deferred-runtime") {\n      void import("./deferred-runtime.js")\n        .then(({default: body}) => { response.writeHead(200); response.end(body) })\n        .catch((error) => { response.writeHead(500); response.end(String(error)) })\n      return\n    }\n\n`

  assert.ok(source.includes(marker))
  await fs.writeFile(daemonPath, source.replace(marker, deferredRoute))
  await fs.writeFile(path.join(packagePath, "src", "deferred-runtime.js"), "export default \"deferred runtime loaded\\n\"\n")
}

/**
 * @param {string} socketPath - Control socket path.
 * @returns {Record<string, import("../src/json.js").JsonValue>} Minimal config.
 */
function basicConfig(socketPath) {
  return {
    application: "runtime-retention-test",
    control: {path: socketPath},
    processes: [{command: "true", id: "web", policy: "proxied", port: {from: 0, to: 0}}],
    proxy: {host: "127.0.0.1", port: 0}
  }
}

/**
 * Runs a release-local Rollbridge CLI to completion.
 * @param {string} releasePath - Release directory.
 * @param {string[]} args - CLI arguments.
 * @returns {Promise<void>} Resolves on success.
 */
async function runReleaseCli(releasePath, args) {
  const binPath = path.join(releasePath, "node_modules", "rollbridge", "bin", "rollbridge")
  const child = spawn(process.execPath, [binPath, ...args], {stdio: ["ignore", "pipe", "pipe"]})
  let output = ""

  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  const [code] = await once(child, "exit")

  if (code !== 0) throw new Error(output)
}
