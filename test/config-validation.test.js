// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {normalizeConfig, validateConfig} from "../src/config.js"
import {runCli} from "../src/cli.js"

test("validateConfig collects duplicate ids, proxied ports, and policy combinations", () => {
  const {issues} = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [
      {command: "run web", id: "web", policy: "proxied"},
      {command: "run worker", id: "web", policy: "companion"}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })
  const messages = issues.map((issue) => issue.message)

  assert.ok(messages.includes("Duplicate process id: web"), `expected duplicate id issue in ${JSON.stringify(messages)}`)
  assert.ok(messages.includes("Proxied process web must define a port range"), `expected missing proxied port issue in ${JSON.stringify(messages)}`)
  assert.ok(issues.every((issue) => typeof issue.fix === "string" && issue.fix.length > 0), "every issue should include an example fix")
})

test("validateConfig reports invalid ranges and missing proxied process without throwing", () => {
  const {issues} = validateConfig({
    application: "demo",
    processes: [
      {command: "run worker", id: "worker", policy: "companion", port: {from: 200, to: 100}}
    ],
    proxy: {port: 8182}
  })
  const messages = issues.map((issue) => issue.message)

  assert.ok(messages.includes("processes[0].port must be a positive port or valid {from, to} range"), `expected invalid range issue in ${JSON.stringify(messages)}`)
  assert.ok(messages.includes("Config must define exactly one proxied process; found 0"), `expected missing proxied process issue in ${JSON.stringify(messages)}`)
})

test("validateConfig returns a normalized config and no issues for a valid config", () => {
  const {config, issues} = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [
      {command: "run web", health: {path: "/ping"}, id: "web", policy: "proxied", port: {from: 18000, to: 18099}}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  assert.deepEqual(issues, [])
  assert.equal(config.processes.length, 1)
  assert.equal(config.processes[0].policy, "proxied")
  assert.equal(config.proxy.port, 8182)
})

test("validateConfig defaults outputLines and accepts a positive override", () => {
  const {config, issues} = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}},
      {command: "run worker", id: "worker", outputLines: 5, policy: "companion"}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  assert.deepEqual(issues, [])
  assert.equal(config.processes[0].outputLines, 50)
  assert.equal(config.processes[1].outputLines, 5)
})

test("validateConfig rejects a non-positive-integer outputLines with a fix", () => {
  const {issues} = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [
      {command: "run web", id: "web", outputLines: 0, policy: "proxied", port: {from: 18000, to: 18099}}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  const issue = issues.find((candidate) => candidate.message === "processes[0].outputLines must be a positive integer")

  assert.ok(issue, `expected an outputLines issue in ${JSON.stringify(issues.map((candidate) => candidate.message))}`)
  assert.match(issue.fix, /positive integer/)
})

test("normalizeConfig throws an aggregated error listing every issue", () => {
  assert.throws(
    () => normalizeConfig({
      application: "demo",
      processes: [
        {command: "run web", id: "web", policy: "proxied"},
        {command: "run web", id: "web", policy: "proxied"}
      ],
      proxy: {port: 8182}
    }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Duplicate process id: web/)
      assert.match(error.message, /exactly one proxied process; found 2/)

      return true
    }
  )
})

test("validate CLI command reports every issue with a fix and exits non-zero", async () => {
  const configPath = await writeConfig({
    application: "demo",
    processes: [
      {command: "run web", id: "web", policy: "proxied"}
    ],
    proxy: {port: 8182}
  })

  try {
    const {output} = await captureCli(["node", "rollbridge", "validate", "-c", configPath])

    assert.equal(process.exitCode, 1)
    assert.match(output, /Proxied process web must define a port range/)
    assert.match(output, /Fix: Add a port range to the proxied process "web"/)
  } finally {
    process.exitCode = 0
    await fs.rm(path.dirname(configPath), {force: true, recursive: true})
  }
})

test("validate CLI command accepts a valid config without setting a failure exit code", async () => {
  const configPath = await writeConfig({
    application: "demo",
    control: {path: "/tmp/rollbridge-cli-valid.sock"},
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  try {
    const {output} = await captureCli(["node", "rollbridge", "validate", "-c", configPath])

    assert.notEqual(process.exitCode, 1)
    assert.match(output, /is valid: 1 process, proxy on 127\.0\.0\.1:8182\./)
  } finally {
    await fs.rm(path.dirname(configPath), {force: true, recursive: true})
  }
})

/**
 * @param {Record<string, import("../src/json.js").JsonValue>} config - Raw config object.
 * @returns {Promise<string>} Path to the written config module.
 */
async function writeConfig(config) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-validate-"))
  const configPath = path.join(dir, "rollbridge.js")

  // CommonJS so the module loads from a temp dir (no package.json) on any supported Node version.
  await fs.writeFile(configPath, `module.exports = ${JSON.stringify(config, null, 2)}\n`)

  return configPath
}

/**
 * Runs the CLI while capturing console output.
 * @param {string[]} argv - Process argv.
 * @returns {Promise<{output: string}>} Captured stdout and stderr lines joined by newlines.
 */
async function captureCli(argv) {
  const originalLog = console.log
  const originalError = console.error
  /** @type {string[]} */
  const lines = []
  const collect = (/** @type {string[]} */ ...args) => { lines.push(args.map((arg) => String(arg)).join(" ")) }

  console.log = collect
  console.error = collect

  try {
    await runCli(argv)
  } finally {
    console.log = originalLog
    console.error = originalError
  }

  return {output: lines.join("\n")}
}
