// @ts-check

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {describe, expect, test} from "@velocious/testing"
import {prepareDaemonRuntime} from "../src/daemon-runtime.js"

describe("daemon-runtime", () => {

const posixPermissionsTest = process.platform === "win32" ? test.skip : test

test("concurrent runtime preparation converges on one validated content-addressed snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-concurrent-"))

  try {
    const identities = await Promise.all([
      prepareDaemonRuntime(root),
      prepareDaemonRuntime(root),
      prepareDaemonRuntime(root)
    ])

    expect(identities).toEqual([identities[0], identities[0], identities[0]])
    expect(identities[0].digest).toMatch(/^[a-f0-9]{64}$/)
    expect(path.dirname(identities[0].path)).toBe(root)
    expect(JSON.parse(await fs.readFile(path.join(identities[0].path, "runtime.json"), "utf8")).digest).toBe(identities[0].digest)

    const entries = (await fs.readdir(root)).filter((entry) => entry.startsWith(".prepare-"))
    expect(entries).toEqual([])
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

test("preparation fails closed when an existing content-addressed snapshot is corrupt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-corrupt-"))

  try {
    const identity = await prepareDaemonRuntime(root)

    await fs.writeFile(path.join(identity.path, "src", "daemon.js"), "corrupt\n")
    await expect(prepareDaemonRuntime(root)).rejects.toThrow(/runtime validation failed/)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

posixPermissionsTest("runtime preparation rejects a symlinked or shared-writable parent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-permissions-"))
  const target = path.join(root, "target")
  const symlink = path.join(root, "symlink")
  const shared = path.join(root, "shared")

  try {
    await fs.mkdir(target)
    await fs.symlink(target, symlink, "dir")
    await expect(prepareDaemonRuntime(symlink)).rejects.toThrow(/must be a real directory/)

    await fs.mkdir(shared, {mode: 0o777})
    await fs.chmod(shared, 0o777)
    await expect(prepareDaemonRuntime(shared)).rejects.toThrow(/must not be writable by group or other users/)
  } finally {
    await fs.rm(root, {force: true, recursive: true})
  }
})

posixPermissionsTest("runtime preparation rejects a private leaf beneath a replaceable ancestor", async () => {
  const unsafeAncestor = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-runtime-unsafe-ancestor-"))
  const privateLeaf = path.join(unsafeAncestor, "private-runtime")

  try {
    await fs.chmod(unsafeAncestor, 0o777)
    await fs.mkdir(privateLeaf, {mode: 0o700})

    await expect(prepareDaemonRuntime(privateLeaf)).rejects.toThrow(/ancestor must be sticky or not writable by group or other users/)
  } finally {
    await fs.chmod(unsafeAncestor, 0o700)
    await fs.rm(unsafeAncestor, {force: true, recursive: true})
  }
})
})
