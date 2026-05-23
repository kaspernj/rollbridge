// @ts-check

import {constants as fsConstants} from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import {inspectControlSocket} from "./daemon.js"
import {liveProcesses, readState} from "./state-store.js"

/**
 * @typedef {{detail: string, name: string, ok: boolean}} DoctorCheck
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
  checks.push(await proxyPortCheck(config))

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
 * @returns {Promise<DoctorCheck>} Whether the proxy port can be bound.
 */
async function proxyPortCheck(config) {
  const address = `${config.proxy.host}:${config.proxy.port}`
  const bind = await canBindPort(config.proxy.host, config.proxy.port)

  if (bind.ok) {
    return {detail: `${address} is available`, name: "proxy port", ok: true}
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
