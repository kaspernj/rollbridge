// @ts-check

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {prepareDaemonRuntime} from "../src/daemon-runtime.js"

test("concurrent runtime preparation converges on one validated content-addressed snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-concurrent-"))

  try {
    const identities = await Promise.all([
      prepareDaemonRuntime(root),
      prepareDaemonRuntime(root),
      prepareDaemonRuntime(root)
    ])

    assert.deepEqual(identities, [identities[0], identities[0], identities[0]])
    assert.match(identities[0].digest, /^[a-f0-9]{64}$/)
    assert.equal(path.dirname(identities[0].path), root)
    assert.equal(JSON.parse(await fs.readFile(path.join(identities[0].path, "runtime.json"), "utf8")).digest, identities[0].digest)

    const entries = (await fs.readdir(root)).filter((entry) => entry.startsWith(".prepare-"))
    assert.deepEqual(entries, [])
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("preparation fails closed when an existing content-addressed snapshot is corrupt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-corrupt-"))

  try {
    const identity = await prepareDaemonRuntime(root)

    await fs.writeFile(path.join(identity.path, "src", "daemon.js"), "corrupt\n")
    await assert.rejects(() => prepareDaemonRuntime(root), /runtime validation failed/)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("runtime preparation rejects a symlinked or shared-writable parent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-permissions-"))
  const target = path.join(root, "target")
  const symlink = path.join(root, "symlink")
  const shared = path.join(root, "shared")

  try {
    await fs.mkdir(target)
    await fs.symlink(target, symlink, "dir")
    await assert.rejects(() => prepareDaemonRuntime(symlink), /must be a real directory/)

    if (process.platform === "win32") {
      t.skip("POSIX directory permissions are not available on Windows")
      return
    }

    await fs.mkdir(shared, {mode: 0o777})
    await fs.chmod(shared, 0o777)
    await assert.rejects(() => prepareDaemonRuntime(shared), /must not be writable by group or other users/)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})
