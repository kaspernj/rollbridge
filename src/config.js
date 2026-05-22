// @ts-check

import fs from "node:fs/promises"
import path from "node:path"
import {pathToFileURL} from "node:url"

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {{from: number, to: number}} PortRange
 * @typedef {{path: string, startDelayMs: number, timeoutMs: number, intervalMs: number}} HealthConfig
 * @typedef {"proxied" | "companion" | "singleton" | "service"} ProcessPolicy
 * @typedef {{cwd?: string, env: Record<string, string>, gracefulStopMs: number, health?: HealthConfig, id: string, outputLines: number, policy: ProcessPolicy, port?: PortRange, restartDelayMs: number, command: string}} ProcessConfig
 * @typedef {{mode?: number, path: string}} ControlConfig
 * @typedef {{drainTimeoutMs: number, forceStopTimeoutMs: number, healthPath: string, healthTimeoutMs: number, host: string, port: number}} ProxyConfig
 * @typedef {{keep: number, maxAgeMs: number}} ReleaseRetentionConfig
 * @typedef {{application: string, control: ControlConfig, processes: ProcessConfig[], proxy: ProxyConfig, releaseRetention: ReleaseRetentionConfig}} RollbridgeConfig
 * @typedef {{fix: string, message: string}} ConfigIssue
 */

const PROCESS_POLICIES = new Set(["proxied", "companion", "singleton", "service"])
const DEFAULT_CONFIG_FILENAMES = ["rollbridge.js"]

/**
 * Imports a JavaScript config module without validating it.
 *
 * The module must `export default` either a config object or a function (sync or
 * async) that returns one.
 * @param {string} configPath - Config path.
 * @returns {Promise<{absolutePath: string, rawConfig: JsonValue}>} Imported config.
 */
export async function parseConfigFile(configPath) {
  const absolutePath = path.resolve(configPath)
  const moduleNamespace = await import(pathToFileURL(absolutePath).href)
  const exported = moduleNamespace.default

  if (exported === undefined) {
    throw new Error(`Config module ${absolutePath} must export a default config object or function`)
  }

  const rawConfig = typeof exported === "function" ? await exported() : exported

  return {absolutePath, rawConfig}
}

/**
 * Loads a JavaScript config module.
 * @param {string} configPath - Config path.
 * @returns {Promise<RollbridgeConfig>} Normalized config.
 */
export async function loadConfig(configPath) {
  const {absolutePath, rawConfig} = await parseConfigFile(configPath)

  return normalizeConfig(rawConfig, absolutePath)
}

/**
 * Resolves the config path to use, falling back to a default lookup order when none is given.
 * @param {string | undefined} configPath - Explicit `--config` path, if provided.
 * @param {string} [cwd] - Directory to search for default config files.
 * @returns {Promise<string>} The explicit path, or the first existing default config file.
 */
export async function resolveConfigPath(configPath, cwd = process.cwd()) {
  if (configPath !== undefined) return configPath

  for (const filename of DEFAULT_CONFIG_FILENAMES) {
    const candidate = path.join(cwd, filename)

    if (await configFileExists(candidate)) return candidate
  }

  throw new Error(`No config file found in ${cwd}. Pass --config <path> or add one of: ${DEFAULT_CONFIG_FILENAMES.join(", ")}.`)
}

/**
 * @param {string} filePath - Candidate config file path.
 * @returns {Promise<boolean>} True when the path exists and is a regular file.
 */
async function configFileExists(filePath) {
  try {
    const stats = await fs.stat(filePath)

    return stats.isFile()
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false

    throw error
  }
}

/**
 * Normalizes a raw config object, throwing when validation fails.
 * @param {JsonValue} rawConfig - Parsed config.
 * @param {string} [configPath] - Source path.
 * @returns {RollbridgeConfig} Normalized config.
 */
export function normalizeConfig(rawConfig, configPath = process.cwd()) {
  const {config, issues} = validateConfig(rawConfig, configPath)

  if (issues.length > 0) {
    throw new Error(`Invalid Rollbridge config:\n${issues.map((issue) => `  - ${issue.message}`).join("\n")}`)
  }

  return config
}

/**
 * Validates a raw config object and collects every issue instead of throwing on the first one.
 * @param {JsonValue} rawConfig - Parsed config.
 * @param {string} [configPath] - Source path.
 * @returns {{config: RollbridgeConfig, issues: ConfigIssue[]}} Best-effort config and any issues.
 */
export function validateConfig(rawConfig, configPath = process.cwd()) {
  /** @type {ConfigIssue[]} */
  const issues = []
  const source = isPlainObject(rawConfig) ? rawConfig : /** @type {Record<string, JsonValue>} */ ({})

  if (!isPlainObject(rawConfig)) {
    issues.push({fix: "Export a default config object with application, proxy, and processes keys.", message: "Config must be an object"})
  }

  const application = normalizeString(source.application, "application", issues, {default: path.basename(path.dirname(configPath))})
  const proxySource = objectAt(source.proxy, "proxy", issues)
  const controlSource = objectAt(source.control, "control", issues, {})
  const processesSource = arrayAt(source.processes, "processes", issues)
  const proxy = normalizeProxy(proxySource, issues)
  const control = {
    mode: normalizeSocketMode(controlSource.mode, "control.mode", issues),
    path: normalizeString(controlSource.path, "control.path", issues, {default: `/tmp/rollbridge-${application}.sock`})
  }
  const processes = processesSource.map((processSource, index) => normalizeProcess(processSource, index, proxy, issues))
  const releaseRetention = normalizeReleaseRetention(objectAt(source.releaseRetention, "releaseRetention", issues, {}), issues)

  validateProcessSet(processes, issues)

  return {config: {application, control, processes, proxy, releaseRetention}, issues}
}

/**
 * @param {Record<string, JsonValue>} source - Raw proxy config.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {ProxyConfig} Normalized proxy config.
 */
function normalizeProxy(source, issues) {
  return {
    drainTimeoutMs: normalizeNumber(source.drainTimeoutMs, "proxy.drainTimeoutMs", issues, {default: 60000}),
    forceStopTimeoutMs: normalizeNumber(source.forceStopTimeoutMs, "proxy.forceStopTimeoutMs", issues, {default: 10000}),
    healthPath: normalizeString(source.healthPath, "proxy.healthPath", issues, {default: "/ping"}),
    healthTimeoutMs: normalizeNumber(source.healthTimeoutMs, "proxy.healthTimeoutMs", issues, {default: 30000}),
    host: normalizeString(source.host, "proxy.host", issues, {default: "127.0.0.1"}),
    port: normalizeNumber(source.port, "proxy.port", issues, {default: 8182})
  }
}

/**
 * @param {JsonValue} value - Raw process config.
 * @param {number} index - Process index.
 * @param {ProxyConfig} proxy - Proxy config defaults.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {ProcessConfig} Normalized process config.
 */
function normalizeProcess(value, index, proxy, issues) {
  if (!isPlainObject(value)) {
    issues.push({fix: `Define processes[${index}] as a mapping with id, policy, and command.`, message: `processes[${index}] must be an object`})

    return {command: "", cwd: undefined, env: {}, gracefulStopMs: proxy.forceStopTimeoutMs, health: undefined, id: "", outputLines: 50, policy: "companion", port: undefined, restartDelayMs: 1000}
  }

  const source = value

  return {
    command: normalizeString(source.command, `processes[${index}].command`, issues),
    cwd: source.cwd === undefined ? undefined : normalizeString(source.cwd, `processes[${index}].cwd`, issues),
    env: normalizeEnv(source.env, `processes[${index}].env`, issues),
    gracefulStopMs: normalizeNumber(source.gracefulStopMs, `processes[${index}].gracefulStopMs`, issues, {default: proxy.forceStopTimeoutMs}),
    health: normalizeHealth(source.health, `processes[${index}].health`, proxy, issues),
    id: normalizeString(source.id, `processes[${index}].id`, issues),
    outputLines: normalizeOutputLines(source.outputLines, `processes[${index}].outputLines`, issues),
    policy: normalizePolicy(source.policy, `processes[${index}].policy`, issues),
    port: normalizePortRange(source.port, `processes[${index}].port`, issues),
    restartDelayMs: normalizeNumber(source.restartDelayMs, `processes[${index}].restartDelayMs`, issues, {default: 1000})
  }
}

/**
 * @param {JsonValue} value - Raw output retention value.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {number} Recent output lines to retain and report (default 50).
 */
function normalizeOutputLines(value, key, issues) {
  const outputLines = normalizeNumber(value, key, issues, {default: 50})

  if (!Number.isInteger(outputLines) || outputLines < 1) {
    issues.push({fix: `Set ${key} to a positive integer number of lines, e.g. 50.`, message: `${key} must be a positive integer`})

    return 50
  }

  return outputLines
}

/**
 * @param {Record<string, JsonValue>} source - Raw release retention config.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {ReleaseRetentionConfig} Normalized release retention policy.
 */
function normalizeReleaseRetention(source, issues) {
  const keep = normalizeNumber(source.keep, "releaseRetention.keep", issues, {default: 10})
  const maxAgeMs = normalizeNumber(source.maxAgeMs, "releaseRetention.maxAgeMs", issues, {default: 0})

  return {
    keep: nonNegativeOrDefault(keep, "releaseRetention.keep", issues, 10, true),
    maxAgeMs: nonNegativeOrDefault(maxAgeMs, "releaseRetention.maxAgeMs", issues, 0, false)
  }
}

/**
 * @param {number} value - Already type-normalized number.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @param {number} fallback - Value to use when invalid.
 * @param {boolean} requireInteger - Whether the value must be an integer.
 * @returns {number} The value when non-negative (and integer when required), else the fallback.
 */
function nonNegativeOrDefault(value, key, issues, fallback, requireInteger) {
  if (value < 0 || (requireInteger && !Number.isInteger(value))) {
    issues.push({fix: `Set ${key} to a non-negative ${requireInteger ? "integer" : "number"}, e.g. ${fallback}.`, message: `${key} must be a non-negative ${requireInteger ? "integer" : "number"}`})

    return fallback
  }

  return value
}

/**
 * @param {JsonValue} value - Raw socket permission mode.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {number | undefined} File mode bits (0 to 0o777), or undefined when unset.
 */
function normalizeSocketMode(value, key, issues) {
  if (value === undefined || value === null) return undefined

  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value <= 0o777) return value
  } else if (typeof value === "string") {
    const cleaned = value.startsWith("0o") ? value.slice(2) : value
    const mode = /^[0-7]{1,4}$/.test(cleaned) ? parseInt(cleaned, 8) : Number.NaN

    if (Number.isInteger(mode) && mode >= 0 && mode <= 0o777) return mode
  }

  issues.push({fix: `Set ${key} to an octal permission string like "660" (or an octal number such as 0o660).`, message: `${key} must be an octal file mode between 0 and 0o777`})

  return undefined
}

/**
 * Validates cross-process rules: unique ids, exactly one proxied process, and proxied ports.
 * @param {ProcessConfig[]} processes - Normalized processes.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {void}
 */
function validateProcessSet(processes, issues) {
  const seenIds = /** @type {Set<string>} */ (new Set())

  for (const processConfig of processes) {
    if (!processConfig.id) continue

    if (seenIds.has(processConfig.id)) {
      issues.push({fix: `Give each process a unique id; "${processConfig.id}" is used more than once.`, message: `Duplicate process id: ${processConfig.id}`})
    }

    seenIds.add(processConfig.id)
  }

  const proxiedProcesses = processes.filter((processConfig) => processConfig.policy === "proxied")

  if (proxiedProcesses.length !== 1) {
    issues.push({fix: "Mark exactly one process with policy: proxied so Rollbridge knows where to forward traffic.", message: `Config must define exactly one proxied process; found ${proxiedProcesses.length}`})
  }

  for (const processConfig of proxiedProcesses) {
    if (processConfig.port) continue

    issues.push({fix: `Add a port range to the proxied process "${processConfig.id || "(unnamed)"}", e.g. port: {from: 18000, to: 18099}.`, message: `Proxied process ${processConfig.id || "(unnamed)"} must define a port range`})
  }
}

/**
 * @param {JsonValue} value - Raw policy.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {ProcessPolicy} Normalized policy.
 */
function normalizePolicy(value, key, issues) {
  const policy = normalizeString(value, key, issues, {default: "companion"})

  if (!PROCESS_POLICIES.has(policy)) {
    issues.push({fix: `Set ${key} to one of: ${[...PROCESS_POLICIES].join(", ")}.`, message: `${key} must be one of: ${[...PROCESS_POLICIES].join(", ")}`})

    return "companion"
  }

  return /** @type {ProcessPolicy} */ (policy)
}

/**
 * @param {JsonValue} value - Raw health config.
 * @param {string} key - Config key.
 * @param {ProxyConfig} proxy - Proxy defaults.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {HealthConfig | undefined} Normalized health config.
 */
function normalizeHealth(value, key, proxy, issues) {
  if (value === false || value === null) return undefined

  if (value !== undefined && !isPlainObject(value)) {
    issues.push({fix: `Set ${key} to a mapping with path, timeoutMs, and intervalMs, or false to disable.`, message: `${key} must be an object`})

    return undefined
  }

  const source = value === undefined ? /** @type {Record<string, JsonValue>} */ ({}) : value

  return {
    intervalMs: normalizeNumber(source.intervalMs, `${key}.intervalMs`, issues, {default: 250}),
    path: normalizeString(source.path, `${key}.path`, issues, {default: proxy.healthPath}),
    startDelayMs: normalizeStartDelayMs(source.startDelayMs, `${key}.startDelayMs`, issues),
    timeoutMs: normalizeNumber(source.timeoutMs, `${key}.timeoutMs`, issues, {default: proxy.healthTimeoutMs})
  }
}

/**
 * @param {JsonValue} value - Raw startup delay.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {number} Milliseconds to wait before the first health probe (default 0).
 */
function normalizeStartDelayMs(value, key, issues) {
  const startDelayMs = normalizeNumber(value, key, issues, {default: 0})

  if (startDelayMs < 0) {
    issues.push({fix: `Set ${key} to a non-negative number of milliseconds, e.g. 0 or 2000.`, message: `${key} must be a non-negative number`})

    return 0
  }

  return startDelayMs
}

/**
 * @param {JsonValue} value - Raw env config.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {Record<string, string>} Normalized env.
 */
function normalizeEnv(value, key, issues) {
  if (value === undefined || value === null) return {}

  if (!isPlainObject(value)) {
    issues.push({fix: `Set ${key} to a mapping of string environment values.`, message: `${key} must be an object`})

    return {}
  }

  /** @type {Record<string, string>} */
  const env = {}

  for (const [envKey, envValue] of Object.entries(value)) {
    env[envKey] = normalizeString(envValue, `${key}.${envKey}`, issues)
  }

  return env
}

/**
 * @param {JsonValue} value - Raw port range.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {PortRange | undefined} Normalized range.
 */
function normalizePortRange(value, key, issues) {
  if (value === undefined || value === null) return undefined

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      issues.push({fix: `Set ${key} to a positive port number or a {from, to} range.`, message: `${key} must be a positive port or valid {from, to} range`})

      return undefined
    }

    return {from: value, to: value}
  }

  if (!isPlainObject(value)) {
    issues.push({fix: `Set ${key} to a port number or {from, to} range.`, message: `${key} must be a positive port or valid {from, to} range`})

    return undefined
  }

  const from = normalizeNumber(value.from, `${key}.from`, issues, {default: 0})
  const to = normalizeNumber(value.to, `${key}.to`, issues, {default: from})

  if (from < 0 || to < 0 || to < from) {
    issues.push({fix: `Set ${key}.from and ${key}.to to a positive ascending range, e.g. {from: 18000, to: 18099}.`, message: `${key} must be a positive port or valid {from, to} range`})

    return undefined
  }

  return {from, to}
}

/**
 * @param {JsonValue} value - Raw value.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @param {{default?: string}} [options] - Options.
 * @returns {string} Normalized string, or a placeholder when invalid.
 */
function normalizeString(value, key, issues, options = {}) {
  if (value === undefined || value === null) {
    if (options.default !== undefined) return options.default

    issues.push({fix: `Set ${key} to a string value.`, message: `${key} is required`})

    return ""
  }

  if (typeof value !== "string") {
    issues.push({fix: `Set ${key} to a string value.`, message: `${key} must be a string`})

    return options.default ?? ""
  }

  return value
}

/**
 * @param {JsonValue} value - Raw value.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @param {{default?: number}} [options] - Options.
 * @returns {number} Normalized number, or a placeholder when invalid.
 */
function normalizeNumber(value, key, issues, options = {}) {
  if (value === undefined || value === null) {
    if (options.default !== undefined) return options.default

    issues.push({fix: `Set ${key} to a number.`, message: `${key} is required`})

    return 0
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({fix: `Set ${key} to a finite number.`, message: `${key} must be a number`})

    return options.default ?? 0
  }

  return value
}

/**
 * @param {JsonValue} value - Raw object.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @param {Record<string, JsonValue>} [defaultValue] - Default when missing.
 * @returns {Record<string, JsonValue>} Normalized object, or a placeholder when invalid.
 */
function objectAt(value, key, issues, defaultValue) {
  if (value === undefined || value === null) {
    if (defaultValue) return defaultValue

    issues.push({fix: `Add a ${key} mapping to the config.`, message: `${key} is required`})

    return {}
  }

  if (!isPlainObject(value)) {
    issues.push({fix: `Set ${key} to a mapping.`, message: `${key} must be an object`})

    return defaultValue ?? {}
  }

  return value
}

/**
 * @param {JsonValue} value - Raw array.
 * @param {string} key - Config key.
 * @param {ConfigIssue[]} issues - Issue collector.
 * @returns {JsonValue[]} Normalized array, or an empty array when invalid.
 */
function arrayAt(value, key, issues) {
  if (!Array.isArray(value)) {
    issues.push({fix: `Set ${key} to a list of process definitions.`, message: `${key} must be an array`})

    return []
  }

  return value
}

/**
 * @param {JsonValue} value - Value.
 * @returns {value is Record<string, JsonValue>} True for non-null, non-array objects.
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
