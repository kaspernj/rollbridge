#!/usr/bin/env node
import {execFileSync} from "node:child_process"

/**
 * Runs a command and inherits stdio.
 * @param {string} command - Command to run.
 * @param {string[]} [args] - Command arguments.
 * @returns {void}
 */
function run(command, args = []) {
  execFileSync(command, args, {
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      GIT_MERGE_AUTOEDIT: "no"
    },
    stdio: "inherit"
  })
}

/**
 * Runs a command and returns trimmed stdout.
 * @param {string} command - Command to run.
 * @param {string[]} [args] - Command arguments.
 * @returns {string} Trimmed stdout.
 */
function output(command, args = []) {
  return execFileSync(command, args, {encoding: "utf8"}).trim()
}

/** @returns {string} GitHub remote default branch name. */
function defaultBranch() {
  const remoteHead = output("git", ["ls-remote", "--symref", "origin", "HEAD"])
  const match = remoteHead.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)

  if (!match) throw new Error("Unable to determine origin default branch")

  return match[1]
}

/**
 * @param {string} branch - Branch name.
 * @returns {boolean} True when the local branch exists.
 */
function localBranchExists(branch) {
  try {
    output("git", ["rev-parse", "--verify", `refs/heads/${branch}`])
    return true
  } catch (_error) {
    return false
  }
}

/** @returns {string} Updated default branch name. */
function updateLocalDefaultBranch() {
  run("git", ["fetch", "origin"])
  const branch = defaultBranch()

  if (localBranchExists(branch)) {
    run("git", ["checkout", branch])
  } else {
    run("git", ["checkout", "-b", branch, `origin/${branch}`])
  }

  run("git", ["merge", "--ff-only", `origin/${branch}`])

  return branch
}

try {
  execFileSync("npm", ["whoami"], {stdio: "ignore"})
} catch {
  run("npm", ["login"])
}

const branch = updateLocalDefaultBranch()

run("npm", ["version", "patch", "--no-git-tag-version"])
run("npm", ["install"])
run("git", ["add", "package.json", "package-lock.json"])
run("git", ["commit", "-m", "chore: bump patch version"])
run("git", ["push", "origin", branch])
run("npm", ["publish"])
