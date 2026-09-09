// @ts-check

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {describe, expect, test} from "@velocious/testing"
import {normalizeConfig, validateConfig} from "../src/config.js"
import {runCli} from "../src/cli.js"

describe("config-validation", () => {

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

  expect({value: Boolean(messages.includes("Duplicate process id: web")), context: `expected duplicate id issue in ${JSON.stringify(messages)}`}).toMatchObject({value: true})
  expect({value: Boolean(messages.includes("Proxied process web must define a port range")), context: `expected missing proxied port issue in ${JSON.stringify(messages)}`}).toMatchObject({value: true})
  expect(issues.every((issue) => typeof issue.fix === "string" && issue.fix.length > 0)).toBe(true)
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

  expect({value: Boolean(messages.includes("processes[0].port must be a positive port or valid {from, to} range")), context: `expected invalid range issue in ${JSON.stringify(messages)}`}).toMatchObject({value: true})
  expect({value: Boolean(messages.includes("Config must define exactly one proxied process; found 0")), context: `expected missing proxied process issue in ${JSON.stringify(messages)}`}).toMatchObject({value: true})
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

  expect(issues).toEqual([])
  expect(config.processes.length).toBe(1)
  expect(config.processes[0].policy).toBe("proxied")
  expect(config.proxy.port).toBe(8182)
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

  expect(issues).toEqual([])
  expect(config.proxy.host).toBe("0.0.0.0")
  expect(config.proxy.upstreamHost).toBe("127.0.0.1")
})

test("validateConfig accepts legacy takeover screens and process matchers", () => {
  const {config, issues} = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    legacyTakeover: {
      forceStopTimeoutMs: 250,
      processes: [
        {includes: ["/srv/demo/", "velocious server", "--port 4500"], name: "legacy web"}
      ],
      screens: ["demo-backend"]
    },
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  expect(issues).toEqual([])
  expect(config.legacyTakeover).toEqual({
    forceStopTimeoutMs: 250,
    processes: [
      {includes: ["/srv/demo/", "velocious server", "--port 4500"], name: "legacy web"}
    ],
    screens: ["demo-backend"]
  })
})

test("validateConfig rejects empty legacy takeover config", () => {
  const {issues} = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    legacyTakeover: {},
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  expect({value: Boolean(issues.some((issue) => issue.message === "legacyTakeover must define at least one screen or process matcher")), context: JSON.stringify(issues)}).toMatchObject({value: true})
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

  expect(issues).toEqual([])
  expect(config.processes[0].outputLines).toBe(50)
  expect(config.processes[1].outputLines).toBe(5)
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

  expect(defaulted.issues).toEqual([])
  expect(defaulted.config.processes[0].restart).toEqual({backoffFactor: 1, maxDelayMs: 0, maxRestarts: undefined, windowMs: 0})

  const custom = validateRestart({backoffFactor: 2, maxDelayMs: 30000, maxRestarts: 5, windowMs: 60000})

  expect(custom.issues).toEqual([])
  expect(custom.config.processes[0].restart).toEqual({backoffFactor: 2, maxDelayMs: 30000, maxRestarts: 5, windowMs: 60000})

  // maxRestarts: 0 disables automatic restarts.
  const disabled = validateRestart({maxRestarts: 0})

  expect(disabled.issues).toEqual([])
  expect(disabled.config.processes[0].restart.maxRestarts).toBe(0)

  const invalid = validateRestart({backoffFactor: 0.5, maxDelayMs: -1, maxRestarts: -2, windowMs: -3})
  const messages = invalid.issues.map((issue) => issue.message)

  expect({value: Boolean(messages.includes("processes[0].restart.backoffFactor must be a number greater than or equal to 1")), context: JSON.stringify(messages)}).toMatchObject({value: true})
  expect({value: Boolean(messages.includes("processes[0].restart.maxRestarts must be a non-negative integer")), context: JSON.stringify(messages)}).toMatchObject({value: true})
  expect({value: Boolean(messages.includes("processes[0].restart.maxDelayMs must be a non-negative number")), context: JSON.stringify(messages)}).toMatchObject({value: true})
  expect({value: Boolean(messages.includes("processes[0].restart.windowMs must be a non-negative number")), context: JSON.stringify(messages)}).toMatchObject({value: true})

  // A fractional maxRestarts is rejected (it must be a whole number of restarts).
  expect(validateRestart({maxRestarts: 1.5}).issues.some((issue) => issue.message === "processes[0].restart.maxRestarts must be a non-negative integer")).toBeTruthy()
})

test("validateConfig defaults lifecycle, accepts hooks, and rejects bad values", () => {
  /**
   * @param {import("../src/json.js").JsonValue} lifecycle - Lifecycle config under test, or undefined.
   * @returns {{config: import("../src/config.js").RollbridgeConfig, issues: import("../src/config.js").ConfigIssue[]}} Validation result.
   */
  const validateLifecycle = (lifecycle) => validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [{command: "run web", id: "web", lifecycle, policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  // Omitted → no commands, zero drain.
  expect(validateLifecycle(undefined).config.processes[0].lifecycle).toEqual({activateTimeoutMs: 30000, drainTimeoutMs: 0})

  const custom = validateLifecycle({activateTimeoutMs: 60000, drainTimeoutMs: 30000, quietCommand: "kill -TSTP $ROLLBRIDGE_PID", stopCommand: "kill -TERM $ROLLBRIDGE_PID"})

  expect(custom.issues).toEqual([])
  expect(custom.config.processes[0].lifecycle.quietCommand).toBe("kill -TSTP $ROLLBRIDGE_PID")
  expect(custom.config.processes[0].lifecycle.stopCommand).toBe("kill -TERM $ROLLBRIDGE_PID")
  expect(custom.config.processes[0].lifecycle.activateTimeoutMs).toBe(60000)
  expect(custom.config.processes[0].lifecycle.drainTimeoutMs).toBe(30000)

  const invalid = validateLifecycle({activateTimeoutMs: 0, drainTimeoutMs: -1, quietCommand: 5})
  const messages = invalid.issues.map((issue) => issue.message)

  expect({value: Boolean(messages.includes("processes[0].lifecycle.activateTimeoutMs must be a positive number")), context: JSON.stringify(messages)}).toMatchObject({value: true})
  expect({value: Boolean(messages.includes("processes[0].lifecycle.drainTimeoutMs must be a non-negative number")), context: JSON.stringify(messages)}).toMatchObject({value: true})
  expect({value: Boolean(messages.includes("processes[0].lifecycle.quietCommand must be a string")), context: JSON.stringify(messages)}).toMatchObject({value: true})

  // drainCommand needs a positive drainTimeoutMs to bound it; otherwise the drain step is skipped.
  expect(validateLifecycle({drainCommand: "drain"}).issues
    .some((issue) => issue.message === "processes[0].lifecycle.drainCommand requires a positive processes[0].lifecycle.drainTimeoutMs")).toBeTruthy()
  expect(validateLifecycle({drainCommand: "drain", drainTimeoutMs: 1000}).issues).toEqual([])

  // A stopCommand replaces stopSignal, so a stopCommand alongside the default SIGTERM is fine.
  expect(validateLifecycle({stopCommand: "kill -TERM $ROLLBRIDGE_PID"}).issues).toEqual([])
})

test("validateConfig accepts one durable handoff activation lifecycle and rejects unsafe placements", () => {
  const base = {
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    ownerRecovery: {reconnectGraceMs: 30000},
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}},
      {
        command: "run jobs",
        deployStrategy: "handoff",
        id: "jobs",
        lifecycle: {activateCommand: "jobs activate", quietCommand: "jobs retire"},
        policy: "service",
        port: {from: 18100, to: 18199}
      }
    ],
    proxy: {host: "127.0.0.1", port: 8182},
    statePath: "/tmp/demo.state.json"
  }
  const valid = validateConfig(base)

  expect(valid.issues).toEqual([])
  expect(valid.config.processes[1].lifecycle.activateCommand).toBe("jobs activate")

  const invalidType = validateConfig({...base, processes: [base.processes[0], {...base.processes[1], lifecycle: {activateCommand: 5, quietCommand: "jobs retire"}}]})
  expect(invalidType.issues.some((issue) => issue.message === "processes[1].lifecycle.activateCommand must be a string")).toBeTruthy()

  const emptyCommands = validateConfig({...base, processes: [base.processes[0], {...base.processes[1], lifecycle: {activateCommand: " ", quietCommand: ""}}]})
  expect(emptyCommands.issues.some((issue) => issue.message === "processes[1].lifecycle.activateCommand must not be empty")).toBeTruthy()
  expect(emptyCommands.issues.some((issue) => issue.message === "processes[1].lifecycle.quietCommand must not be empty")).toBeTruthy()

  const missingRetirement = validateConfig({...base, processes: [base.processes[0], {...base.processes[1], lifecycle: {activateCommand: "jobs activate"}}]})
  expect(missingRetirement.issues.some((issue) => /requires lifecycle\.quietCommand/.test(issue.message))).toBeTruthy()

  const nonHandoff = validateConfig({...base, processes: [base.processes[0], {...base.processes[1], deployStrategy: "persistent"}]})
  expect(nonHandoff.issues.some((issue) => /activateCommand.*handoff service/.test(issue.message))).toBeTruthy()

  const withoutRecovery = validateConfig({...base, ownerRecovery: undefined, statePath: undefined})
  expect(withoutRecovery.issues.some((issue) => /activateCommand requires ownerRecovery and statePath/.test(issue.message))).toBeTruthy()

  const duplicate = validateConfig({...base, processes: [
    base.processes[0],
    base.processes[1],
    {...base.processes[1], id: "jobs-secondary", port: {from: 18200, to: 18299}}
  ]})
  expect(duplicate.issues.some((issue) => /at most one lifecycle\.activateCommand/.test(issue.message))).toBeTruthy()

  const worker = {
    command: "run worker",
    id: "worker",
    lifecycle: {quietCommand: "worker quiet", reactivateCommand: "worker resume"},
    nonBlockingDrain: true,
    policy: "companion"
  }
  const pairedWorker = validateConfig({...base, processes: [...base.processes, worker]})

  expect(pairedWorker.issues).toEqual([])
  expect(pairedWorker.config.processes[2].lifecycle.reactivateCommand).toBe("worker resume")

  const unpairedWorker = validateConfig({...base, processes: [...base.processes, {...worker, lifecycle: {quietCommand: "worker quiet"}}]})
  expect(unpairedWorker.issues.some((issue) => /quietCommand requires lifecycle\.reactivateCommand/.test(issue.message))).toBeTruthy()

  const unsupportedPlacement = validateConfig({...base, processes: [...base.processes, {...worker, nonBlockingDrain: false}]})
  expect(unsupportedPlacement.issues.some((issue) => /reactivateCommand.*nonBlockingDrain companion/.test(issue.message))).toBeTruthy()
})

test("validateConfig accepts indefinite graceful stop windows", () => {
  const {config, issues} = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}},
      {command: "run worker", gracefulStopMs: "indefinite", id: "worker", policy: "companion"}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  expect(issues).toEqual([])
  expect(config.processes[1].gracefulStopMs).toBe("indefinite")
})

test("validateConfig accepts handoff services only with a multi-port service range", () => {
  const valid = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}},
      {command: "run service", deployStrategy: "handoff", id: "beacon", policy: "service", port: {from: 18100, to: 18199}}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  expect(valid.issues).toEqual([])
  expect(valid.config.processes[1].deployStrategy).toBe("handoff")

  const defaulted = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  expect(defaulted.config.processes[0].deployStrategy).toBe("persistent")

  const invalidProcess = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}},
      {command: "run worker", deployStrategy: "handoff", id: "worker", policy: "companion"}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  expect({value: Boolean(invalidProcess.issues.some((issue) => issue.message === "Process \"worker\" can only set deployStrategy: \"handoff\" on a service process")), context: JSON.stringify(invalidProcess.issues)}).toMatchObject({value: true})

  const missingPort = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}},
      {command: "run service", deployStrategy: "handoff", id: "beacon", policy: "service"}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  expect({value: Boolean(missingPort.issues.some((issue) => issue.message === "Handoff service \"beacon\" must define a port range")), context: JSON.stringify(missingPort.issues)}).toMatchObject({value: true})

  const fixedPort = validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [
      {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}},
      {command: "run service", deployStrategy: "handoff", id: "beacon", policy: "service", port: 18100}
    ],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  expect({value: Boolean(fixedPort.issues.some((issue) => issue.message === "Handoff service \"beacon\" must use a multi-port range")), context: JSON.stringify(fixedPort.issues)}).toMatchObject({value: true})
})

test("validateConfig rejects a custom stopSignal alongside a stopCommand that would ignore it", () => {
  /**
   * @param {Record<string, import("../src/json.js").JsonValue>} overrides - Extra fields merged onto the worker process.
   * @returns {{config: import("../src/config.js").RollbridgeConfig, issues: import("../src/config.js").ConfigIssue[]}} Validation result.
   */
  const validateWorker = (overrides) => validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}, {command: "run worker", id: "worker", policy: "companion", ...overrides}],
    proxy: {host: "127.0.0.1", port: 8182}
  })

  // A custom stopSignal with a stopCommand is contradictory: stopCommand runs instead of the signal.
  expect(validateWorker({lifecycle: {stopCommand: "kill -TERM $ROLLBRIDGE_PID"}, stopSignal: "SIGINT"}).issues
    .some((issue) => /sets both lifecycle.stopCommand and a custom stopSignal/.test(issue.message))).toBe(true)

  // stopSignal alone (no stopCommand) is fine — the signal is what stops the worker.
  expect(validateWorker({stopSignal: "SIGINT"}).issues).toEqual([])

  // stopCommand alone (default SIGTERM) is fine — nothing custom is silently dropped.
  expect(validateWorker({lifecycle: {stopCommand: "kill -TERM $ROLLBRIDGE_PID"}}).issues).toEqual([])

  // An explicit default stopSignal next to a stopCommand is not flagged (SIGTERM is the default).
  expect(validateWorker({lifecycle: {stopCommand: "kill -TERM $ROLLBRIDGE_PID"}, stopSignal: "SIGTERM"}).issues).toEqual([])
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

  expect(validateWorker({command: "run worker", id: "worker", policy: "companion"}).config.processes[1].replicas).toBe(1)

  const replicated = validateWorker({command: "run worker", id: "worker", policy: "companion", replicas: 4})

  expect(replicated.issues).toEqual([])
  expect(replicated.config.processes[1].replicas).toBe(4)

  // replicas > 1 on a companion with a port is rejected.
  expect(validateWorker({command: "run worker", id: "worker", policy: "companion", port: {from: 19000, to: 19099}, replicas: 2}).issues
    .some((issue) => /can only set replicas > 1 on a companion process without a port/.test(issue.message))).toBeTruthy()

  // replicas > 1 on a non-companion policy is rejected.
  expect(validateWorker({command: "run broker", id: "broker", policy: "service", replicas: 2}).issues
    .some((issue) => /can only set replicas > 1 on a companion/.test(issue.message))).toBeTruthy()

  // Non-positive replicas is rejected.
  expect(validateWorker({command: "run worker", id: "worker", policy: "companion", replicas: 0}).issues
    .some((issue) => issue.message === "processes[1].replicas must be a positive integer")).toBeTruthy()

  // A "#" in a process id (reserved for replica instance ids) is rejected.
  expect(validateWorker({command: "run worker", id: "work#er", policy: "companion"}).issues
    .some((issue) => /must not contain "#"/.test(issue.message))).toBeTruthy()

  // nonBlockingDrain defaults to false, is accepted on a companion, and rejected elsewhere.
  expect(validateWorker({command: "run worker", id: "worker", policy: "companion"}).config.processes[1].nonBlockingDrain).toBe(false)

  const draining = validateWorker({command: "run worker", id: "worker", nonBlockingDrain: true, policy: "companion"})

  expect(draining.issues).toEqual([])
  expect(draining.config.processes[1].nonBlockingDrain).toBe(true)

  expect(validateWorker({command: "run b", id: "broker", nonBlockingDrain: true, policy: "service"}).issues
    .some((issue) => /can only set nonBlockingDrain on a companion/.test(issue.message))).toBeTruthy()
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

  expect(validateStopSignal(undefined).config.processes[0].stopSignal).toBe("SIGTERM")

  const custom = validateStopSignal("SIGINT")

  expect(custom.issues).toEqual([])
  expect(custom.config.processes[0].stopSignal).toBe("SIGINT")

  const invalid = validateStopSignal("SIGBOGUS")

  expect({value: Boolean(invalid.issues.some((issue) => issue.message === "processes[0].stopSignal must be a valid signal name")), context: JSON.stringify(invalid.issues.map((issue) => issue.message))}).toMatchObject({value: true})
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
  expect(validateMemory(undefined).config.processes[0].memory).toBe(undefined)

  const custom = validateMemory({checkIntervalMs: 2000, limitBytes: 1048576, warnBytes: 524288})

  expect(custom.issues).toEqual([])
  expect(custom.config.processes[0].memory).toEqual({checkIntervalMs: 2000, limitBytes: 1048576, warnBytes: 524288})

  // Defaults checkIntervalMs and warnBytes when only limitBytes is given.
  const defaulted = validateMemory({limitBytes: 1048576})

  expect(defaulted.issues).toEqual([])
  expect(defaulted.config.processes[0].memory).toEqual({checkIntervalMs: 5000, limitBytes: 1048576, warnBytes: 0})

  const invalid = validateMemory({checkIntervalMs: 0, limitBytes: 0, warnBytes: -1})
  const messages = invalid.issues.map((issue) => issue.message)

  expect({value: Boolean(messages.includes("processes[0].memory.limitBytes must be a positive integer")), context: JSON.stringify(messages)}).toMatchObject({value: true})
  expect({value: Boolean(messages.includes("processes[0].memory.warnBytes must be a non-negative integer")), context: JSON.stringify(messages)}).toMatchObject({value: true})
  expect({value: Boolean(messages.includes("processes[0].memory.checkIntervalMs must be a positive number")), context: JSON.stringify(messages)}).toMatchObject({value: true})
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

  if (!issue) throw new Error(`expected an outputLines issue in ${JSON.stringify(issues.map((candidate) => candidate.message))}`)
  expect(issue.fix).toMatch(/positive integer/)
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

  expect(parsed.issues).toEqual([])
  expect(parsed.config.control.mode).toBe(0o660)

  // Minimal octal strings are accepted, matching the numeric boundary (e.g. 0).
  const minimal = validateControl({mode: "0", path: "/tmp/demo.sock"})

  expect(minimal.issues).toEqual([])
  expect(minimal.config.control.mode).toBe(0)

  expect(validateControl({path: "/tmp/demo.sock"}).config.control.mode).toBe(undefined)

  const invalid = validateControl({mode: "abc", path: "/tmp/demo.sock"})

  expect(invalid.issues.some((issue) => issue.message === "control.mode must be an octal file mode between 0 and 0o777")).toBeTruthy()
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

  expect(numeric.issues).toEqual([])
  expect(numeric.config.control.owner).toBe(1000)
  expect(numeric.config.control.group).toBe(1000)

  const named = validateControl({group: "deploy", owner: "deploy", path: "/tmp/demo.sock"})

  expect(named.issues).toEqual([])
  expect(named.config.control.owner).toBe("deploy")
  expect(named.config.control.group).toBe("deploy")

  // Unset by default.
  expect(validateControl({path: "/tmp/demo.sock"}).config.control.owner).toBe(undefined)
  expect(validateControl({path: "/tmp/demo.sock"}).config.control.group).toBe(undefined)

  const invalid = validateControl({group: -1, owner: true, path: "/tmp/demo.sock"})
  const messages = invalid.issues.map((issue) => issue.message)

  expect({value: Boolean(messages.includes("control.owner must be a non-negative integer id or a name")), context: JSON.stringify(messages)}).toMatchObject({value: true})
  expect({value: Boolean(messages.includes("control.group must be a non-negative integer id or a name")), context: JSON.stringify(messages)}).toMatchObject({value: true})
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

  expect(defaulted.issues).toEqual([])
  expect(defaulted.config.processes[0].health?.startDelayMs).toBe(0)

  const custom = validateHealth({path: "/ping", startDelayMs: 2000})

  expect(custom.issues).toEqual([])
  expect(custom.config.processes[0].health?.startDelayMs).toBe(2000)

  const negative = validateHealth({path: "/ping", startDelayMs: -1})

  expect(negative.issues.some((issue) => issue.message === "processes[0].health.startDelayMs must be a non-negative number")).toBeTruthy()
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

  expect(defaulted.issues).toEqual([])
  expect(defaulted.config.releaseRetention).toEqual({keep: 10, maxAgeMs: 0})

  const custom = validateRetention({keep: 3, maxAgeMs: 60000})

  expect(custom.issues).toEqual([])
  expect(custom.config.releaseRetention).toEqual({keep: 3, maxAgeMs: 60000})

  const invalid = validateRetention({keep: -1, maxAgeMs: -5})

  expect(invalid.issues.some((issue) => issue.message === "releaseRetention.keep must be a non-negative integer")).toBeTruthy()
  expect(invalid.issues.some((issue) => issue.message === "releaseRetention.maxAgeMs must be a non-negative number")).toBeTruthy()
})

test("validateConfig leaves statePath unset by default, accepts a string, and rejects non-strings", () => {
  /**
   * @param {import("../src/json.js").JsonValue} statePath - statePath under test, or undefined.
   * @returns {{config: import("../src/config.js").RollbridgeConfig, issues: import("../src/config.js").ConfigIssue[]}} Validation result.
   */
  const validateStatePath = (statePath) => validateConfig({
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: 8182},
    statePath
  })

  expect(validateStatePath(undefined).config.statePath).toBe(undefined)

  const set = validateStatePath("/var/lib/rollbridge/demo.state.json")

  expect(set.issues).toEqual([])
  expect(set.config.statePath).toBe("/var/lib/rollbridge/demo.state.json")

  expect(validateStatePath(123).issues.some((issue) => issue.message === "statePath must be a string")).toBeTruthy()
})

test("ownerRecovery requires durable state and a non-negative integer reconnection grace", () => {
  const raw = {
    application: "demo",
    control: {path: "/tmp/demo.sock"},
    ownerRecovery: {reconnectGraceMs: 45000},
    processes: [{command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}],
    proxy: {host: "127.0.0.1", port: 8182}
  }
  const missingState = validateConfig(raw)

  expect(missingState.issues.some((issue) => issue.message === "ownerRecovery requires statePath")).toBeTruthy()

  const valid = validateConfig({...raw, statePath: "/var/lib/rollbridge/demo.state.json"})

  expect(valid.issues).toEqual([])
  expect(valid.config.ownerRecovery).toEqual({reconnectGraceMs: 45000})

  const invalidGrace = validateConfig({...raw, ownerRecovery: {reconnectGraceMs: -1}, statePath: "/var/lib/rollbridge/demo.state.json"})

  expect(invalidGrace.issues.some((issue) => issue.message === "ownerRecovery.reconnectGraceMs must be a non-negative integer")).toBeTruthy()
})

test("normalizeConfig throws an aggregated error listing every issue", async () => {
  const normalization = Promise.resolve().then(() => normalizeConfig({
    application: "demo",
    processes: [
      {command: "run web", id: "web", policy: "proxied"},
      {command: "run web", id: "web", policy: "proxied"}
    ],
    proxy: {port: 8182}
  }))

  await expect(normalization).rejects.toBeInstanceOf(Error)
  await expect(normalization).rejects.toMatchObject({message: expect.stringMatching(/Duplicate process id: web/)})
  await expect(normalization).rejects.toMatchObject({message: expect.stringMatching(/exactly one proxied process; found 2/)})
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

    expect(process.exitCode).toBe(1)
    expect(output).toMatch(/Proxied process web must define a port range/)
    expect(output).toMatch(/Fix: Add a port range to the proxied process "web"/)
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

    expect(process.exitCode).not.toBe(1)
    expect(output).toMatch(/is valid: 1 process, proxy on 127\.0\.0\.1:8182\./)
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

    expect(valid.valid).toBe(true)
    expect(valid.issues).toEqual([])
    expect(valid.config.processes).toBe(1)
    expect(process.exitCode).not.toBe(1)

    const invalid = JSON.parse((await captureCli(["node", "rollbridge", "validate", "--json", "-c", invalidPath])).output)

    expect(invalid.valid).toBe(false)
    expect(invalid.config).toBe(null)
    expect(invalid.issues.some((/** @type {{message: string}} */ issue) => /must define a port range/.test(issue.message))).toBeTruthy()
    expect(process.exitCode).toBe(1)
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
})
