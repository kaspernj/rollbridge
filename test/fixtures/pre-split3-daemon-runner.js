// @ts-check

import {loadConfig} from "../../src/config.js"
import {currentPackageIdentity} from "../../src/daemon-runtime.js"
import RollbridgeDaemon from "./pre-split3-daemon.js"

const [command, configFlag, configPath] = process.argv.slice(2)

if (command !== "daemon" || configFlag !== "--config" || !configPath) throw new Error("pre-split3-daemon-runner requires daemon --config <path>")

const daemon = new RollbridgeDaemon({
  config: await loadConfig(configPath),
  configPath,
  runtime: await currentPackageIdentity()
})

await daemon.start()

const shutdown = async () => {
  try {
    await daemon.shutdown()
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

process.once("SIGINT", () => { void shutdown() })
process.once("SIGTERM", () => { void shutdown() })
