// @ts-check

import assert from "node:assert/strict"
import test from "node:test"
import {runCli} from "../src/cli.js"

/**
 * Runs the CLI while capturing stdout, stderr, and the resulting exit code.
 * @param {string[]} argv - Process argv.
 * @returns {Promise<{code: number | string | undefined, errorOutput: string, output: string}>} Captured output and exit code.
 */
async function capture(argv) {
  const originalLog = console.log
  const originalError = console.error
  const originalExitCode = process.exitCode
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const err = []

  console.log = (/** @type {string[]} */ ...args) => { out.push(args.map((arg) => String(arg)).join(" ")) }
  console.error = (/** @type {string[]} */ ...args) => { err.push(args.map((arg) => String(arg)).join(" ")) }
  process.exitCode = 0

  try {
    await runCli(argv)
  } finally {
    console.log = originalLog
    console.error = originalError
  }

  const code = process.exitCode

  process.exitCode = originalExitCode

  return {code, errorOutput: err.join("\n"), output: out.join("\n")}
}

test("completion bash prints a sourceable script with commands and option flags", async () => {
  const {code, output} = await capture(["node", "rollbridge", "completion", "bash"])

  assert.notEqual(code, 1)
  assert.match(output, /complete -F _rollbridge rollbridge/)
  assert.match(output, /compgen -W "daemon deploy rollback ensure-daemon status stop restart shutdown validate doctor logs events predeploy-cleanup recover completion"/)
  // A command's own options are completed after the command.
  assert.match(output, /deploy\)\n\s+opts="[^"]*--release-path[^"]*"/)
  assert.match(output, /restart\)\n\s+opts="[^"]*--policy[^"]*"/)
})

test("completion zsh prints a #compdef script with per-command options", async () => {
  const {output} = await capture(["node", "rollbridge", "completion", "zsh"])

  assert.match(output, /^#compdef rollbridge/)
  assert.match(output, /compdef _rollbridge rollbridge/)
  assert.match(output, /commands=\(daemon deploy rollback ensure-daemon status stop restart shutdown validate doctor logs events predeploy-cleanup recover completion\)/)
  assert.match(output, /events\) compadd -- [^\n]*--limit/)
})

test("completion rejects an unsupported shell with a non-zero exit code", async () => {
  const {code, errorOutput} = await capture(["node", "rollbridge", "completion", "fish"])

  assert.equal(code, 1)
  assert.match(errorOutput, /Unsupported shell "fish"\. Supported shells: bash, zsh\./)
})
