// @ts-check

import {spawnSync} from "node:child_process"
import {setTimeout as sleep} from "node:timers/promises"
import {inspectControlSocket} from "./daemon.js"
import {recoverOrphans} from "./recover.js"
import {sendControlCommand} from "./control-client.js"

/**
 * @typedef {{pid: number, parentPid: number, args: string}} ProcessRow
 * @typedef {{action: string, legacyProcesses: ProcessRow[], recoveredOrphans: number}} PredeployCleanupResult
 */

/**
 * Prepares a host for a Rollbridge deploy by handling the two cases that can block a fresh
 * daemon startup: orphaned Rollbridge-managed pids from a crashed daemon, and explicitly
 * configured legacy processes from the pre-Rollbridge supervisor.
 * @param {object} args - Options.
 * @param {import("./config.js").RollbridgeConfig} args.config - Rollbridge config.
 * @param {(socketPath: string) => Promise<import("./daemon.js").ControlSocketInspection>} [args.inspectSocket] - Control socket probe.
 * @param {(command: string, args: string[]) => import("node:child_process").SpawnSyncReturns<Buffer>} [args.runCommand] - Command runner.
 * @param {(pid: number, signal: string) => void} [args.killProcess] - Signal sender.
 * @param {(args: {config: import("./config.js").RollbridgeConfig, force: boolean}) => Promise<import("./recover.js").RecoverResult>} [args.recover] - Orphan recovery function.
 * @returns {Promise<PredeployCleanupResult>} Cleanup result.
 */
export async function predeployCleanup({
  config,
  inspectSocket = inspectControlSocket,
  killProcess = process.kill,
  recover = recoverOrphans,
  runCommand = spawnSync
}) {
  const inspection = await inspectSocket(config.control.path)

  if (inspection.alive) {
    if (inspection.application === undefined) {
      throw new Error(`A non-Rollbridge process is using ${config.control.path}; refusing predeploy cleanup.`)
    }

    if (inspection.application !== config.application) {
      throw new Error(`A Rollbridge daemon for "${inspection.application}" is using ${config.control.path}; expected "${config.application}".`)
    }

    if (inspection.activeReleaseId) {
      return {action: "daemon-active", legacyProcesses: [], recoveredOrphans: 0}
    }

    await sendControlCommand({command: {command: "shutdown"}, path: config.control.path})
  }

  const recoveredOrphans = await recoverConfiguredOrphans(config, recover)
  const legacyProcesses = await stopLegacyProcesses({config, killProcess, runCommand})

  return {
    action: inspection.alive ? "daemon-without-active-release-stopped" : "no-daemon-cleaned",
    legacyProcesses,
    recoveredOrphans
  }
}

/**
 * @param {import("./config.js").RollbridgeConfig} config - Rollbridge config.
 * @param {(args: {config: import("./config.js").RollbridgeConfig, force: boolean}) => Promise<import("./recover.js").RecoverResult>} recover - Orphan recovery function.
 * @returns {Promise<number>} Number of orphans found.
 */
async function recoverConfiguredOrphans(config, recover) {
  if (config.statePath === undefined) return 0

  const result = await recover({config, force: true})

  if ("error" in result) {
    throw new Error(result.error)
  }

  if (result.remaining.length > 0) {
    throw new Error(`Could not stop ${result.remaining.length} Rollbridge orphaned process${result.remaining.length === 1 ? "" : "es"}.`)
  }

  return result.orphans.length
}

/**
 * @param {object} args - Options.
 * @param {import("./config.js").RollbridgeConfig} args.config - Rollbridge config.
 * @param {(command: string, args: string[]) => import("node:child_process").SpawnSyncReturns<Buffer>} args.runCommand - Command runner.
 * @param {(pid: number, signal: string) => void} args.killProcess - Signal sender.
 * @returns {Promise<ProcessRow[]>} Stopped legacy processes.
 */
async function stopLegacyProcesses({config, killProcess, runCommand}) {
  const takeoverConfig = config.legacyTakeover
  if (takeoverConfig === undefined) return []

  for (const screenName of takeoverConfig.screens) {
    runCommand("screen", ["-S", screenName, "-X", "quit"])
  }

  const stoppedProcesses = await stopProcessTree({
    killProcess,
    processRows: legacyProcesses(config),
    timeoutMs: takeoverConfig.forceStopTimeoutMs
  })
  const remainingProcesses = legacyProcesses(config)

  if (remainingProcesses.length > 0) {
    const details = remainingProcesses.map((row) => `${row.pid} ${row.args}`).join("\n")

    throw new Error(`Refusing Rollbridge deploy while legacy processes are still running:\n${details}`)
  }

  return stoppedProcesses
}

/**
 * @param {import("./config.js").RollbridgeConfig} config - Rollbridge config.
 * @returns {ProcessRow[]} Legacy process rows and their descendants.
 */
function legacyProcesses(config) {
  const rows = processRows()
  const legacyPids = new Set(rows.filter((row) => legacySeedProcess(row, config)).map((row) => row.pid))
  let changed = true

  while (changed) {
    changed = false

    for (const row of rows) {
      if (!legacyPids.has(row.pid) && legacyPids.has(row.parentPid)) {
        legacyPids.add(row.pid)
        changed = true
      }
    }
  }

  return rows.filter((row) => legacyPids.has(row.pid))
}

/**
 * @param {ProcessRow} row - Process row.
 * @param {import("./config.js").RollbridgeConfig} config - Rollbridge config.
 * @returns {boolean} True when the row identifies a configured legacy process.
 */
function legacySeedProcess(row, config) {
  const takeoverConfig = config.legacyTakeover
  if (takeoverConfig === undefined || row.args.includes("rollbridge")) return false

  if (takeoverConfig.screens.some((screenName) => row.args.includes(`SCREEN -dmS ${screenName}`))) {
    return true
  }

  return takeoverConfig.processes.some((processConfig) => (
    processConfig.includes.every((matcher) => row.args.includes(matcher))
  ))
}

/** @returns {ProcessRow[]} Current process table rows. */
function processRows() {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,args="], {encoding: "utf8"})

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Failed to inspect running processes: ${result.stderr}`)

  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) return []

    const pid = Number(match[1])
    const parentPid = Number(match[2])
    if (pid === process.pid || pid === process.ppid) return []

    return [{args: match[3], parentPid, pid}]
  })
}

/**
 * @param {object} args - Options.
 * @param {(pid: number, signal: string) => void} args.killProcess - Signal sender.
 * @param {ProcessRow[]} args.processRows - Processes to stop.
 * @param {number} args.timeoutMs - Grace period before SIGKILL.
 * @returns {Promise<ProcessRow[]>} Processes that were signaled.
 */
async function stopProcessTree({killProcess, processRows, timeoutMs}) {
  /** @type {ProcessRow[]} */
  const stoppedProcesses = []

  for (const row of processRows) {
    if (sendSignal(row.pid, "SIGTERM", killProcess)) stoppedProcesses.push(row)
  }

  if (stoppedProcesses.length === 0) return []

  await sleep(timeoutMs)

  for (const row of processRows) {
    sendSignal(row.pid, "SIGKILL", killProcess)
  }

  return stoppedProcesses
}

/**
 * @param {number} pid - Process id.
 * @param {string} signal - Signal name.
 * @param {(pid: number, signal: string) => void} killProcess - Signal sender.
 * @returns {boolean} True when the signal was sent, false when the process was already gone.
 */
function sendSignal(pid, signal, killProcess) {
  try {
    killProcess(pid, signal)

    return true
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false

    throw error
  }
}
