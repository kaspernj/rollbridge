// @ts-check

import {EventEmitter} from "node:events"
import {spawn} from "node:child_process"
import {processGroupHasLiveMembers, processGroupMembers} from "./process-memory.js"

const ACTIVATION_HOOK_TIMEOUT_MS = 30000

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {"starting" | "running" | "quiesced" | "stopping" | "stopped" | "failed"} ManagedProcessState
 * @typedef {"deploy" | "crash" | "manual" | "memory"} ManagedProcessStartReason
 * @typedef {"active" | "candidate" | "retired"} LifecycleRole
 * @typedef {import("node:child_process").ChildProcess["signalCode"]} ProcessExitSignal
 * @typedef {{at: string, line: string, stream: "stdout" | "stderr"}} ManagedProcessLog
 * @typedef {import("./config.js").StopTimeoutMs} StopTimeoutMs
 * @typedef {{command: string, cwd: string | undefined, env: Record<string, string | undefined>, lifecycle: import("./config.js").LifecycleConfig, logger: (message: string, data?: Record<string, import("./json.js").JsonValue>) => void, memory: import("./config.js").MemoryConfig | undefined, outputLines: number, restart: import("./config.js").RestartConfig, restartDelayMs: number, shouldRestart: () => boolean, stopSignal: string, stopTimeoutMs: StopTimeoutMs}} ManagedProcessDefinition
 * @typedef {{children: import("./process-memory.js").ProcessGroupMember[], command: string, cwd: string | undefined, exitCode: number | null | undefined, exitSignal: ProcessExitSignal | undefined, id: string, lastMemoryRestartAt: string | undefined, lastStartReason: ManagedProcessStartReason | undefined, lifecycleRole?: LifecycleRole, logs: ManagedProcessLog[], memoryRestarts: number, pid: number | undefined, restarts: number, rssBytes: number | undefined, startedAt: string | undefined, state: ManagedProcessState, uptimeMs: number | undefined}} ManagedProcessStatus
 */

export default class ManagedProcess extends EventEmitter {
  /**
   * @param {object} args - Options.
   * @param {string} args.command - Shell command.
   * @param {string | undefined} args.cwd - Working directory.
   * @param {Record<string, string | undefined>} args.env - Environment.
   * @param {string} args.id - Process id.
   * @param {(message: string, data?: Record<string, JsonValue>) => void} args.logger - Logger callback.
   * @param {import("./config.js").LifecycleConfig} [args.lifecycle] - Graceful-stop lifecycle hooks (none by default).
   * @param {import("./config.js").MemoryConfig} [args.memory] - Memory supervision config (off when omitted).
   * @param {number} args.outputLines - Recent stdout/stderr lines to retain and report.
   * @param {import("./config.js").RestartConfig} [args.restart] - Restart policy (defaults to unlimited restarts with a constant delay).
   * @param {number} args.restartDelayMs - Restart delay.
   * @param {() => boolean} args.shouldRestart - Restart policy callback.
   * @param {string} [args.stopSignal] - Signal sent to gracefully stop the process (default "SIGTERM").
   * @param {StopTimeoutMs} args.stopTimeoutMs - Stop timeout.
   */
  constructor({command, cwd, env, id, lifecycle = {drainTimeoutMs: 0}, logger, memory, outputLines, restart = {backoffFactor: 1, maxDelayMs: 0, maxRestarts: undefined, windowMs: 0}, restartDelayMs, shouldRestart, stopSignal = "SIGTERM", stopTimeoutMs}) {
    super()

    this.command = command
    this.cwd = cwd
    this.env = env
    this.id = id
    this.lifecycle = lifecycle
    this.logger = logger
    this.memory = memory
    this.outputLines = outputLines
    this.restart = restart
    this.restartDelayMs = restartDelayMs
    this.shouldRestart = shouldRestart
    this.stopSignal = stopSignal
    this.stopTimeoutMs = stopTimeoutMs
    this.state = /** @type {ManagedProcessState} */ ("stopped")
    this.lastStartReason = /** @type {ManagedProcessStartReason | undefined} */ (undefined)
    this.logs = /** @type {ManagedProcessLog[]} */ ([])
    this.restarts = 0
    this.recentRestarts = /** @type {number[]} */ ([])
    this.rssBytes = /** @type {number | undefined} */ (undefined)
    this.children = /** @type {import("./process-memory.js").ProcessGroupMember[]} */ ([])
    this.memoryRestarts = 0
    this.lastMemoryRestartAtMs = /** @type {number | undefined} */ (undefined)
    this.memoryTimer = /** @type {ReturnType<typeof setInterval> | undefined} */ (undefined)
    this.memoryRestarting = false
    this.memoryWarned = false
    this.startedAtMs = /** @type {number | undefined} */ (undefined)
    this.intentionalStop = false
    this.lifecycleRole = /** @type {LifecycleRole} */ ("candidate")
    this.intentionalStopSignal = /** @type {ProcessExitSignal | undefined} */ (undefined)
    this.quiescePromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.quiesceError = /** @type {Error | undefined} */ (undefined)
    this.stopPromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.restartTimer = undefined
    this.child = undefined
    this.exitPromise = undefined
    this.pid = undefined
    this.exitCode = undefined
    this.exitSignal = undefined
  }

  /**
   * @param {ManagedProcessStartReason} [reason] - Why the process is being started (deploy by default; "crash" on auto-restart, "manual" via the restart command).
   * @param {LifecycleRole} [lifecycleRole] - Exact desired role to restore before reporting the process running.
   * @returns {Promise<void>} Resolves after spawn and lifecycle-role restoration.
   */
  async start(reason = "deploy", lifecycleRole) {
    if (lifecycleRole) this.lifecycleRole = lifecycleRole
    if (this.child) return

    this.intentionalStop = false
    this.intentionalStopSignal = undefined
    this.quiescePromise = undefined
    this.quiesceError = undefined
    this.stopPromise = undefined
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
        void (async () => {
          this.startedAtMs = Date.now()
          this.lastStartReason = reason
          try {
            await this.restoreLifecycleRole()
          } catch (error) {
            this.state = "failed"
            this.logger("process lifecycle role restoration failed", {error: error instanceof Error ? error.message : String(error), id: this.id, role: this.lifecycleRole})
            reject(error)
            return
          }
          if (this.child !== child) {
            reject(new Error(`Process ${this.id} exited before lifecycle role ${this.lifecycleRole} was restored`))
            return
          }
          this.state = "running"
          this.logger("process started", {command: this.command, id: this.id, pid: child.pid || null, reason})
          this.startMemoryMonitor()
          this.emit("started")
          resolve(undefined)
        })()
      })
      child.once("error", (error) => {
        this.state = "failed"
        if (this.child === child) {
          this.child = undefined
          this.pid = undefined
          this.exitPromise = undefined
        }
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
    this.lifecycle = definition.lifecycle
    this.logger = definition.logger
    this.memory = definition.memory
    this.outputLines = definition.outputLines
    this.restart = definition.restart
    this.restartDelayMs = definition.restartDelayMs
    this.shouldRestart = definition.shouldRestart
    this.stopSignal = definition.stopSignal
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

      const entry = {at: new Date().toISOString(), line, stream}

      this.logs.push(entry)

      if (this.logs.length > this.outputLines) {
        this.logs.splice(0, this.logs.length - this.outputLines)
      }
      this.emit("log", entry)
    }
  }

  /**
   * @param {number | null} code - Exit code.
   * @param {ProcessExitSignal} signal - Exit signal.
   * @returns {void}
   */
  onExit(code, signal) {
    const wasIntentional = this.intentionalStop

    this.exitCode = this.intentionalStopSignal ? null : code
    this.exitSignal = signal ?? this.intentionalStopSignal
    this.child = undefined
    this.pid = undefined
    this.exitPromise = undefined
    this.rssBytes = undefined
    this.children = []
    this.clearMemoryMonitor()
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
      this.start("crash").catch((error) => {
        this.logger("process restart failed", {error: error instanceof Error ? error.message : String(error), id: this.id})
      })
    }, delayMs)

    // The daemon's listening servers govern its lifetime; a pending restart must never be the sole
    // handle keeping the process alive (like the memory and persist timers above). Otherwise a
    // crashed process with an unlimited restart policy would respawn forever and block exit.
    this.restartTimer.unref?.()
  }

  /**
   * Starts the periodic RSS check for this process when memory supervision is configured.
   * @returns {void}
   */
  startMemoryMonitor() {
    this.clearMemoryMonitor()

    if (!this.memory) return

    this.memoryTimer = setInterval(() => this.checkMemory(), this.memory.checkIntervalMs)
    this.memoryTimer.unref?.()
  }

  /** @returns {void} Stops the periodic RSS check. */
  clearMemoryMonitor() {
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer)
      this.memoryTimer = undefined
    }
  }

  /**
   * Measures the process group's RSS and warns or restarts when it crosses the configured thresholds.
   * @returns {void}
   */
  checkMemory() {
    if (!this.memory || !this.pid || this.memoryRestarting) return

    const members = processGroupMembers(this.pid)

    if (members.length === 0) return

    this.children = members

    const measured = members.filter((member) => member.rssBytes !== undefined)

    if (measured.length === 0) return

    const rssBytes = measured.reduce((total, member) => total + (member.rssBytes ?? 0), 0)

    this.rssBytes = rssBytes

    if (rssBytes > this.memory.limitBytes) {
      this.logger("memory limit exceeded", {id: this.id, limitBytes: this.memory.limitBytes, rssBytes})
      void this.restartForMemory()

      return
    }

    if (this.memory.warnBytes > 0 && rssBytes > this.memory.warnBytes) {
      if (!this.memoryWarned) {
        this.logger("memory warning", {id: this.id, rssBytes, warnBytes: this.memory.warnBytes})
        this.memoryWarned = true
      }
    } else {
      this.memoryWarned = false
    }
  }

  /**
   * Gracefully restarts the process after it exceeded its memory limit (SIGTERM, then
   * SIGKILL after the stop timeout), recording the restart so status can report it.
   * @returns {Promise<void>} Resolves once the process has been restarted.
   */
  async restartForMemory() {
    if (this.memoryRestarting) return

    this.memoryRestarting = true
    const lifecycleRole = this.lifecycleRole

    try {
      await this.stop()

      // Don't respawn if the supervising context no longer wants this process running
      // (daemon shutting down, or the release draining/retired) — otherwise a restart racing
      // a shutdown could leave a child running after shutdown collected its stop promises.
      if (!this.shouldRestart()) return

      this.memoryRestarts += 1
      this.lastMemoryRestartAtMs = Date.now()
      this.memoryWarned = false
      await this.start("memory", lifecycleRole)
    } catch (error) {
      this.logger("memory restart failed", {error: error instanceof Error ? error.message : String(error), id: this.id})
    } finally {
      this.memoryRestarting = false
    }
  }

  /**
   * @param {{timeoutMs?: number}} [options] - Stop options.
   * @returns {Promise<void>} Resolves when stopped.
   */
  async stop(options = {}) {
    if (!this.stopPromise) this.stopPromise = this.performStop(options)
    return await this.stopPromise
  }

  /**
   * @param {{timeoutMs?: number}} options - Stop options.
   * @returns {Promise<void>} Resolves when stopped.
   */
  async performStop(options) {
    const pgid = this.child?.pid ?? this.pid
    const exitPromise = this.exitPromise
    await this.quiesce()

    if (!pgid) {
      this.state = "stopped"
      return
    }

    const {drainCommand, drainTimeoutMs, stopCommand} = this.lifecycle

    const hookTimeoutMs = this.hookTimeoutMs()

    // 2. Drain: let in-flight work finish, bounded by drainTimeoutMs (0 skips the step). A
    //    drainCommand blocks until drained; otherwise wait for the process to exit on its own.
    if (this.processGroupExists(pgid) && drainTimeoutMs > 0) {
      if (drainCommand) await this.runHook(drainCommand, drainTimeoutMs, "drain command")
      else await this.waitForExit(drainTimeoutMs)
    }

    // 3. Stop whatever is still running, then SIGKILL if it outlasts the graceful window.
    if (this.processGroupExists(pgid)) {
      const timeoutMs = options.timeoutMs ?? this.stopTimeoutMs
      let gracefulDeadline

      if (stopCommand) {
        await this.runHook(stopCommand, hookTimeoutMs, "stop command", pgid)
        gracefulDeadline = timeoutMs === "indefinite" ? undefined : Date.now() + timeoutMs
      } else {
        this.intentionalStopSignal = /** @type {ProcessExitSignal} */ (this.stopSignal)
        gracefulDeadline = timeoutMs === "indefinite" ? undefined : Date.now() + timeoutMs
        await this.signalProcessGroup(this.stopSignal, pgid, gracefulDeadline)
      }

      if (!(await this.waitForProcessGroupExit(pgid, gracefulDeadline))) {
        this.logger("process stop timed out; sending SIGKILL", {id: this.id, pid: pgid})
        const killDeadline = Date.now() + 5000

        await this.signalProcessGroup("SIGKILL", pgid, killDeadline)
        await this.waitForProcessGroupExit(pgid, killDeadline)
      }
    }

    if (exitPromise) await exitPromise

    this.state = "stopped"
  }

  /** @returns {Promise<void>} Stops restarts and waits until the process has stopped accepting new work. */
  async quiesce() {
    if (this.quiescePromise) return await this.quiescePromise
    this.quiescePromise = (async () => {
      this.intentionalStop = true
      this.clearMemoryMonitor()
      if (this.restartTimer) {
        clearTimeout(this.restartTimer)
        this.restartTimer = undefined
      }
      if (!this.child?.pid) {
        this.state = "stopped"
        if (this.lifecycle.activateCommand) this.lifecycleRole = "retired"
        return
      }
      this.state = "stopping"
      if (this.lifecycle.quietCommand) this.quiesceError = await this.runHook(this.lifecycle.quietCommand, this.hookTimeoutMs(), "quiet command")
      if (!this.quiesceError) {
        this.state = "quiesced"
        if (this.lifecycle.activateCommand) this.lifecycleRole = "retired"
      }
    })()
    return await this.quiescePromise
  }

  /** @returns {Promise<void>} Quiesces and rejects when the quiet hook did not succeed. */
  async quiesceStrict() {
    await this.quiesce()
    if (this.quiesceError) throw this.quiesceError
  }

  /** Re-runs the idempotent quiet hook for an explicitly resumed durable transition. */
  async requiesceStrict() {
    this.quiescePromise = undefined
    this.quiesceError = undefined
    await this.quiesceStrict()
  }

  /** Runs the opt-in generation activation command and rejects on any hook failure. */
  async activateStrict() {
    const command = this.lifecycle.activateCommand

    if (!command) return
    const error = await this.runHook(command, ACTIVATION_HOOK_TIMEOUT_MS, "activate command", this.pid)

    if (error) throw error
    this.lifecycleRole = "active"
  }

  /**
   * Records the durable desired role without firing a lifecycle command.
   * @param {LifecycleRole} role - Exact role owned by this process generation.
   */
  async setLifecycleRole(role) {
    this.lifecycleRole = role
  }

  /** Restores an active or retired role after this exact process starts. */
  async restoreLifecycleRole() {
    if (!this.lifecycle.activateCommand || this.lifecycleRole === "candidate") return
    const command = this.lifecycleRole === "active" ? this.lifecycle.activateCommand : this.lifecycle.quietCommand

    if (!command) throw new Error(`Process ${this.id} cannot restore lifecycle role ${this.lifecycleRole} without its paired command`)
    const timeoutMs = this.lifecycleRole === "active" ? ACTIVATION_HOOK_TIMEOUT_MS : this.hookTimeoutMs()
    const error = await this.runHook(command, timeoutMs, `${this.lifecycleRole === "active" ? "activate" : "quiet"} command`, this.pid)

    if (error) throw error
  }

  /** @returns {number} Timeout used for lifecycle hooks. */
  hookTimeoutMs() {
    if (this.stopTimeoutMs === "indefinite") return 30000

    return this.stopTimeoutMs
  }

  /**
   * Runs a lifecycle hook command, bounded by a timeout so a hung hook can never block stop().
   * Failures are logged and returned so generation retirement can surface a failed quiet hook;
   * ordinary stop sequences may still continue to their configured stop mechanism.
   * @param {string} command - Shell command to run.
   * @param {number} timeoutMs - Maximum time to wait for the hook before killing it.
   * @param {string} label - Hook name, for log messages.
   * @param {number | undefined} [pid] - Process-group leader exposed to the hook.
   * @returns {Promise<Error | undefined>} Failure, or undefined after a successful hook.
   */
  async runHook(command, timeoutMs, label, pid = this.pid) {
    return await new Promise((resolve) => {
      let settled = false
      /** @param {Error | undefined} error - Hook failure. */
      const finish = (error) => { if (!settled) { settled = true; resolve(error) } }

      /** @type {import("node:child_process").ChildProcess} */
      let hook

      try {
        hook = spawn(command, {
          cwd: this.cwd,
          detached: true,
          env: {...process.env, ...this.env, ROLLBRIDGE_PID: pid ? String(pid) : ""},
          shell: true,
          stdio: "ignore"
        })
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.logger(`${label} failed`, {error: failure.message, id: this.id})
        finish(failure)

        return
      }

      const timer = setTimeout(() => {
        this.logger(`${label} timed out`, {id: this.id, timeoutMs})

        if (hook.pid) {
          try {
            process.kill(-hook.pid, "SIGKILL")
          } catch {
            // The hook already exited.
          }
        }

        finish(new Error(`${label} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      hook.once("exit", (code, signal) => {
        clearTimeout(timer)

        // A non-zero/signalled exit is surfaced (but still non-fatal); skip when the timeout
        // already killed the hook, which logs separately.
        if (!settled) {
          if (typeof code === "number" && code !== 0) {
            this.logger(`${label} exited non-zero`, {code, id: this.id})
            finish(new Error(`${label} exited non-zero with status ${code}`))
            return
          } else if (signal) {
            this.logger(`${label} exited on signal`, {id: this.id, signal})
            finish(new Error(`${label} exited on signal ${signal}`))
            return
          }
        }

        finish(undefined)
      })
      hook.once("error", (error) => {
        clearTimeout(timer)
        const failure = error instanceof Error ? error : new Error(String(error))
        this.logger(`${label} failed`, {error: failure.message, id: this.id})
        finish(failure)
      })
    })
  }

  /**
   * @param {string} signal - Signal name to send (the configured stop signal, or "SIGKILL").
   * @param {number | undefined} [pgid] - Process group id (the current child pid by default).
   * @returns {void}
   */
  killProcessGroup(signal, pgid = this.pid) {
    if (!pgid) return

    try {
      process.kill(-pgid, signal)
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return
      throw error
    }
  }

  /**
   * Signals descendants before their shell leader so the leader can reap them before it exits.
   * Falls back to the portable group signal when procfs cannot identify group members.
   * @param {string} signal - Signal name.
   * @param {number} pgid - Process group id.
   * @param {number | undefined} deadline - Absolute graceful deadline, or undefined to wait indefinitely.
   * @returns {Promise<void>} Resolves after the leader has been signalled.
   */
  async signalProcessGroup(signal, pgid, deadline) {
    const members = processGroupMembers(pgid)
    const descendants = members.filter((member) => member.pid !== pgid)

    if (descendants.length === 0) {
      this.killProcessGroup(signal, pgid)
      return
    }

    for (const descendant of descendants) this.killProcess(descendant.pid, signal)
    while (processGroupMembers(pgid).some((member) => member.pid !== pgid)) {
      if (deadline !== undefined && Date.now() >= deadline) break
      const waitMs = deadline === undefined ? 25 : Math.min(25, deadline - Date.now())

      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }

    this.killProcess(pgid, signal)
  }

  /**
   * Signals one verified member of the owned process group.
   * @param {number} pid - Process id.
   * @param {string} signal - Signal name.
   * @returns {void}
   */
  killProcess(pid, signal) {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return
      throw error
    }
  }

  /**
   * @param {number} pgid - Process group id.
   * @returns {boolean} True until the process group no longer exists.
   */
  processGroupExists(pgid) {
    const hasLiveMembers = processGroupHasLiveMembers(pgid)

    if (hasLiveMembers !== undefined) return hasLiveMembers

    try {
      process.kill(-pgid, 0)

      return true
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false
      throw error
    }
  }

  /**
   * @param {number} pgid - Process group id.
   * @param {number | undefined} deadline - Absolute deadline, or undefined to wait indefinitely.
   * @returns {Promise<boolean>} True once the process group no longer exists.
   */
  async waitForProcessGroupExit(pgid, deadline) {
    while (this.processGroupExists(pgid)) {
      if (deadline !== undefined && Date.now() >= deadline) return false
      const waitMs = deadline === undefined ? 10 : Math.min(10, deadline - Date.now())

      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }

    return true
  }

  /**
   * @param {StopTimeoutMs} timeoutMs - Timeout.
   * @returns {Promise<boolean>} True when the process exited before timeout.
   */
  async waitForExit(timeoutMs) {
    if (!this.exitPromise) return true
    if (timeoutMs === "indefinite") {
      await this.exitPromise
      return true
    }

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
      children: this.children,
      command: this.command,
      cwd: this.cwd,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      id: this.id,
      lastMemoryRestartAt: this.lastMemoryRestartAtMs === undefined ? undefined : new Date(this.lastMemoryRestartAtMs).toISOString(),
      lastStartReason: this.lastStartReason,
      ...(this.lifecycle.activateCommand ? {lifecycleRole: this.lifecycleRole} : {}),
      logs: this.logs.slice(-this.outputLines),
      memoryRestarts: this.memoryRestarts,
      pid: this.pid,
      restarts: this.restarts,
      rssBytes: this.rssBytes,
      startedAt: this.startedAtMs === undefined ? undefined : new Date(this.startedAtMs).toISOString(),
      state: this.state,
      uptimeMs: this.state === "running" && this.startedAtMs !== undefined ? Date.now() - this.startedAtMs : undefined
    }
  }
}
