// @ts-check

import {createHash} from "node:crypto"
import {execFile} from "node:child_process"
import fs from "node:fs/promises"
import {createRequire} from "node:module"
import os from "node:os"
import path from "node:path"
import {promisify} from "node:util"
import {fileURLToPath} from "node:url"

const RUNTIME_FORMAT = 1
const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * @typedef {{digest: string, format: number, path: string, version: string}} DaemonRuntimeIdentity
 */

/**
 * Atomically prepares a content-addressed Rollbridge runtime outside the package tree.
 * @param {string} basePath - Stable parent directory for runtime snapshots.
 * @returns {Promise<DaemonRuntimeIdentity>} Prepared runtime identity.
 */
export async function prepareDaemonRuntime(basePath) {
  await fs.mkdir(basePath, {mode: 0o700, recursive: true})
  await validateRuntimeBase(basePath)

  const stagingPath = await fs.mkdtemp(path.join(basePath, ".prepare-"))

  try {
    await copyPackageClosure(packageRoot, stagingPath, new Set(), true)
    const digest = await directoryDigest(stagingPath)
    const version = await packageVersion(stagingPath)
    const runtimePath = path.join(basePath, digest)
    const identity = {digest, format: RUNTIME_FORMAT, path: runtimePath, version}

    await fs.writeFile(path.join(stagingPath, "runtime.json"), `${JSON.stringify(identity, null, 2)}\n`, {mode: 0o600})
    await validateRuntime(stagingPath, identity)

    try {
      await fs.rename(stagingPath, runtimePath)
    } catch (error) {
      const fileError = /** @type {Error & {code?: string}} */ (error)

      if (!hasCode(fileError, "EEXIST") && !hasCode(fileError, "ENOTEMPTY")) throw error
      await validateRuntime(runtimePath, identity)
      await fs.rm(stagingPath, {force: true, recursive: true})
    }

    await validateRuntime(runtimePath, identity)
    return identity
  } catch (error) {
    await fs.rm(stagingPath, {force: true, recursive: true}).catch(() => {})
    throw error
  }
}

/**
 * Rejects a runtime parent that another local user could replace or modify.
 * @param {string} basePath - Runtime parent directory.
 * @returns {Promise<void>} Resolves when private to the current user.
 */
async function validateRuntimeBase(basePath) {
  const stats = await fs.lstat(basePath)

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Rollbridge daemon runtime path must be a real directory: ${basePath}`)
  }

  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`Rollbridge daemon runtime path must be owned by the current user: ${basePath}`)
  }

  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`Rollbridge daemon runtime path must not be writable by group or other users: ${basePath}`)
  }
}

/**
 * Reads and validates the runtime identity supplied to a detached daemon.
 * @param {string | undefined} manifestPath - Runtime manifest path.
 * @returns {Promise<DaemonRuntimeIdentity>} Validated identity.
 */
export async function loadDaemonRuntimeIdentity(manifestPath) {
  if (!manifestPath) return await currentPackageIdentity()

  const runtimePath = path.dirname(manifestPath)
  const identity = parseIdentity(JSON.parse(await fs.readFile(manifestPath, "utf8")))

  if (path.resolve(identity.path) !== path.resolve(runtimePath)) {
    throw new Error(`Daemon runtime manifest path mismatch: expected ${runtimePath}, got ${identity.path}`)
  }

  await validateRuntime(runtimePath, identity)
  return identity
}

/**
 * @returns {Promise<DaemonRuntimeIdentity>} Identity of the package running a foreground daemon.
 */
export async function currentPackageIdentity() {
  return {
    digest: await packageClosureDigest(packageRoot),
    format: RUNTIME_FORMAT,
    path: packageRoot,
    version: await packageVersion(packageRoot)
  }
}

/**
 * @param {string} sourcePath - Source package directory.
 * @param {string} destinationPath - Destination package directory.
 * @param {Set<string>} ancestry - Real package paths in the current dependency chain.
 * @param {boolean} root - Whether this is Rollbridge itself.
 * @returns {Promise<void>} Resolves when copied.
 */
async function copyPackageClosure(sourcePath, destinationPath, ancestry, root) {
  const realSourcePath = await fs.realpath(sourcePath)

  if (ancestry.has(realSourcePath)) return

  const nextAncestry = new Set(ancestry).add(realSourcePath)
  const packageJson = JSON.parse(await fs.readFile(path.join(realSourcePath, "package.json"), "utf8"))

  await fs.mkdir(destinationPath, {recursive: true})

  if (root) {
    for (const entry of ["bin", "src", "package.json"]) {
      await fs.cp(path.join(realSourcePath, entry), path.join(destinationPath, entry), {dereference: true, recursive: true})
    }
  } else {
    await fs.cp(realSourcePath, destinationPath, {
      dereference: true,
      filter: (source) => path.relative(realSourcePath, source).split(path.sep)[0] !== "node_modules",
      recursive: true
    })
  }

  for (const dependency of Object.keys(packageJson.dependencies || {}).sort()) {
    const dependencySource = await resolvePackageRoot(realSourcePath, dependency)
    const dependencyDestination = path.join(destinationPath, "node_modules", ...dependency.split("/"))

    await copyPackageClosure(dependencySource, dependencyDestination, nextAncestry, false)
  }
}

/**
 * @param {string} parentPackagePath - Requiring package root.
 * @param {string} dependency - Dependency package name.
 * @returns {Promise<string>} Resolved dependency package root.
 */
async function resolvePackageRoot(parentPackagePath, dependency) {
  const require = createRequire(path.join(parentPackagePath, "package.json"))
  let candidate = path.dirname(require.resolve(dependency))

  while (candidate !== path.dirname(candidate)) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(candidate, "package.json"), "utf8"))

      if (metadata.name === dependency) return candidate
    } catch (error) {
      if (!hasCode(/** @type {Error & {code?: string}} */ (error), "ENOENT")) throw error
    }

    candidate = path.dirname(candidate)
  }

  throw new Error(`Unable to resolve package root for Rollbridge runtime dependency ${dependency}`)
}

/**
 * @param {string} runtimePath - Runtime directory.
 * @param {DaemonRuntimeIdentity} identity - Expected identity.
 * @returns {Promise<void>} Resolves when valid.
 */
async function validateRuntime(runtimePath, identity) {
  const manifestIdentity = parseIdentity(JSON.parse(await fs.readFile(path.join(runtimePath, "runtime.json"), "utf8")))
  const actualDigest = await directoryDigest(runtimePath, new Set(["runtime.json"]))
  const actualVersion = await packageVersion(runtimePath)
  const manifestMatches = manifestIdentity.format === identity.format && manifestIdentity.digest === identity.digest &&
    manifestIdentity.version === identity.version && path.resolve(manifestIdentity.path) === path.resolve(identity.path)

  if (!manifestMatches || identity.format !== RUNTIME_FORMAT || actualDigest !== identity.digest || actualVersion !== identity.version) {
    throw new Error(`Rollbridge daemon runtime validation failed at ${runtimePath}`)
  }

  await execFileAsync(process.execPath, [path.join(runtimePath, "bin", "rollbridge"), "--help"], {
    env: {...process.env, ROLLBRIDGE_DAEMON_RUNTIME_MANIFEST: path.join(runtimePath, "runtime.json")},
    timeout: 10000
  })
}

/**
 * @param {string} sourcePath - Package root.
 * @returns {Promise<string>} Closure digest.
 */
async function packageClosureDigest(sourcePath) {
  const temporaryPath = await fs.mkdtemp(path.join(os.tmpdir(), "rollbridge-digest-"))

  try {
    await copyPackageClosure(sourcePath, temporaryPath, new Set(), true)
    return await directoryDigest(temporaryPath)
  } finally {
    await fs.rm(temporaryPath, {force: true, recursive: true})
  }
}

/**
 * @param {string} rootPath - Directory to hash.
 * @param {Set<string>} [ignored] - Root-relative paths to ignore.
 * @returns {Promise<string>} SHA-256 digest.
 */
async function directoryDigest(rootPath, ignored = new Set()) {
  const hash = createHash("sha256")

  for (const relativePath of await listFiles(rootPath)) {
    if (ignored.has(relativePath)) continue
    const filePath = path.join(rootPath, relativePath)
    hash.update(relativePath)
    hash.update("\0")
    hash.update(await fs.readFile(filePath))
    hash.update("\0")
  }

  return hash.digest("hex")
}

/**
 * @param {string} rootPath - Directory to walk.
 * @returns {Promise<string[]>} Sorted files.
 */
async function listFiles(rootPath) {
  /** @type {string[]} */
  const files = []

  /**
   * @param {string} relativePath - Root-relative directory.
   * @returns {Promise<void>} Resolves after walking the directory.
   */
  async function walk(relativePath) {
    const entries = await fs.readdir(path.join(rootPath, relativePath), {withFileTypes: true})

    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      const childPath = path.join(relativePath, entry.name)

      if (entry.isDirectory()) await walk(childPath)
      else if (entry.isFile()) files.push(childPath)
      else throw new Error(`Unsupported entry in Rollbridge runtime: ${path.join(rootPath, childPath)}`)
    }
  }

  await walk("")
  return files
}

/**
 * @param {string} rootPath - Package root.
 * @returns {Promise<string>} Package version.
 */
async function packageVersion(rootPath) {
  const metadata = JSON.parse(await fs.readFile(path.join(rootPath, "package.json"), "utf8"))

  if (typeof metadata.version !== "string" || metadata.version.length === 0) throw new Error("Rollbridge package version is missing")
  return metadata.version
}

/**
 * @param {import("./json.js").JsonValue} value - Parsed manifest.
 * @returns {DaemonRuntimeIdentity} Valid identity.
 */
function parseIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Rollbridge daemon runtime manifest")

  const identity = /** @type {Record<string, import("./json.js").JsonValue>} */ (value)

  if (identity.format !== RUNTIME_FORMAT || typeof identity.digest !== "string" || !/^[a-f0-9]{64}$/.test(identity.digest) || typeof identity.path !== "string" || typeof identity.version !== "string") {
    throw new Error("Invalid Rollbridge daemon runtime manifest")
  }

  return {digest: identity.digest, format: identity.format, path: identity.path, version: identity.version}
}

/**
 * @param {Error & {code?: string} | null | undefined} error - Error.
 * @param {string} code - Error code.
 * @returns {boolean} Whether it matches.
 */
function hasCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code)
}
