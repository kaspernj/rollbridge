// @ts-check

import assert from "node:assert/strict"
import {execFile} from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import {promisify} from "node:util"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const execFileAsync = promisify(execFile)

test("package.json declares publish metadata", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"))

  assert.equal(pkg.name, "rollbridge")
  assert.equal(pkg.license, "MIT")
  assert.equal(pkg.homepage, "https://github.com/kaspernj/rollbridge#readme")
  assert.equal(pkg.bugs.url, "https://github.com/kaspernj/rollbridge/issues")
  assert.equal(pkg.repository.type, "git")
  assert.match(pkg.repository.url, /github\.com\/kaspernj\/rollbridge/)
  assert.ok(typeof pkg.author === "string" && pkg.author.length > 0)
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length > 0)
})

test("a LICENSE file matching the declared license exists", async () => {
  const license = await fs.readFile(path.join(repoRoot, "LICENSE"), "utf8")

  assert.match(license, /MIT License/)
  assert.match(license, /Copyright \(c\) \d{4} kaspernj/)
})

test("package manifest excludes unexpected operational and coverage files", async (t) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-pack-"))
  t.after(() => fs.rm(fixtureRoot, {force: true, recursive: true}))

  await fs.cp(repoRoot, fixtureRoot, {
    filter: (source) => {
      const relative = path.relative(repoRoot, source)
      return relative !== ".git" && relative !== "node_modules" && relative !== "tmp"
    },
    recursive: true,
  })

  const unexpectedTmpPath = path.join(fixtureRoot, "tmp", "worker-control", "unexpected-transcript.jsonl")
  const unexpectedCoveragePath = path.join(fixtureRoot, "coverage", "unexpected.txt")
  await Promise.all([
    fs.mkdir(path.dirname(unexpectedTmpPath), {recursive: true}),
    fs.mkdir(path.dirname(unexpectedCoveragePath), {recursive: true}),
  ])
  await Promise.all([
    fs.writeFile(unexpectedTmpPath, '{"operational":"state"}\n'),
    fs.writeFile(unexpectedCoveragePath, "unexpected coverage output\n"),
  ])

  const {stdout} = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {cwd: fixtureRoot})
  /** @type {Array<{path: string}>} */
  const packageFiles = JSON.parse(stdout)[0].files
  const packagePaths = packageFiles.map((file) => file.path)

  for (const requiredPath of ["LICENSE", "README.md", "bin/rollbridge", "package.json", "src/cli.js", "src/daemon-runtime.js"]) {
    assert.ok(packagePaths.includes(requiredPath), `expected package to include ${requiredPath}`)
  }
  assert.ok(!packagePaths.some((packagePath) => packagePath === "tmp" || packagePath.startsWith("tmp/")))
  assert.ok(!packagePaths.some((packagePath) => packagePath === "coverage" || packagePath.startsWith("coverage/")))
})
