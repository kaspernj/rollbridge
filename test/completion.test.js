// @ts-check

import {describe, expect, test} from "@velocious/testing"
import {runCli} from "../src/cli.js"

describe("completion", () => {

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

  expect(code).not.toBe(1)
  expect(output).toMatch(/complete -F _rollbridge rollbridge/)
  expect(output).toMatch(/compgen -W "daemon deploy rollback recover-generation-transition ensure-daemon status stop restart shutdown validate doctor logs events predeploy-cleanup recover completion"/)
  // A command's own options are completed after the command.
  expect(output).toMatch(/deploy\)\n\s+opts="[^"]*--release-path[^"]*"/)
  expect(output).toMatch(/recover-generation-transition\)\n\s+opts="--config --release-path --release-id --revision --previous-release-id --accept-retired-incumbent"/)
  expect(output).toMatch(/ensure-daemon\)\n\s+opts="[^"]*--daemon-runtime-path[^"]*"/)
  expect(output).toMatch(/restart\)\n\s+opts="[^"]*--policy[^"]*"/)
})

test("completion zsh prints a #compdef script with per-command options", async () => {
  const {output} = await capture(["node", "rollbridge", "completion", "zsh"])

  expect(output).toMatch(/^#compdef rollbridge/)
  expect(output).toMatch(/compdef _rollbridge rollbridge/)
  expect(output).toMatch(/commands=\(daemon deploy rollback recover-generation-transition ensure-daemon status stop restart shutdown validate doctor logs events predeploy-cleanup recover completion\)/)
  expect(output).toMatch(/recover-generation-transition\) compadd -- --config --release-path --release-id --revision --previous-release-id --accept-retired-incumbent/)
  expect(output).toMatch(/events\) compadd -- [^\n]*--limit/)
})

test("completion rejects an unsupported shell with a non-zero exit code", async () => {
  const {code, errorOutput} = await capture(["node", "rollbridge", "completion", "fish"])

  expect(code).toBe(1)
  expect(errorOutput).toMatch(/Unsupported shell "fish"\. Supported shells: bash, zsh\./)
})
})
