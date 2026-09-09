// @ts-check

import {execFile} from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {describe, expect, test} from "@velocious/testing"
import {fileURLToPath} from "node:url"
import {promisify} from "node:util"

describe("package-metadata", () => {

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const execFileAsync = promisify(execFile)

test("package.json declares publish metadata", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"))

  expect(pkg.name).toBe("rollbridge")
  expect(pkg.license).toBe("MIT")
  expect(pkg.homepage).toBe("https://github.com/kaspernj/rollbridge#readme")
  expect(pkg.bugs.url).toBe("https://github.com/kaspernj/rollbridge/issues")
  expect(pkg.repository.type).toBe("git")
  expect(pkg.repository.url).toMatch(/github\.com\/kaspernj\/rollbridge/)
  expect(typeof pkg.author === "string" && pkg.author.length > 0).toBeTruthy()
  expect(Array.isArray(pkg.keywords) && pkg.keywords.length > 0).toBeTruthy()
})

test("a LICENSE file matching the declared license exists", async () => {
  const license = await fs.readFile(path.join(repoRoot, "LICENSE"), "utf8")

  expect(license).toMatch(/MIT License/)
  expect(license).toMatch(/Copyright \(c\) \d{4} kaspernj/)
})

test("package manifest excludes unexpected operational and coverage files", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-pack-"))

  try {
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
    const packageOutput = JSON.parse(stdout)
    const packageArchive = Array.isArray(packageOutput) ? packageOutput[0] : Object.values(packageOutput)[0]

    if (!(packageArchive && Array.isArray(packageArchive.files))) throw new Error("Expected package archive file list")
    /** @type {Array<{path: string}>} */
    const packageFiles = packageArchive.files
    const packagePaths = packageFiles.map((file) => file.path)

    for (const requiredPath of ["LICENSE", "README.md", "bin/rollbridge", "package.json", "src/cli.js", "src/daemon-runtime.js"]) {
      expect({value: Boolean(packagePaths.includes(requiredPath)), context: `expected package to include ${requiredPath}`}).toMatchObject({value: true})
    }
    expect(!packagePaths.some((packagePath) => packagePath === "tmp" || packagePath.startsWith("tmp/"))).toBeTruthy()
    expect(!packagePaths.some((packagePath) => packagePath === "coverage" || packagePath.startsWith("coverage/"))).toBeTruthy()
  } finally {
    await fs.rm(fixtureRoot, {force: true, recursive: true})
  }
})
})
