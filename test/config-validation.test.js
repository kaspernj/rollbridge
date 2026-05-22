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

test("validateConfig parses control.mode, defaults it to unset, and rejects invalid modes", () => {
  /**
   * @param {import("../src/json.js").JsonValue} control - Control config under test.
   * @returns {{config: import("../src/config.js").RollbridgeConfig, issues: import("../src/config.js").ConfigIssue[]}} Validation result.
   */
  const validateControl = (control) => validateConfig({
    application: "demo",
    control,
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  const parsed = validateControl({mode: "660", path: "/tmp/demo.sock"})

  assert.deepEqual(parsed.issues, [])
  assert.equal(parsed.config.control.mode, 0o660)

  // Minimal octal strings are accepted, matching the numeric boundary (e.g. 0).
  const minimal = validateControl({mode: "0", path: "/tmp/demo.sock"})

  assert.deepEqual(minimal.issues, [])
  assert.equal(minimal.config.control.mode, 0)

  assert.equal(validateControl({path: "/tmp/demo.sock"}).config.control.mode, undefined)

  const invalid = validateControl({mode: "abc", path: "/tmp/demo.sock"})

  assert.ok(invalid.issues.some((issue) => issue.message === "control.mode must be an octal file mode between 0 and 0o777"))
})

test("validateConfig defaults health.startDelayMs to 0, accepts an override, and rejects negatives", () => {
  /**
   * @param {import("../src/json.js").JsonValue} health - Health config under test, or undefined to omit it.
   * @returns {{config: import("../src/config.js").RollbridgeConfig, issues: import("../src/config.js").ConfigIssue[]}} Validation result.
   */
  const validateHealth = (health) => validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [{command: "run web", health, id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  const defaulted = validateHealth({path: "/ping"})

  assert.deepEqual(defaulted.issues, [])
  assert.equal(defaulted.config.processes[0].health?.startDelayMs, 0)

  const custom = validateHealth({path: "/ping", startDelayMs: 2000})

  assert.deepEqual(custom.issues, [])
  assert.equal(custom.config.processes[0].health?.startDelayMs, 2000)

  const negative = validateHealth({path: "/ping", startDelayMs: -1})

  assert.ok(negative.issues.some((issue) => issue.message === "processes[0].health.startDelayMs must be a non-negative number"))
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

test("validate --json emits a machine-readable result", async () => {
  const validPath = await writeConfig({
    application: "demo",
    control: {path: "/tmp/rollbridge-json-valid.sock"},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: 8182}
  })
  const invalidPath = await writeConfig({
    application: "demo",
    processes: [{command: "run web", id: "web", policy: "proxied"}],
    proxy: {port: 8182}
  })

  try {
    const valid = JSON.parse((await captureCli(["node", "rollbridge", "validate", "--json", "-c", validPath])).output)

    assert.equal(valid.valid, true)
    assert.deepEqual(valid.issues, [])
    assert.equal(valid.config.processes, 1)
    assert.notEqual(process.exitCode, 1)

    const invalid = JSON.parse((await captureCli(["node", "rollbridge", "validate", "--json", "-c", invalidPath])).output)

    assert.equal(invalid.valid, false)
    assert.equal(invalid.config, null)
    assert.ok(invalid.issues.some((/** @type {{message: string}} */ issue) => /must define a port range/.test(issue.message)))
    assert.equal(process.exitCode, 1)
  } finally {
    process.exitCode = 0
    await fs.rm(path.dirname(validPath), {force: true, recursive: true})
    await fs.rm(path.dirname(invalidPath), {force: true, recursive: true})
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
