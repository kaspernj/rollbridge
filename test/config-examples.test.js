// @ts-check

import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import {loadConfig} from "../src/config.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("TensorBuzz example config loads", async () => {
  const config = await loadConfig(path.join(repoRoot, "examples", "tensorbuzz.com.yml"))

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
