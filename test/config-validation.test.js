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

test("validateConfig defaults wildcard proxy upstreams to loopback", () => {
  const {config, issues} = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [
      {command: "run web", health: {path: "/ping"}, id: "web", policy: "proxied", port: {from: 18000, to: 18099}}
    ],
    proxy: {host: "0.0.0.0", port: 8182}
  })

  assert.deepEqual(issues, [])
  assert.equal(config.proxy.host, "0.0.0.0")
  assert.equal(config.proxy.upstreamHost, "127.0.0.1")
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

test("validateConfig defaults the restart policy, accepts overrides, and rejects bad values", () => {
  /**
   * @param {import("../src/json.js").JsonValue} restart - Restart policy under test, or undefined to omit it.
   * @returns {{config: import("../src/config.js").RollbridgeConfig, issues: import("../src/config.js").ConfigIssue[]}} Validation result.
   */
  const validateRestart = (restart) => validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}, restart}],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  const defaulted = validateRestart(undefined)

  assert.deepEqual(defaulted.issues, [])
  assert.deepEqual(defaulted.config.processes[0].restart, {backoffFactor: 1, maxDelayMs: 0, maxRestarts: undefined, windowMs: 0})

  const custom = validateRestart({backoffFactor: 2, maxDelayMs: 30000, maxRestarts: 5, windowMs: 60000})

  assert.deepEqual(custom.issues, [])
  assert.deepEqual(custom.config.processes[0].restart, {backoffFactor: 2, maxDelayMs: 30000, maxRestarts: 5, windowMs: 60000})

  // maxRestarts: 0 disables automatic restarts.
  const disabled = validateRestart({maxRestarts: 0})

  assert.deepEqual(disabled.issues, [])
  assert.equal(disabled.config.processes[0].restart.maxRestarts, 0)

  const invalid = validateRestart({backoffFactor: 0.5, maxDelayMs: -1, maxRestarts: -2, windowMs: -3})
  const messages = invalid.issues.map((issue) => issue.message)

  assert.ok(messages.includes("processes[0].restart.backoffFactor must be a number greater than or equal to 1"), JSON.stringify(messages))
  assert.ok(messages.includes("processes[0].restart.maxRestarts must be a non-negative integer"), JSON.stringify(messages))
  assert.ok(messages.includes("processes[0].restart.maxDelayMs must be a non-negative number"), JSON.stringify(messages))
  assert.ok(messages.includes("processes[0].restart.windowMs must be a non-negative number"), JSON.stringify(messages))

  // A fractional maxRestarts is rejected (it must be a whole number of restarts).
  assert.ok(validateRestart({maxRestarts: 1.5}).issues.some((issue) => issue.message === "processes[0].restart.maxRestarts must be a non-negative integer"))
})

test("validateConfig defaults replicas, accepts companion replicas, and rejects bad placements", () => {
  /**
   * @param {import("../src/json.js").JsonValue} worker - Second (worker) process definition.
   * @returns {{config: import("../src/config.js").RollbridgeConfig, issues: import("../src/config.js").ConfigIssue[]}} Validation result.
   */
  const validateWorker = (worker) => validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}, worker],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  assert.equal(validateWorker({command: "run worker", id: "worker", policy: "companion"}).config.processes[1].replicas, 1)

  const replicated = validateWorker({command: "run worker", id: "worker", policy: "companion", replicas: 4})

  assert.deepEqual(replicated.issues, [])
  assert.equal(replicated.config.processes[1].replicas, 4)

  // replicas > 1 on a companion with a port is rejected.
  assert.ok(validateWorker({command: "run worker", id: "worker", policy: "companion", port: {from: 19000, to: 19099}, replicas: 2}).issues
    .some((issue) => /can only set replicas > 1 on a companion process without a port/.test(issue.message)))

  // replicas > 1 on a non-companion policy is rejected.
  assert.ok(validateWorker({command: "run broker", id: "broker", policy: "service", replicas: 2}).issues
    .some((issue) => /can only set replicas > 1 on a companion/.test(issue.message)))

  // Non-positive replicas is rejected.
  assert.ok(validateWorker({command: "run worker", id: "worker", policy: "companion", replicas: 0}).issues
    .some((issue) => issue.message === "processes[1].replicas must be a positive integer"))

  // A "#" in a process id (reserved for replica instance ids) is rejected.
  assert.ok(validateWorker({command: "run worker", id: "work#er", policy: "companion"}).issues
    .some((issue) => /must not contain "#"/.test(issue.message)))
})

test("validateConfig defaults stopSignal, accepts valid signals, and rejects unknown ones", () => {
  /**
   * @param {import("../src/json.js").JsonValue} stopSignal - Stop signal under test, or undefined to omit it.
   * @returns {{config: import("../src/config.js").RollbridgeConfig, issues: import("../src/config.js").ConfigIssue[]}} Validation result.
   */
  const validateStopSignal = (stopSignal) => validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}, stopSignal}],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  assert.equal(validateStopSignal(undefined).config.processes[0].stopSignal, "SIGTERM")

  const custom = validateStopSignal("SIGINT")

  assert.deepEqual(custom.issues, [])
  assert.equal(custom.config.processes[0].stopSignal, "SIGINT")

  const invalid = validateStopSignal("SIGBOGUS")

  assert.ok(invalid.issues.some((issue) => issue.message === "processes[0].stopSignal must be a valid signal name"), JSON.stringify(invalid.issues.map((issue) => issue.message)))
})

test("validateConfig normalizes memory supervision and rejects bad values", () => {
  /**
   * @param {import("../src/json.js").JsonValue} memory - Memory config under test, or undefined to omit it.
   * @returns {{config: import("../src/config.js").RollbridgeConfig, issues: import("../src/config.js").ConfigIssue[]}} Validation result.
   */
  const validateMemory = (memory) => validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [{command: "run web", id: "web", memory, policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  // Omitted → monitoring off.
  assert.equal(validateMemory(undefined).config.processes[0].memory, undefined)

  const custom = validateMemory({checkIntervalMs: 2000, limitBytes: 1048576, warnBytes: 524288})

  assert.deepEqual(custom.issues, [])
  assert.deepEqual(custom.config.processes[0].memory, {checkIntervalMs: 2000, limitBytes: 1048576, warnBytes: 524288})

  // Defaults checkIntervalMs and warnBytes when only limitBytes is given.
  const defaulted = validateMemory({limitBytes: 1048576})

  assert.deepEqual(defaulted.issues, [])
  assert.deepEqual(defaulted.config.processes[0].memory, {checkIntervalMs: 5000, limitBytes: 1048576, warnBytes: 0})

  const invalid = validateMemory({checkIntervalMs: 0, limitBytes: 0, warnBytes: -1})
  const messages = invalid.issues.map((issue) => issue.message)

  assert.ok(messages.includes("processes[0].memory.limitBytes must be a positive integer"), JSON.stringify(messages))
  assert.ok(messages.includes("processes[0].memory.warnBytes must be a non-negative integer"), JSON.stringify(messages))
  assert.ok(messages.includes("processes[0].memory.checkIntervalMs must be a positive number"), JSON.stringify(messages))
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

test("validateConfig accepts control owner/group as ids or names and rejects bad values", () => {
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

  const numeric = validateControl({group: 1000, owner: 1000, path: "/tmp/demo.sock"})

  assert.deepEqual(numeric.issues, [])
  assert.equal(numeric.config.control.owner, 1000)
  assert.equal(numeric.config.control.group, 1000)

  const named = validateControl({group: "deploy", owner: "deploy", path: "/tmp/demo.sock"})

  assert.deepEqual(named.issues, [])
  assert.equal(named.config.control.owner, "deploy")
  assert.equal(named.config.control.group, "deploy")

  // Unset by default.
  assert.equal(validateControl({path: "/tmp/demo.sock"}).config.control.owner, undefined)
  assert.equal(validateControl({path: "/tmp/demo.sock"}).config.control.group, undefined)

  const invalid = validateControl({group: -1, owner: true, path: "/tmp/demo.sock"})
  const messages = invalid.issues.map((issue) => issue.message)

  assert.ok(messages.includes("control.owner must be a non-negative integer id or a name"), JSON.stringify(messages))
  assert.ok(messages.includes("control.group must be a non-negative integer id or a name"), JSON.stringify(messages))
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

test("validateConfig defaults releaseRetention, accepts overrides, and rejects bad values", () => {
  /**
   * @param {import("../src/json.js").JsonValue} releaseRetention - Retention config under test, or undefined.
   * @returns {{config: import("../src/config.js").RollbridgeConfig, issues: import("../src/config.js").ConfigIssue[]}} Validation result.
   */
  const validateRetention = (releaseRetention) => validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: 8182},
    releaseRetention
  })

  const defaulted = validateRetention(undefined)

  assert.deepEqual(defaulted.issues, [])
  assert.deepEqual(defaulted.config.releaseRetention, {keep: 10, maxAgeMs: 0})

  const custom = validateRetention({keep: 3, maxAgeMs: 60000})

  assert.deepEqual(custom.issues, [])
  assert.deepEqual(custom.config.releaseRetention, {keep: 3, maxAgeMs: 60000})

  const invalid = validateRetention({keep: -1, maxAgeMs: -5})

  assert.ok(invalid.issues.some((issue) => issue.message === "releaseRetention.keep must be a non-negative integer"))
  assert.ok(invalid.issues.some((issue) => issue.message === "releaseRetention.maxAgeMs must be a non-negative number"))
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
