// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import {loadConfig} from "../src/config.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("TensorBuzz example config loads", async () => {
  const config = await loadConfig(path.join(repoRoot, "examples", "tensorbuzz.com.js"))

  assert.equal(config.application, "tensorbuzz")
  assert.equal(config.control.path, "/tmp/rollbridge-tensorbuzz.sock")
  assert.equal(config.proxy.host, "127.0.0.1")
  assert.equal(config.proxy.port, 4500)
  assert.equal(config.proxy.healthPath, "/ping")
  assert.deepEqual(
    config.processes.map((processConfig) => [processConfig.id, processConfig.policy]),
    [
      ["beacon", "service"],
      ["background-jobs-main", "service"],
      ["background-jobs-worker", "companion"],
      ["web", "proxied"]
    ]
  )
  assert.equal(config.processes[3].env.VELOCIOUS_BACKGROUND_JOBS_PORT, "{{ports.background-jobs-main}}")
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

    assert.equal(config.application, "computed-app")
    assert.equal(config.proxy.port, 8190)
    assert.equal(config.processes[0].id, "web")
  } finally {
    delete process.env.ROLLBRIDGE_TEST_APP
    await fs.rm(dir, {force: true, recursive: true})
  }
})
