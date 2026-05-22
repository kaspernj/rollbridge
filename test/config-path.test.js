// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {resolveConfigPath} from "../src/config.js"
import {runCli} from "../src/cli.js"

const validConfig = {
  application: "demo",
  control: {path: "/tmp/rollbridge-config-path.sock"},
  processes: [
    {command: "run web", id: "web", policy: "proxied", port: {from: 18000, to: 18099}}
  ],
  proxy: {host: "127.0.0.1", port: 8182}
}

/**
 * @param {string} dir - Directory to write the module into.
 * @returns {Promise<string>} The written config module path.
 */
async function writeConfigModule(dir) {
  const configPath = path.join(dir, "rollbridge.js")

  // CommonJS so the module loads from a temp dir (no package.json) on any supported Node version.
  await fs.writeFile(configPath, `module.exports = ${JSON.stringify(validConfig, null, 2)}\n`)

  return configPath
}

test("resolveConfigPath returns an explicit path unchanged", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-cfgpath-"))

  try {
    assert.equal(await resolveConfigPath("/somewhere/custom.js", dir), "/somewhere/custom.js")
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("resolveConfigPath resolves rollbridge.js in the working directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-cfgpath-"))

  try {
    await writeConfigModule(dir)

    assert.equal(await resolveConfigPath(undefined, dir), path.join(dir, "rollbridge.js"))
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("resolveConfigPath throws an actionable error when no default config exists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-cfgpath-"))

  try {
    await assert.rejects(
      () => resolveConfigPath(undefined, dir),
      /No config file found.*rollbridge\.js/
    )
  } finally {
    await fs.rm(dir, {force: true, recursive: true})
  }
})

test("validate CLI command resolves the default config when --config is omitted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-cfgpath-"))
  const originalCwd = process.cwd()

  await writeConfigModule(dir)

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

  assert.match(lines.join("\n"), /rollbridge\.js is valid: 1 process, proxy on 127\.0\.0\.1:8182\./)
})
