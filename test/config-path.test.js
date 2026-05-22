// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {resolveConfigPath} from "../src/config.js"
import {runCli} from "../src/cli.js"

const validConfigYaml = [
  "application: demo",
  "control:",
  "  path: /tmp/rollbridge-config-path.sock",
  "proxy:",
  "  host: 127.0.0.1",
  "  port: 8182",
  "processes:",
  "  - id: web",
  "    policy: proxied",
  "    command: run web",
  "    port:",
  "      from: 18000",
  "      to: 18099"
].join("\n")

test("resolveConfigPath returns an explicit path unchanged", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-cfgpath-"))

  try {
    assert.equal(await resolveConfigPath("/somewhere/custom.yml", dir), "/somewhere/custom.yml")
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("resolveConfigPath prefers rollbridge.yml, then .yaml, then .json", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-cfgpath-"))

  try {
    await fs.writeFile(path.join(dir, "rollbridge.yml"), validConfigYaml)
    await fs.writeFile(path.join(dir, "rollbridge.yaml"), validConfigYaml)
    await fs.writeFile(path.join(dir, "rollbridge.json"), "{}")

    assert.equal(await resolveConfigPath(undefined, dir), path.join(dir, "rollbridge.yml"))

    await fs.rm(path.join(dir, "rollbridge.yml"))
    assert.equal(await resolveConfigPath(undefined, dir), path.join(dir, "rollbridge.yaml"))

    await fs.rm(path.join(dir, "rollbridge.yaml"))
    assert.equal(await resolveConfigPath(undefined, dir), path.join(dir, "rollbridge.json"))
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("resolveConfigPath throws an actionable error when no default config exists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-cfgpath-"))

  try {
    await assert.rejects(
      () => resolveConfigPath(undefined, dir),
      /No config file found.*rollbridge\.yml, rollbridge\.yaml, rollbridge\.json/
    )
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("validate CLI command resolves the default config when --config is omitted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-cfgpath-"))
  const originalCwd = process.cwd()

  await fs.writeFile(path.join(dir, "rollbridge.yml"), validConfigYaml)

  const originalLog = console.log
  /** @type {string[]} */
  const lines = []

  console.log = (/** @type {string[]} */ ...args) => { lines.push(args.map((arg) => String(arg)).join(" ")) }

  try {
    process.chdir(dir)
    await runCli(["node", "rollbridge", "validate"])
  } finally {
    console.log = originalLog
    process.chdir(originalCwd)
    await fs.rm(dir, {force: true, recursive: true})
  }

  assert.match(lines.join("\n"), /rollbridge\.yml is valid: 1 process, proxy on 127\.0\.0\.1:8182\./)
})
