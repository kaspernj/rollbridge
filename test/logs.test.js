// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import RollbridgeDaemon from "../src/daemon.js"
import {normalizeConfig} from "../src/config.js"
import {formatLogSources, runCli} from "../src/cli.js"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const dummyAppPath = path.join(currentDir, "fixtures", "dummy-app.js")

test("formatLogSources renders a section per process with timestamped lines", () => {
  const output = formatLogSources([
    {id: "web", logs: [{at: "2026-05-22T00:00:00.000Z", line: "listening", stream: "stdout"}], source: "release v1 (active)"},
    {id: "beacon", logs: [], source: "service"}
  ], undefined)

  assert.match(output, /== web \[release v1 \(active\)\] ==/)
  assert.match(output, /2026-05-22T00:00:00\.000Z \[stdout\] listening/)
  assert.match(output, /== beacon \[service\] ==/)
  assert.match(output, /\(no recent output\)/)
})

test("formatLogSources filters to a single process id", () => {
  const sources = [
    {id: "web", logs: [], source: "release v1 (active)"},
    {id: "beacon", logs: [], source: "service"}
  ]

  const output = formatLogSources(sources, "web")

  assert.match(output, /== web /)
  assert.doesNotMatch(output, /beacon/)
})

test("formatLogSources reports when there are no processes or no match", () => {
  assert.equal(formatLogSources([], undefined), "No managed processes.")
  assert.equal(
    formatLogSources([{id: "web", logs: [], source: "release v1 (active)"}], "missing"),
    'No process found with id "missing".'
  )
})

test("logs CLI prints captured output per managed process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-logs-"))
  const socketPath = path.join(root, "rollbridge.sock")
  const rawConfig = {
    application: "rollbridge-logs-test",
    control: {path: socketPath},
    processes: [
      {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(dummyAppPath)}`,
        health: {intervalMs: 50, path: "/ping", timeoutMs: 3000},
        id: "web",
        policy: "proxied",
        port: {from: 0, to: 0}
      }
    ],
    proxy: {host: "127.0.0.1", port: 0}
  }

  // CommonJS config file so the CLI can load it from a temp dir on any Node version.
  await fs.writeFile(path.join(root, "rollbridge.js"), `module.exports = ${JSON.stringify(rawConfig)}\n`)

  const daemon = new RollbridgeDaemon({config: normalizeConfig(rawConfig), logger: () => {}})

  await daemon.start()

  const originalLog = console.log
  /** @type {string[]} */
  const lines = []

  console.log = (/** @type {string[]} */ ...args) => { lines.push(args.map((arg) => String(arg)).join(" ")) }

  try {
    await daemon.deploy({releaseId: "v1", releasePath: root, revision: "v1"})
    await runCli(["node", "rollbridge", "logs", "-c", path.join(root, "rollbridge.js")])

    assert.match(lines.join("\n"), /== web \[release v1 \(active\)\] ==/)

    lines.length = 0
    await runCli(["node", "rollbridge", "logs", "--json", "-c", path.join(root, "rollbridge.js")])

    const parsed = JSON.parse(lines.join("\n"))
    const web = parsed.find((/** @type {{id: string, logs: import("../src/managed-process.js").ManagedProcessLog[], source: string}} */ entry) => entry.id === "web")

    assert.ok(web, "expected a web entry in the JSON output")
    assert.match(web.source, /release v1 \(active\)/)
    assert.ok(Array.isArray(web.logs))
  } finally {
    console.log = originalLog
    await daemon.shutdown()
    await fs.rm(root, {force: true, recursive: true})
  }
})
