// @ts-check

import {EventEmitter} from "node:events"
import {spawn} from "node:child_process"

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {"starting" | "running" | "stopping" | "stopped" | "failed"} ManagedProcessState
 * @typedef {import("node:child_process").ChildProcess["signalCode"]} ProcessExitSignal
 * @typedef {{at: string, line: string, stream: "stdout" | "stderr"}} ManagedProcessLog
 * @typedef {{command: string, cwd: string | undefined, env: Record<string, string | undefined>, logger: (message: string, data?: Record<string, import("./json.js").JsonValue>) => void, outputLines: number, restart: import("./config.js").RestartConfig, restartDelayMs: number, shouldRestart: () => boolean, stopTimeoutMs: number}} ManagedProcessDefinition
 * @typedef {{command: string, cwd: string | undefined, exitCode: number | null | undefined, exitSignal: ProcessExitSignal | undefined, id: string, logs: ManagedProcessLog[], pid: number | undefined, restarts: number, startedAt: string | undefined, state: ManagedProcessState, uptimeMs: number | undefined}} ManagedProcessStatus
 */

export default class ManagedProcess extends EventEmitter {
  /**
   * @param {object} args - Options.
   * @param {string} args.command - Shell command.
   * @param {string | undefined} args.cwd - Working directory.
   * @param {Record<string, string | undefined>} args.env - Environment.
   * @param {string} args.id - Process id.
   * @param {(message: string, data?: Record<string, JsonValue>) => void} args.logger - Logger callback.
   * @param {number} args.outputLines - Recent stdout/stderr lines to retain and report.
   * @param {import("./config.js").RestartConfig} [args.restart] - Restart policy (defaults to unlimited restarts with a constant delay).
   * @param {number} args.restartDelayMs - Restart delay.
   * @param {() => boolean} args.shouldRestart - Restart policy callback.
   * @param {number} args.stopTimeoutMs - Stop timeout.
   */
  constructor({command, cwd, env, id, logger, outputLines, restart = {backoffFactor: 1, maxDelayMs: 0, maxRestarts: undefined, windowMs: 0}, restartDelayMs, shouldRestart, stopTimeoutMs}) {
    super()

    this.command = command
    this.cwd = cwd
    this.env = env
    this.id = id
    this.logger = logger
    this.outputLines = outputLines
    this.restart = restart
    this.restartDelayMs = restartDelayMs
    this.shouldRestart = shouldRestart
    this.stopTimeoutMs = stopTimeoutMs
    this.state = /** @type {ManagedProcessState} */ ("stopped")
    this.logs = /** @type {ManagedProcessLog[]} */ ([])
    this.restarts = 0
    this.recentRestarts = /** @type {number[]} */ ([])
    this.startedAtMs = /** @type {number | undefined} */ (undefined)
    this.intentionalStop = false
    this.restartTimer = undefined
    this.child = undefined
    this.exitPromise = undefined
    this.pid = undefined
    this.exitCode = undefined
    this.exitSignal = undefined
  }

  /** @returns {Promise<void>} Resolves after spawn. */
  async start() {
    if (this.child) return

    this.intentionalStop = false
    this.exitCode = undefined
    this.exitSignal = undefined
    this.state = "starting"

    await new Promise((resolve, reject) => {
      const child = spawn(this.command, {
        cwd: this.cwd,
        detached: true,
        env: {...process.env, ...this.env},
        shell: true,
        stdio: ["ignore", "pipe", "pipe"]
      })

      this.child = child
      this.pid = child.pid
      this.exitPromise = new Promise((exitResolve) => {
        child.once("exit", (code, signal) => {
          this.onExit(code, signal)
          exitResolve(undefined)
        })
      })

      child.once("spawn", () => {
        this.state = "running"
        this.startedAtMs = Date.now()
        this.logger("process started", {command: this.command, id: this.id, pid: child.pid || null})
        this.emit("started")
        resolve(undefined)
      })
      child.once("error", (error) => {
        this.state = "failed"
        reject(error)
      })
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk) => this.appendLog("stdout", chunk))
      child.stderr.on("data", (chunk) => this.appendLog("stderr", chunk))
    })
  }

  /**
   * Updates the command template used for future restarts without touching the currently running child.
   * @param {ManagedProcessDefinition} definition - Replacement process definition.
   * @returns {void}
   */
  updateDefinition(definition) {
    this.command = definition.command
    this.cwd = definition.cwd
    this.env = definition.env
    this.logger = definition.logger
    this.outputLines = definition.outputLines
    this.restart = definition.restart
    this.restartDelayMs = definition.restartDelayMs
    this.shouldRestart = definition.shouldRestart
    this.stopTimeoutMs = definition.stopTimeoutMs
  }

  /**
   * @param {"stdout" | "stderr"} stream - Stream name.
   * @param {string} chunk - Output chunk.
   * @returns {void}
   */
  appendLog(stream, chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue

      this.logs.push({at: new Date().toISOString(), line, stream})

      if (this.logs.length > this.outputLines) {
        this.logs.splice(0, this.logs.length - this.outputLines)
      }
    }
  }

  /**
   * @param {number | null} code - Exit code.
   * @param {ProcessExitSignal} signal - Exit signal.
   * @returns {void}
   */
  onExit(code, signal) {
    const wasIntentional = this.intentionalStop

    this.exitCode = code
    this.exitSignal = signal
    this.child = undefined
    this.pid = undefined
    this.exitPromise = undefined
    this.state = wasIntentional ? "stopped" : "failed"
    this.logger("process exited", {code, id: this.id, signal})
    this.emit("exit", {code, signal})

    if (!wasIntentional && this.shouldRestart()) {
      this.scheduleRestart()
    }
  }

  /**
   * Schedules an automatic restart per the restart policy, or gives up once the policy's limit is reached.
   * @returns {void}
   */
  scheduleRestart() {
    const {backoffFactor, maxRestarts, windowMs} = this.restart

    // Fast path: unlimited restarts with a constant delay needs no per-restart bookkeeping.
    // The delay is constant across attempts here (backoffFactor is 1), so restartDelayFor(0)
    // gives the right value while still applying any maxDelayMs cap.
    if (maxRestarts === undefined && backoffFactor === 1) {
      this.queueRestart(this.restartDelayFor(0))

      return
    }

    const now = Date.now()

    if (windowMs > 0) {
      this.recentRestarts = this.recentRestarts.filter((time) => time > now - windowMs)
    }

    if (maxRestarts !== undefined && this.recentRestarts.length >= maxRestarts) {
      this.logger("restart limit reached", {id: this.id, maxRestarts, windowMs})

      return
    }

    const delay = this.restartDelayFor(this.recentRestarts.length)

    this.recentRestarts.push(now)
    this.queueRestart(delay)
  }

  /**
   * @param {number} attempt - Number of restarts already counted in the current window.
   * @returns {number} Backed-off restart delay in milliseconds, capped by maxDelayMs when set.
   */
  restartDelayFor(attempt) {
    const backedOff = this.restartDelayMs * this.restart.backoffFactor ** attempt

    return this.restart.maxDelayMs > 0 ? Math.min(backedOff, this.restart.maxDelayMs) : backedOff
  }

  /**
   * @param {number} delayMs - Delay before the restart attempt.
   * @returns {void}
   */
  queueRestart(delayMs) {
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.restarts += 1
      this.start().catch((error) => {
        this.logger("process restart failed", {error: error instanceof Error ? error.message : String(error), id: this.id})
      })
    }, delayMs)
  }

  /**
   * @param {{timeoutMs?: number}} [options] - Stop options.
   * @returns {Promise<void>} Resolves when stopped.
   */
  async stop(options = {}) {
    this.intentionalStop = true

    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }

    const child = this.child

    if (!child || !child.pid) {
      this.state = "stopped"
      return
    }

    this.state = "stopping"
    this.killProcessGroup("SIGTERM")
    const timeoutMs = options.timeoutMs ?? this.stopTimeoutMs
    const stopped = await this.waitForExit(timeoutMs)

    if (!stopped) {
      this.logger("process stop timed out; sending SIGKILL", {id: this.id, pid: child.pid})
      this.killProcessGroup("SIGKILL")
      await this.waitForExit(5000)
    }

    this.state = "stopped"
  }

  /**
   * @param {"SIGTERM" | "SIGKILL"} signal - Signal to send.
   * @returns {void}
   */
  killProcessGroup(signal) {
    if (!this.child || !this.child.pid) return

    try {
      process.kill(-this.child.pid, signal)
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return
      throw error
    }
  }

  /**
   * @param {number} timeoutMs - Timeout.
   * @returns {Promise<boolean>} True when the process exited before timeout.
   */
  async waitForExit(timeoutMs) {
    if (!this.exitPromise) return true

    let timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined)
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    const exitPromise = this.exitPromise.then(() => true)
    const result = await Promise.race([exitPromise, timeoutPromise])

    if (timer) clearTimeout(timer)

    return Boolean(result)
  }

  /** @returns {ManagedProcessStatus} Status payload. */
  status() {
    return {
      command: this.command,
      cwd: this.cwd,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      id: this.id,
      logs: this.logs.slice(-this.outputLines),
      pid: this.pid,
      restarts: this.restarts,
      startedAt: this.startedAtMs === undefined ? undefined : new Date(this.startedAtMs).toISOString(),
      state: this.state,
      uptimeMs: this.state === "running" && this.startedAtMs !== undefined ? Date.now() - this.startedAtMs : undefined
    }
  }
}
