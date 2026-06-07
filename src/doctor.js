// @ts-check

import {constants as fsConstants} from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import {inspectControlSocket} from "./daemon.js"
import {liveProcesses, readState} from "./state-store.js"
import {processTemplateContext, renderObject, renderTemplate} from "./template.js"

/**
 * @typedef {{detail: string, name: string, ok: boolean}} DoctorCheck
 * @typedef {{cwd: string, id: string, ok: true} | {error: string, id: string, ok: false}} ProcessRender
 */

/**
 * Runs pre-flight environment checks for a validated config: control socket
 * reachability, control-socket directory writability, and proxy port availability.
 * @param {import("./config.js").RollbridgeConfig} config - Normalized config.
 * @returns {Promise<DoctorCheck[]>} One check per probed aspect.
 */
export async function runEnvironmentChecks(config) {
  /** @type {DoctorCheck[]} */
  const checks = []
  const socketInspection = await inspectControlSocketSafely(config.control.path)

  checks.push(controlSocketCheck(config, socketInspection))
  checks.push(await controlSocketDirectoryCheck(config))
  checks.push(await proxyPortCheck(config, socketInspection))

  if (config.statePath !== undefined) {
    // A live daemon persists its own (live) pids into the state file, so they are not orphans.
    const daemonRunning = !("error" in socketInspection) && socketInspection.alive

    checks.push(await statePathDirectoryCheck(config.statePath))
    checks.push(await orphanCheck(config.statePath, daemonRunning))
  }

  return checks
}

/**
 * @param {string} statePath - Configured state file path.
 * @returns {Promise<DoctorCheck>} Whether the state file's directory is writable.
 */
async function statePathDirectoryCheck(statePath) {
  const directory = path.dirname(path.resolve(statePath))

  try {
    await fs.access(directory, fsConstants.W_OK | fsConstants.X_OK)

    return {detail: `${directory} is writable`, name: "state path directory", ok: true}
  } catch {
    return {detail: `${directory} is missing or not writable; state cannot be persisted`, name: "state path directory", ok: false}
  }
}

/**
 * @param {string} statePath - Configured state file path.
 * @param {boolean} daemonRunning - Whether a Rollbridge daemon is currently live on the control socket.
 * @returns {Promise<DoctorCheck>} Whether any orphaned managed processes from a prior daemon are still alive.
 */
async function orphanCheck(statePath, daemonRunning) {
  if (daemonRunning) {
    // The running daemon owns the pids in the state file; they are managed, not orphaned.
    return {detail: "a daemon is running; its managed processes are not orphans", name: "orphaned processes", ok: true}
  }

  const orphans = liveProcesses(await readState(statePath))

  if (orphans.length === 0) {
    return {detail: "no leftover processes from a previous daemon", name: "orphaned processes", ok: true}
  }

  const summary = orphans.map((orphan) => `${orphan.id} (pid ${orphan.pid})`).join(", ")

  return {detail: `${orphans.length} possible orphaned process${orphans.length === 1 ? "" : "es"} still running: ${summary} — verify and stop any leftovers`, name: "orphaned processes", ok: false}
}

/**
 * @param {string} socketPath - Control socket path.
 * @returns {Promise<{alive: boolean, application?: string} | {error: string}>} Probe result, or the probe error.
 */
async function inspectControlSocketSafely(socketPath) {
  try {
    return await inspectControlSocket(socketPath)
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error)}
  }
}

/**
 * @param {import("./config.js").RollbridgeConfig} config - Normalized config.
 * @param {{alive: boolean, application?: string} | {error: string}} inspection - Control socket probe result.
 * @returns {DoctorCheck} Control socket reachability check.
 */
function controlSocketCheck(config, inspection) {
  const socketPath = config.control.path

  if ("error" in inspection) {
    return {detail: `could not probe ${socketPath}: ${inspection.error}`, name: "control socket", ok: false}
  }

  if (!inspection.alive) {
    return {detail: `no daemon running; ${socketPath} is free to bind`, name: "control socket", ok: true}
  }

  if (inspection.application === undefined) {
    return {detail: `another process is already listening on ${socketPath}; the daemon would fail to bind it`, name: "control socket", ok: false}
  }

  if (inspection.application === config.application) {
    return {detail: `Rollbridge daemon for "${inspection.application}" is running on ${socketPath}`, name: "control socket", ok: true}
  }

  return {detail: `a Rollbridge daemon for "${inspection.application}" is already running on ${socketPath}; stop it before starting another`, name: "control socket", ok: false}
}

/**
 * @param {import("./config.js").RollbridgeConfig} config - Normalized config.
 * @returns {Promise<DoctorCheck>} Whether the control socket's directory is writable.
 */
async function controlSocketDirectoryCheck(config) {
  const directory = path.dirname(path.resolve(config.control.path))

  try {
    // Creating a Unix socket needs both write and search (execute) permission on the directory.
    await fs.access(directory, fsConstants.W_OK | fsConstants.X_OK)

    return {detail: `${directory} is writable`, name: "control socket directory", ok: true}
  } catch {
    return {detail: `${directory} is missing or not writable`, name: "control socket directory", ok: false}
  }
}

/**
 * @param {import("./config.js").RollbridgeConfig} config - Normalized config.
 * @param {{alive: boolean, application?: string} | {error: string}} inspection - Control socket probe result.
 * @returns {Promise<DoctorCheck>} Whether the proxy port can be bound or is owned by the running daemon.
 */
async function proxyPortCheck(config, inspection) {
  const address = `${config.proxy.host}:${config.proxy.port}`
  const bind = await canBindPort(config.proxy.host, config.proxy.port)

  if (bind.ok) {
    return {detail: `${address} is available`, name: "proxy port", ok: true}
  }

  if (!("error" in inspection) && inspection.application === config.application) {
    return {detail: `${address} is already held by the running Rollbridge daemon`, name: "proxy port", ok: true}
  }

  return {detail: `${address} is unavailable (${bind.code})`, name: "proxy port", ok: false}
}

/**
 * @param {string} host - Bind host.
 * @param {number} port - Candidate port.
 * @returns {Promise<{ok: true} | {code: string, ok: false}>} Whether the port can be bound.
 */
async function canBindPort(host, port) {
  return await new Promise((resolve) => {
    const server = net.createServer()

    server.once("error", (error) => {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "EUNKNOWN"

      resolve({code, ok: false})
    })
    server.listen(port, host, () => server.close(() => resolve({ok: true})))
  })
}

/**
 * Runs deploy-time checks against a specific release: that the release directory exists, that
 * every process's command/cwd/env templates resolve, and that each rendered working directory
 * exists. These need the per-release values that only exist at deploy time, so the operator
 * supplies them (the release path, and optionally an id/revision). Ports referenced by templates
 * are rendered with the low end of each process's configured range as a representative value.
 * @param {import("./config.js").RollbridgeConfig} config - Normalized config.
 * @param {{releaseId?: string, releasePath: string, revision?: string}} release - Release to render against.
 * @returns {Promise<DoctorCheck[]>} One check per probed aspect.
 */
export async function runReleaseChecks(config, release) {
  const releasePath = path.resolve(release.releasePath)
  const releaseId = release.releaseId || release.revision || path.basename(releasePath)
  const revision = release.revision || releaseId
  const ports = representativePorts(config)
  const renders = config.processes.map((processConfig) => renderProcess(processConfig, {application: config.application, ports, proxy: config.proxy, releaseId, releasePath, revision}))

  return [await releasePathCheck(releasePath), templateCheck(renders), await workingDirectoryCheck(renders)]
}

/**
 * @param {import("./config.js").RollbridgeConfig} config - Normalized config.
 * @returns {Record<string, number>} The ports a deploy would allocate, using each range's low end.
 */
function representativePorts(config) {
  /** @type {Record<string, number>} */
  const ports = {}

  for (const processConfig of config.processes) {
    if (processConfig.port) ports[processConfig.id] = processConfig.port.from
  }

  return ports
}

/**
 * Renders a process's command, cwd, and env against a deploy-time context (replica index 0).
 * @param {import("./config.js").ProcessConfig} processConfig - Process to render.
 * @param {{application: string, ports: Record<string, number>, proxy: import("./config.js").ProxyConfig, releaseId: string, releasePath: string, revision: string}} shared - Shared render inputs.
 * @returns {ProcessRender} The rendered cwd, or the first template error.
 */
function renderProcess(processConfig, shared) {
  const context = processTemplateContext({
    application: shared.application,
    ports: shared.ports,
    processId: processConfig.id,
    proxy: shared.proxy,
    releaseId: shared.releaseId,
    releasePath: shared.releasePath,
    replicaCount: processConfig.replicas,
    replicaIndex: 0,
    revision: shared.revision
  })

  try {
    const cwd = processConfig.cwd ? renderTemplate(processConfig.cwd, context) : shared.releasePath

    renderTemplate(processConfig.command, context)
    renderObject(processConfig.env, context)

    return {cwd: path.resolve(shared.releasePath, cwd), id: processConfig.id, ok: true}
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error), id: processConfig.id, ok: false}
  }
}

/**
 * @param {string} releasePath - Resolved release directory.
 * @returns {Promise<DoctorCheck>} Whether the release directory exists.
 */
async function releasePathCheck(releasePath) {
  if (await isDirectory(releasePath)) {
    return {detail: `${releasePath} exists`, name: "release path", ok: true}
  }

  return {detail: `${releasePath} is missing or not a directory`, name: "release path", ok: false}
}

/**
 * @param {ProcessRender[]} renders - Per-process render results.
 * @returns {DoctorCheck} Whether every process's templates resolved against the release context.
 */
function templateCheck(renders) {
  const failures = renders.flatMap((render) => (render.ok ? [] : [`${render.id}: ${render.error}`]))

  if (failures.length === 0) {
    return {detail: `all ${renders.length} process command/cwd/env templates resolve`, name: "process templates", ok: true}
  }

  return {detail: `unresolved templates — ${failures.join("; ")}`, name: "process templates", ok: false}
}

/**
 * @param {ProcessRender[]} renders - Per-process render results.
 * @returns {Promise<DoctorCheck>} Whether each rendered working directory exists.
 */
async function workingDirectoryCheck(renders) {
  /** @type {string[]} */
  const missing = []
  let checked = 0

  for (const render of renders) {
    if (!render.ok) continue

    checked++

    if (!(await isDirectory(render.cwd))) missing.push(`${render.id} (${render.cwd})`)
  }

  if (missing.length === 0) {
    return {detail: `all ${checked} process working ${checked === 1 ? "directory exists" : "directories exist"}`, name: "process working directories", ok: true}
  }

  return {detail: `missing working ${missing.length === 1 ? "directory" : "directories"}: ${missing.join(", ")}`, name: "process working directories", ok: false}
}

/**
 * @param {string} target - Path to test.
 * @returns {Promise<boolean>} True when the path exists and is a directory.
 */
async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}
