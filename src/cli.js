// @ts-check

import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"
import {spawn} from "node:child_process"
import {Command} from "commander"
import RollbridgeDaemon from "./daemon.js"
import {loadConfig, parseConfigFile, resolveConfigPath, validateConfig} from "./config.js"
import {runEnvironmentChecks} from "./doctor.js"
import {sendControlCommand} from "./control-client.js"

const DEFAULT_DAEMON_START_TIMEOUT_MS = 10000

/**
 * Runs the CLI.
 * @param {string[]} argv - Process argv.
 * @returns {Promise<void>} Resolves when complete.
 */
export async function runCli(argv) {
  const program = new Command()

  program
    .name("rollbridge")
    .description("Zero-downtime process supervisor and local traffic switcher.")
    .showHelpAfterError()

  program
    .command("daemon")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .action(async (options) => {
      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const daemon = new RollbridgeDaemon({config})

      await daemon.start()

      const shutdown = async () => {
        await daemon.shutdown()
        process.exit(0)
      }

      process.once("SIGINT", () => { void shutdown() })
      process.once("SIGTERM", () => { void shutdown() })
    })

  program
    .command("deploy")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .requiredOption("--release-path <path>", "Release path")
    .option("--release-id <id>", "Release id")
    .option("--revision <sha>", "Revision")
    .option("--ensure-daemon", "Start the Rollbridge daemon if it is not already running")
    .option("--daemon-log-path <path>", "Log path used when --ensure-daemon starts the daemon")
    .option("--daemon-pid-path <path>", "PID file path used when --ensure-daemon starts the daemon")
    .option("--daemon-start-timeout-ms <ms>", "How long to wait for an ensured daemon to accept control commands")
    .action(async (options) => {
      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)

      if (options.ensureDaemon) {
        await ensureDaemonRunning({
          argv,
          config,
          configPath,
          logPath: options.daemonLogPath,
          pidPath: options.daemonPidPath,
          timeoutMs: normalizeTimeoutMs(options.daemonStartTimeoutMs)
        })
      }

      const response = await sendControlCommand({
        command: {
          command: "deploy",
          releaseId: options.releaseId,
          releasePath: options.releasePath,
          revision: options.revision
        },
        path: config.control.path
      })

      console.log(JSON.stringify(response, null, 2))
    })

  program
    .command("ensure-daemon")
    .description("Start the daemon if the control socket is not already accepting commands.")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .option("--daemon-log-path <path>", "Daemon log path")
    .option("--daemon-pid-path <path>", "Daemon PID file path")
    .option("--daemon-start-timeout-ms <ms>", "How long to wait for the daemon to accept control commands")
    .action(async (options) => {
      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const response = await ensureDaemonRunning({
        argv,
        config,
        configPath,
        logPath: options.daemonLogPath,
        pidPath: options.daemonPidPath,
        timeoutMs: normalizeTimeoutMs(options.daemonStartTimeoutMs)
      })

      console.log(JSON.stringify(response, null, 2))
    })

  program
    .command("status")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .action(async (options) => {
      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const response = await sendControlCommand({
        command: {command: "status"},
        path: config.control.path
      })

      console.log(JSON.stringify(response, null, 2))
    })

  program
    .command("stop")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .option("--release-id <id>", "Release id")
    .action(async (options) => {
      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const response = await sendControlCommand({
        command: {
          command: "stop",
          releaseId: options.releaseId
        },
        path: config.control.path
      })

      console.log(JSON.stringify(response, null, 2))
    })

  program
    .command("shutdown")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .action(async (options) => {
      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const response = await sendControlCommand({
        command: {command: "shutdown"},
        path: config.control.path
      })

      console.log(JSON.stringify(response, null, 2))
    })

  program
    .command("validate")
    .description("Parse the config and report all errors without starting the daemon.")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .action(async (options) => {
      let configPath

      try {
        configPath = await resolveConfigPath(options.config)
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
        return
      }

      const {config, issues} = await validateConfigFile(configPath)

      if (issues.length === 0) {
        const processCount = config.processes.length

        console.log(`${configPath} is valid: ${processCount} ${processCount === 1 ? "process" : "processes"}, proxy on ${config.proxy.host}:${config.proxy.port}.`)
        return
      }

      console.error(`Found ${issues.length} configuration ${issues.length === 1 ? "issue" : "issues"} in ${configPath}:`)

      issues.forEach((issue, index) => {
        console.error(`\n${index + 1}. ${issue.message}`)
        console.error(`   Fix: ${issue.fix}`)
      })

      process.exitCode = 1
    })

  program
    .command("doctor")
    .description("Check the environment before starting the daemon: config, control socket, and proxy port.")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .action(async (options) => {
      let configPath

      try {
        configPath = await resolveConfigPath(options.config)
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
        return
      }

      const {config, issues} = await validateConfigFile(configPath)
      /** @type {import("./doctor.js").DoctorCheck[]} */
      const checks = []

      if (issues.length > 0) {
        checks.push({detail: `${issues.length} ${issues.length === 1 ? "issue" : "issues"} — run "rollbridge validate" for details`, name: "config", ok: false})
      } else {
        checks.push({detail: `valid: ${config.processes.length} ${config.processes.length === 1 ? "process" : "processes"}, proxy on ${config.proxy.host}:${config.proxy.port}`, name: "config", ok: true})
        checks.push(...await runEnvironmentChecks(config))
      }

      for (const check of checks) {
        console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`)
      }

      const failed = checks.filter((check) => !check.ok).length

      if (failed > 0) {
        console.error(`\n${failed} check${failed === 1 ? "" : "s"} failed.`)
        process.exitCode = 1
        return
      }

      console.log("\nAll checks passed.")
    })

  program
    .command("logs")
    .description("Print recent stdout/stderr captured from managed processes.")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .option("--process <id>", "Only show logs for the process with this id")
    .action(async (options) => {
      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const response = await sendControlCommand({
        command: {command: "status"},
        path: config.control.path
      })
      const sources = collectLogSources(/** @type {import("./daemon.js").DaemonStatus} */ (response))

      console.log(formatLogSources(sources, options.process))
    })

  await program.parseAsync(argv)
}

/**
 * @typedef {{id: string, logs: import("./managed-process.js").ManagedProcessLog[], source: string}} LogSource
 */

/**
 * Flattens managed-process logs from a daemon status payload, labelling each process by origin.
 * @param {import("./daemon.js").DaemonStatus} status - Daemon status payload.
 * @returns {LogSource[]} One entry per managed process.
 */
function collectLogSources(status) {
  /** @type {LogSource[]} */
  const sources = []

  for (const release of status.releases) {
    for (const processStatus of release.processes) {
      sources.push({id: processStatus.id, logs: processStatus.logs, source: `release ${release.releaseId} (${release.state})`})
    }
  }

  for (const service of status.services) {
    sources.push({id: service.process.id, logs: service.process.logs, source: "service"})
  }

  for (const singleton of status.singletons) {
    sources.push({id: singleton.process.id, logs: singleton.process.logs, source: "singleton"})
  }

  return sources
}

/**
 * Formats collected log sources for display, optionally filtered to a single process id.
 * @param {LogSource[]} sources - Collected log sources.
 * @param {string | undefined} processFilter - Only include the process with this id when set.
 * @returns {string} Human-readable log output.
 */
export function formatLogSources(sources, processFilter) {
  const matched = processFilter === undefined ? sources : sources.filter((source) => source.id === processFilter)

  if (matched.length === 0) {
    return processFilter === undefined ? "No managed processes." : `No process found with id "${processFilter}".`
  }

  return matched
    .map((source) => {
      const header = `== ${source.id} [${source.source}] ==`

      if (source.logs.length === 0) return `${header}\n  (no recent output)`

      return `${header}\n${source.logs.map((log) => `  ${log.at} [${log.stream}] ${log.line}`).join("\n")}`
    })
    .join("\n\n")
}

/**
 * Reads, parses, and validates a config file, collecting read, parse, and validation issues.
 * @param {string} configPath - Config file path.
 * @returns {Promise<{config: import("./config.js").RollbridgeConfig, issues: import("./config.js").ConfigIssue[]}>} Best-effort config and any issues.
 */
async function validateConfigFile(configPath) {
  try {
    const {absolutePath, rawConfig} = await parseConfigFile(configPath)

    return validateConfig(rawConfig, absolutePath)
  } catch (error) {
    const {config} = validateConfig({}, configPath)
    const message = error instanceof Error ? error.message : String(error)

    return {config, issues: [{fix: "Ensure the file exists and exports a default Rollbridge config object.", message}]}
  }
}

/**
 * Starts a daemon when needed and waits until it accepts status commands.
 * @param {object} args - Options.
 * @param {string[]} args.argv - Original CLI argv.
 * @param {import("./config.js").RollbridgeConfig} args.config - Loaded config.
 * @param {string} args.configPath - Config path.
 * @param {string | undefined} args.logPath - Optional daemon log path.
 * @param {string | undefined} args.pidPath - Optional daemon PID path.
 * @param {number} args.timeoutMs - Startup timeout.
 * @returns {Promise<Record<string, import("./json.js").JsonValue>>} Daemon status response.
 */
async function ensureDaemonRunning({argv, config, configPath, logPath, pidPath, timeoutMs}) {
  const existingStatus = await daemonStatus(config)

  if (existingStatus) return existingStatus

  await startDaemonProcess({
    argv,
    configPath,
    logPath: logPath || defaultDaemonLogPath(config),
    pidPath: pidPath || defaultDaemonPidPath(config)
  })

  return await waitForDaemonStatus(config, timeoutMs)
}

/**
 * @param {import("./config.js").RollbridgeConfig} config - Loaded config.
 * @returns {Promise<Record<string, import("./json.js").JsonValue> | undefined>} Status when the daemon responds.
 */
async function daemonStatus(config) {
  try {
    return await sendControlCommand({
      command: {command: "status"},
      path: config.control.path
    })
  } catch (error) {
    const errorWithCode = error && typeof error === "object"
      ? /** @type {{code?: string}} */ (error)
      : undefined

    if (isMissingDaemonError(errorWithCode)) return undefined

    throw error
  }
}

/**
 * Starts the foreground daemon command as a detached child.
 * @param {object} args - Options.
 * @param {string[]} args.argv - Original CLI argv.
 * @param {string} args.configPath - Config path.
 * @param {string} args.logPath - Log file path.
 * @param {string} args.pidPath - PID file path.
 * @returns {Promise<void>} Resolves after the child has been spawned.
 */
async function startDaemonProcess({argv, configPath, logPath, pidPath}) {
  const binPath = argv[1] || process.argv[1]

  if (!binPath) throw new Error("Unable to determine Rollbridge CLI path for daemon startup")

  await fsPromises.mkdir(path.dirname(logPath), {recursive: true})
  await fsPromises.mkdir(path.dirname(pidPath), {recursive: true})

  const stdoutFd = fs.openSync(logPath, "a")
  const stderrFd = fs.openSync(logPath, "a")

  try {
    const child = spawn(process.execPath, [binPath, "daemon", "--config", configPath], {
      detached: true,
      env: process.env,
      stdio: ["ignore", stdoutFd, stderrFd]
    })

    child.unref()

    if (child.pid) {
      await fsPromises.writeFile(pidPath, `${child.pid}\n`)
    }
  } finally {
    fs.closeSync(stdoutFd)
    fs.closeSync(stderrFd)
  }
}

/**
 * Waits until a daemon answers status commands.
 * @param {import("./config.js").RollbridgeConfig} config - Loaded config.
 * @param {number} timeoutMs - Timeout in milliseconds.
 * @returns {Promise<Record<string, import("./json.js").JsonValue>>} Daemon status response.
 */
async function waitForDaemonStatus(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = /** @type {Error | undefined} */ (undefined)

  while (Date.now() < deadline) {
    try {
      const status = await daemonStatus(config)

      if (status) return status
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const detail = lastError ? ` Last error: ${lastError.message}` : ""

  throw new Error(`Rollbridge daemon did not become ready within ${timeoutMs}ms.${detail}`)
}

/**
 * @param {import("./config.js").RollbridgeConfig} config - Loaded config.
 * @returns {string} Default daemon log path.
 */
function defaultDaemonLogPath(config) {
  return `/tmp/rollbridge-${config.application}.log`
}

/**
 * @param {import("./config.js").RollbridgeConfig} config - Loaded config.
 * @returns {string} Default daemon PID path.
 */
function defaultDaemonPidPath(config) {
  return `/tmp/rollbridge-${config.application}.pid`
}

/**
 * @param {string | undefined} value - Raw timeout value.
 * @returns {number} Timeout in milliseconds.
 */
function normalizeTimeoutMs(value) {
  if (value === undefined) return DEFAULT_DAEMON_START_TIMEOUT_MS

  const timeoutMs = Number(value)

  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("--daemon-start-timeout-ms must be a positive number")
  }

  return timeoutMs
}

/**
 * @param {{code?: string} | Error | null | undefined} error - Error value.
 * @returns {boolean} True when the error means no daemon is accepting commands.
 */
function isMissingDaemonError(error) {
  if (!error || typeof error !== "object" || !("code" in error)) return false

  return error.code === "ENOENT" || error.code === "ECONNREFUSED"
}
