#!/usr/bin/env node
import {execSync} from "node:child_process"

/** @param {string} command - Shell command to run. */
function run(command) {
  execSync(command, {
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      GIT_MERGE_AUTOEDIT: "no"
    },
    stdio: "inherit"
  })
}

/** @returns {void} Updates local master to the latest origin/master commit. */
function ensureLatestMaster() {
  run("git checkout master")
  run("git fetch origin")
  run("git merge --ff-only origin/master")
}

try {
  execSync("npm whoami", {stdio: "ignore"})
} catch {
  run("npm login")
}

ensureLatestMaster()

run("npm version patch --no-git-tag-version")
run("npm install")
run("git add package.json package-lock.json")
run('git commit -m "chore: bump patch version"')
run("git push origin master")
run("npm publish")
