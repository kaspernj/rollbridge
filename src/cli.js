// @ts-check

import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"
import {spawn} from "node:child_process"
import {Command} from "commander"
import RollbridgeDaemon from "./daemon.js"
import {loadConfig, parseConfigFile, resolveConfigPath, validateConfig} from "./config.js"
import {runEnvironmentChecks} from "./doctor.js"
import {recoverOrphans} from "./recover.js"
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
    .command("rollback")
    .description("Roll back to a previous release: re-start it, health-check it, and switch traffic.")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .option("--release-id <id>", "Release id to roll back to (defaults to the most recently retired release)")
    .action(async (options) => {
      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const response = await sendControlCommand({
        command: {
          command: "rollback",
          releaseId: options.releaseId
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
    .command("restart")
    .description("Restart running non-proxied processes (by id, by policy, or all).")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .option("--process <id>", "Restart only the process with this id")
    .option("--policy <policy>", "Restart only processes with this policy (companion, singleton, or service)")
    .action(async (options) => {
      if (options.policy !== undefined && !["companion", "service", "singleton"].includes(options.policy)) {
        console.error("--policy must be one of: companion, singleton, service.")
        process.exitCode = 1
        return
      }

      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const response = await sendControlCommand({
        command: {
          command: "restart",
          policy: options.policy,
          processId: options.process
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
    .option("--json", "Output machine-readable JSON")
    .action(async (options) => {
      let configPath

      try {
        configPath = await resolveConfigPath(options.config)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (options.json) console.log(JSON.stringify({config: null, issues: [{fix: "Pass --config or add a rollbridge.js.", message}], path: null, valid: false}, null, 2))
        else console.error(message)
        process.exitCode = 1
        return
      }

      const {config, issues} = await validateConfigFile(configPath)
      const valid = issues.length === 0

      if (options.json) {
        const summary = valid ? {application: config.application, processes: config.processes.length, proxy: {host: config.proxy.host, port: config.proxy.port}} : null

        console.log(JSON.stringify({config: summary, issues, path: configPath, valid}, null, 2))
        if (!valid) process.exitCode = 1
        return
      }

      if (valid) {
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
    .option("--json", "Output machine-readable JSON")
    .action(async (options) => {
      let configPath

      try {
        configPath = await resolveConfigPath(options.config)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (options.json) console.log(JSON.stringify({checks: [{detail: message, name: "config", ok: false}], ok: false}, null, 2))
        else console.error(message)
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

      const failed = checks.filter((check) => !check.ok).length

      if (options.json) {
        console.log(JSON.stringify({checks, ok: failed === 0}, null, 2))
      } else {
        for (const check of checks) {
          console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`)
        }

        if (failed === 0) console.log("\nAll checks passed.")
        else console.error(`\n${failed} check${failed === 1 ? "" : "s"} failed.`)
      }

      if (failed > 0) process.exitCode = 1
    })

  program
    .command("logs")
    .description("Print recent stdout/stderr captured from managed processes.")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .option("--process <id>", "Only show logs for the process with this id")
    .option("--json", "Output machine-readable JSON")
    .action(async (options) => {
      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const response = await sendControlCommand({
        command: {command: "status"},
        path: config.control.path
      })
      const sources = collectLogSources(/** @type {import("./daemon.js").DaemonStatus} */ (response))

      if (options.json) {
        const filtered = options.process === undefined ? sources : sources.filter((source) => source.id === options.process)

        console.log(JSON.stringify(filtered, null, 2))
        return
      }

      console.log(formatLogSources(sources, options.process))
    })

  program
    .command("events")
    .description("Print recent structured daemon events (deploys, switches, stops, crashes, restarts, failures).")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .option("--limit <count>", "Show only the most recent <count> events")
    .option("--json", "Output machine-readable JSON")
    .action(async (options) => {
      let limit

      if (options.limit !== undefined) {
        limit = Number(options.limit)

        if (!Number.isInteger(limit) || limit < 1) {
          console.error("--limit must be a positive integer.")
          process.exitCode = 1
          return
        }
      }

      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const response = await sendControlCommand({
        command: {command: "events", limit},
        path: config.control.path
      })
      const events = /** @type {import("./event-log.js").DaemonEvent[]} */ (response.events ?? [])

      if (options.json) {
        console.log(JSON.stringify(events, null, 2))
        return
      }

      console.log(formatEvents(events))
    })

  program
    .command("recover")
    .description("Stop orphaned processes left by a crashed daemon (reads statePath; lists them unless --force).")
    .option("-c, --config <path>", "Config file path (defaults to rollbridge.js)")
    .option("--force", "Stop the orphaned processes; without it, recover only lists them")
    .action(async (options) => {
      const configPath = await resolveConfigPath(options.config)
      const config = await loadConfig(configPath)
      const result = await recoverOrphans({config, force: Boolean(options.force)})

      if ("error" in result) {
        console.error(result.error)
        process.exitCode = 1
        return
      }

      console.log(formatRecoverResult(result))
    })

  program
    .command("completion")
    .description("Print a shell completion script. Enable with: source <(rollbridge completion <shell>)")
    .argument("<shell>", "Shell to generate completion for (bash or zsh)")
    .action((shell) => {
      if (shell !== "bash" && shell !== "zsh") {
        console.error(`Unsupported shell "${shell}". Supported shells: bash, zsh.`)
        process.exitCode = 1
        return
      }

      console.log(generateCompletionScript(program, shell))
    })

  await program.parseAsync(argv)
}

/**
 * Formats the result of a recover run.
 * @param {{orphans: {id: string, pid: number, releaseId: string | null}[], stopped: boolean}} result - Recover result.
 * @returns {string} Human-readable summary.
 */
export function formatRecoverResult(result) {
  if (result.orphans.length === 0) {
    return result.stopped ? "No orphaned processes found; cleared the state file." : "No orphaned processes found."
  }

  const lines = result.orphans.map((orphan) => `  ${orphan.id} (pid ${orphan.pid}${orphan.releaseId ? `, release ${orphan.releaseId}` : ""})`)

  if (result.stopped) {
    return [`Stopped ${result.orphans.length} orphaned process${result.orphans.length === 1 ? "" : "es"}:`, ...lines].join("\n")
  }

  return [
    `Found ${result.orphans.length} orphaned process${result.orphans.length === 1 ? "" : "es"} (run with --force to stop):`,
    ...lines,
    "Review the list first — a recycled pid could be an unrelated process."
  ].join("\n")
}

/**
 * @typedef {{name: string, options: string[], valueOptions: string[]}} CompletionCommand
 */

/**
 * Builds a shell completion script by introspecting the CLI's commands and options,
 * so completions never drift from the actual command surface.
 * @param {import("commander").Command} program - Configured CLI program.
 * @param {"bash" | "zsh"} shell - Target shell.
 * @returns {string} A sourceable completion script.
 */
export function generateCompletionScript(program, shell) {
  const commands = describeCommands(program)

  return shell === "zsh" ? zshCompletionScript(commands) : bashCompletionScript(commands)
}

/**
 * @param {import("commander").Command} program - Configured CLI program.
 * @returns {CompletionCommand[]} Each command's name, long option flags, and value-taking option flags.
 */
function describeCommands(program) {
  return program.commands.map((command) => {
    /** @type {string[]} */
    const options = []
    /** @type {string[]} */
    const valueOptions = []

    for (const option of command.options) {
      if (!option.long) continue

      options.push(option.long)
      if (option.required || option.optional) valueOptions.push(option.long)
    }

    return {name: command.name(), options, valueOptions}
  })
}

/**
 * @param {CompletionCommand[]} commands - Command descriptors.
 * @returns {string} A bash completion script.
 */
function bashCompletionScript(commands) {
  const names = commands.map((command) => command.name).join(" ")
  const branches = commands
    .map((command) => `    ${command.name})\n      opts="${command.options.join(" ")}"\n      values="${command.valueOptions.join(" ")}"\n      ;;`)
    .join("\n")

  return `# rollbridge bash completion
# Enable with: source <(rollbridge completion bash)
_rollbridge() {
  local cur prev cmd opts values i
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  cmd=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    case "\${COMP_WORDS[i]}" in
      -*) ;;
      *) cmd="\${COMP_WORDS[i]}"; break ;;
    esac
  done

  if [[ -z "$cmd" ]]; then
    COMPREPLY=( $(compgen -W "${names}" -- "$cur") )
    return
  fi

  opts=""
  values=""
  case "$cmd" in
${branches}
  esac

  if [[ -n "$values" && " $values " == *" $prev "* ]]; then
    COMPREPLY=( $(compgen -f -- "$cur") )
    return
  fi

  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _rollbridge rollbridge
`
}

/**
 * @param {CompletionCommand[]} commands - Command descriptors.
 * @returns {string} A zsh completion script.
 */
function zshCompletionScript(commands) {
  const names = commands.map((command) => command.name).join(" ")
  const branches = commands
    .map((command) => `    ${command.name}) compadd -- ${command.options.join(" ")} ;;`)
    .join("\n")

  return `#compdef rollbridge
# rollbridge zsh completion
# Enable with: source <(rollbridge completion zsh)
_rollbridge() {
  local -a commands
  commands=(${names})

  if (( CURRENT == 2 )); then
    compadd -- $commands
    return
  fi

  case "\${words[2]}" in
${branches}
  esac
}
compdef _rollbridge rollbridge
`
}

/**
 * Formats structured daemon events as human-readable lines.
 * @param {import("./event-log.js").DaemonEvent[]} events - Recent events, oldest first.
 * @returns {string} One line per event, or a placeholder when empty.
 */
export function formatEvents(events) {
  if (events.length === 0) return "No events recorded yet."

  return events
    .map((event) => {
      const data = Object.keys(event.data).length > 0 ? ` ${JSON.stringify(event.data)}` : ""

      return `${event.at}  ${event.message}${data}`
    })
    .join("\n")
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
