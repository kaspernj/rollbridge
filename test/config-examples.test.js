// @ts-check

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {describe, expect, test} from "@velocious/testing"
import {fileURLToPath} from "node:url"
import {loadConfig} from "../src/config.js"

describe("config-examples", () => {

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("TensorBuzz example config loads", async () => {
  const config = await loadConfig(path.join(repoRoot, "examples", "tensorbuzz.com.js"))

  expect(config.application).toBe("tensorbuzz")
  expect(config.control.path).toBe("/tmp/rollbridge-tensorbuzz.sock")
  expect(config.proxy.host).toBe("127.0.0.1")
  expect(config.proxy.port).toBe(4500)
  expect(config.proxy.healthPath).toBe("/ping")
  expect(config.processes.map((processConfig) => [processConfig.id, processConfig.policy])).toEqual([
      ["beacon", "service"],
      ["background-jobs-main", "service"],
      ["background-jobs-worker", "companion"],
      ["web", "proxied"]
    ])
  expect(config.processes[2].lifecycle.reactivateCommand).toBe("appctl jobs-worker-reactivate --pid $ROLLBRIDGE_PID")
  expect(config.processes[3].env.VELOCIOUS_BACKGROUND_JOBS_PORT).toBe("{{ports.background-jobs-main}}")
})

test("loadConfig resolves a config module that exports a function", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-fn-config-"))
  const configPath = path.join(dir, "rollbridge.js")
  const moduleSource = [
    "module.exports = () => ({",
    "  application: process.env.ROLLBRIDGE_TEST_APP || \"fn-demo\",",
    "  control: {path: \"/tmp/rollbridge-fn-demo.sock\"},",
    "  proxy: {host: \"127.0.0.1\", port: 8190},",
    "  processes: [{id: \"web\", policy: \"proxied\", command: \"run web\", port: {from: 18000, to: 18099}}]",
    "})",
    ""
  ].join("\n")

  await fs.writeFile(configPath, moduleSource)
  process.env.ROLLBRIDGE_TEST_APP = "computed-app"

  try {
    const config = await loadConfig(configPath)

    expect(config.application).toBe("computed-app")
    expect(config.proxy.port).toBe(8190)
    expect(config.processes[0].id).toBe("web")
  } finally {
    delete process.env.ROLLBRIDGE_TEST_APP
    await fs.rm(dir, {force: true, recursive: true})
  }
})
})
