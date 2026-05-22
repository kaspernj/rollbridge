// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

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
