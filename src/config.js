// @ts-check

import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"

/**
 * @typedef {{from: number, to: number}} PortRange
 * @typedef {{path: string, timeoutMs: number, intervalMs: number}} HealthConfig
 * @typedef {"proxied" | "companion" | "singleton"} ProcessPolicy
 * @typedef {{cwd?: string, env: Record<string, string>, gracefulStopMs: number, health?: HealthConfig, id: string, policy: ProcessPolicy, port?: PortRange, restartDelayMs: number, command: string}} ProcessConfig
 * @typedef {{path: string}} ControlConfig
 * @typedef {{drainTimeoutMs: number, forceStopTimeoutMs: number, healthPath: string, healthTimeoutMs: number, host: string, port: number}} ProxyConfig
 * @typedef {{application: string, control: ControlConfig, processes: ProcessConfig[], proxy: ProxyConfig}} SwitchyardConfig
 */

const PROCESS_POLICIES = new Set(["proxied", "companion", "singleton"])

/**
 * Loads a YAML or JSON config file.
 * @param {string} configPath - Config path.
 * @returns {Promise<SwitchyardConfig>} Normalized config.
 */
export async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath)
  const rawText = await fs.readFile(absolutePath, "utf8")
  const rawConfig = absolutePath.endsWith(".json") ? JSON.parse(rawText) : YAML.parse(rawText)

  return normalizeConfig(rawConfig, absolutePath)
}

/**
 * Normalizes a raw config object.
 * @param {unknown} rawConfig - Parsed config.
 * @param {string} [configPath] - Source path.
 * @returns {SwitchyardConfig} Normalized config.
 */
export function normalizeConfig(rawConfig, configPath = process.cwd()) {
  if (!rawConfig || typeof rawConfig !== "object") {
    throw new Error("Config must be an object")
  }

  const source = /** @type {Record<string, unknown>} */ (rawConfig)
  const application = normalizeString(source.application, "application", path.basename(path.dirname(configPath)))
  const proxySource = objectAt(source.proxy, "proxy")
  const controlSource = objectAt(source.control, "control", {})
  const processesSource = arrayAt(source.processes, "processes")
  const proxy = normalizeProxy(proxySource)
  const control = {
    path: normalizeString(controlSource.path, "control.path", `/tmp/switchyard-${application}.sock`)
  }
  const processes = processesSource.map((processSource, index) => normalizeProcess(processSource, index, proxy))
  const proxiedProcesses = processes.filter((processConfig) => processConfig.policy === "proxied")

  if (proxiedProcesses.length !== 1) {
    throw new Error(`Config must define exactly one proxied process; found ${proxiedProcesses.length}`)
  }

  return {application, control, processes, proxy}
}

/**
 * @param {Record<string, unknown>} source - Raw proxy config.
 * @returns {ProxyConfig} Normalized proxy config.
 */
function normalizeProxy(source) {
  return {
    drainTimeoutMs: normalizeNumber(source.drainTimeoutMs, "proxy.drainTimeoutMs", 60000),
    forceStopTimeoutMs: normalizeNumber(source.forceStopTimeoutMs, "proxy.forceStopTimeoutMs", 10000),
    healthPath: normalizeString(source.healthPath, "proxy.healthPath", "/ping"),
    healthTimeoutMs: normalizeNumber(source.healthTimeoutMs, "proxy.healthTimeoutMs", 30000),
    host: normalizeString(source.host, "proxy.host", "127.0.0.1"),
    port: normalizeNumber(source.port, "proxy.port", 8182)
  }
}

/**
 * @param {unknown} value - Raw process config.
 * @param {number} index - Process index.
 * @param {ProxyConfig} proxy - Proxy config defaults.
 * @returns {ProcessConfig} Normalized process config.
 */
function normalizeProcess(value, index, proxy) {
  const source = objectAt(value, `processes[${index}]`)
  const id = normalizeString(source.id, `processes[${index}].id`)
  const policy = normalizePolicy(source.policy, `processes[${index}].policy`)
  const env = normalizeEnv(source.env, `processes[${index}].env`)

  return {
    command: normalizeString(source.command, `processes[${index}].command`),
    cwd: source.cwd === undefined ? undefined : normalizeString(source.cwd, `processes[${index}].cwd`),
    env,
    gracefulStopMs: normalizeNumber(source.gracefulStopMs, `processes[${index}].gracefulStopMs`, proxy.forceStopTimeoutMs),
    health: normalizeHealth(source.health, `processes[${index}].health`, proxy),
    id,
    policy,
    port: normalizePortRange(source.port, `processes[${index}].port`),
    restartDelayMs: normalizeNumber(source.restartDelayMs, `processes[${index}].restartDelayMs`, 1000)
  }
}

/**
 * @param {unknown} value - Raw policy.
 * @param {string} key - Config key.
 * @returns {ProcessPolicy} Normalized policy.
 */
function normalizePolicy(value, key) {
  const policy = normalizeString(value, key, "companion")

  if (!PROCESS_POLICIES.has(policy)) {
    throw new Error(`${key} must be one of: ${[...PROCESS_POLICIES].join(", ")}`)
  }

  return /** @type {ProcessPolicy} */ (policy)
}

/**
 * @param {unknown} value - Raw health config.
 * @param {string} key - Config key.
 * @param {ProxyConfig} proxy - Proxy defaults.
 * @returns {HealthConfig | undefined} Normalized health config.
 */
function normalizeHealth(value, key, proxy) {
  if (value === false || value === null) return undefined

  const source = value === undefined ? {} : objectAt(value, key)

  return {
    intervalMs: normalizeNumber(source.intervalMs, `${key}.intervalMs`, 250),
    path: normalizeString(source.path, `${key}.path`, proxy.healthPath),
    timeoutMs: normalizeNumber(source.timeoutMs, `${key}.timeoutMs`, proxy.healthTimeoutMs)
  }
}

/**
 * @param {unknown} value - Raw env config.
 * @param {string} key - Config key.
 * @returns {Record<string, string>} Normalized env.
 */
function normalizeEnv(value, key) {
  if (value === undefined || value === null) return {}

  const source = objectAt(value, key)
  /** @type {Record<string, string>} */
  const env = {}

  for (const [envKey, envValue] of Object.entries(source)) {
    env[envKey] = normalizeString(envValue, `${key}.${envKey}`)
  }

  return env
}

/**
 * @param {unknown} value - Raw port range.
 * @param {string} key - Config key.
 * @returns {PortRange | undefined} Normalized range.
 */
function normalizePortRange(value, key) {
  if (value === undefined || value === null) return undefined

  if (typeof value === "number") {
    return {from: value, to: value}
  }

  const source = objectAt(value, key)
  const from = normalizeNumber(source.from, `${key}.from`, 0)
  const to = normalizeNumber(source.to, `${key}.to`, from)

  if (from < 0 || to < 0 || to < from) {
    throw new Error(`${key} must be a positive port or valid {from, to} range`)
  }

  return {from, to}
}

/**
 * @param {unknown} value - Raw value.
 * @param {string} key - Config key.
 * @param {string} [defaultValue] - Default.
 * @returns {string} Normalized string.
 */
function normalizeString(value, key, defaultValue) {
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) return defaultValue
    throw new Error(`${key} is required`)
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`)
  }

  return value
}

/**
 * @param {unknown} value - Raw value.
 * @param {string} key - Config key.
 * @param {number} [defaultValue] - Default.
 * @returns {number} Normalized number.
 */
function normalizeNumber(value, key, defaultValue) {
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) return defaultValue
    throw new Error(`${key} is required`)
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`)
  }

  return value
}

/**
 * @param {unknown} value - Raw object.
 * @param {string} key - Config key.
 * @param {Record<string, unknown>} [defaultValue] - Default.
 * @returns {Record<string, unknown>} Normalized object.
 */
function objectAt(value, key, defaultValue) {
  if (value === undefined || value === null) {
    if (defaultValue) return defaultValue
    throw new Error(`${key} is required`)
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`)
  }

  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * @param {unknown} value - Raw array.
 * @param {string} key - Config key.
 * @returns {unknown[]} Normalized array.
 */
function arrayAt(value, key) {
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`)
  }

  return value
}
