// @ts-check

import {Command} from "commander"
import RollgateDaemon from "./daemon.js"
import {loadConfig} from "./config.js"
import {sendControlCommand} from "./control-client.js"

/**
 * Runs the CLI.
 * @param {string[]} argv - Process argv.
 * @returns {Promise<void>} Resolves when complete.
 */
export async function runCli(argv) {
  const program = new Command()

  program
    .name("rollgate")
    .description("Zero-downtime process supervisor and local traffic switcher.")
    .showHelpAfterError()

  program
    .command("daemon")
    .requiredOption("-c, --config <path>", "Config file path")
    .action(async (options) => {
      const config = await loadConfig(options.config)
      const daemon = new RollgateDaemon({config})

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

  await program.parseAsync(argv)
}
