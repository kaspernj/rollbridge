// @ts-check

import {Command} from "commander"
import RollbridgeDaemon from "./daemon.js"
import {loadConfig, parseConfigFile, validateConfig} from "./config.js"
import {sendControlCommand} from "./control-client.js"

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
    .requiredOption("-c, --config <path>", "Config file path")
    .action(async (options) => {
      const config = await loadConfig(options.config)
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
    .requiredOption("-c, --config <path>", "Config file path")
    .requiredOption("--release-path <path>", "Release path")
    .option("--release-id <id>", "Release id")
    .option("--revision <sha>", "Revision")
    .action(async (options) => {
      const config = await loadConfig(options.config)
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
    .command("status")
    .requiredOption("-c, --config <path>", "Config file path")
    .action(async (options) => {
      const config = await loadConfig(options.config)
      const response = await sendControlCommand({
        command: {command: "status"},
        path: config.control.path
      })

      console.log(JSON.stringify(response, null, 2))
    })

  program
    .command("stop")
    .requiredOption("-c, --config <path>", "Config file path")
    .option("--release-id <id>", "Release id")
    .action(async (options) => {
      const config = await loadConfig(options.config)
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
    .requiredOption("-c, --config <path>", "Config file path")
    .action(async (options) => {
      const config = await loadConfig(options.config)
      const response = await sendControlCommand({
        command: {command: "shutdown"},
        path: config.control.path
      })

      console.log(JSON.stringify(response, null, 2))
    })

  program
    .command("validate")
    .description("Parse the config and report all errors without starting the daemon.")
    .requiredOption("-c, --config <path>", "Config file path")
    .action(async (options) => {
      const {config, issues} = await validateConfigFile(options.config)

      if (issues.length === 0) {
        const processCount = config.processes.length

        console.log(`${options.config} is valid: ${processCount} ${processCount === 1 ? "process" : "processes"}, proxy on ${config.proxy.host}:${config.proxy.port}.`)
        return
      }

      console.error(`Found ${issues.length} configuration ${issues.length === 1 ? "issue" : "issues"} in ${options.config}:`)

      issues.forEach((issue, index) => {
        console.error(`\n${index + 1}. ${issue.message}`)
        console.error(`   Fix: ${issue.fix}`)
      })

      process.exitCode = 1
    })

  await program.parseAsync(argv)
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

    return {config, issues: [{fix: "Ensure the file exists and contains valid YAML or JSON.", message}]}
  }
}
