// @ts-check

import fs from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import crypto from "node:crypto"
import {isDeepStrictEqual} from "node:util"
import httpProxy from "http-proxy"
import {loadConfig} from "./config.js"
import {openControlSession} from "./control-client.js"
import EventLog from "./event-log.js"
import GuardianClient from "./guardian-client.js"
import ReleaseGroup from "./release-group.js"
import {clearState, isProcessAlive, liveProcesses, readState, writeState} from "./state-store.js"
import {resolveGroupId, resolveUserId} from "./system-ids.js"

const EVENT_HISTORY_LIMIT = 1000
const STATE_PERSIST_INTERVAL_MS = 5000

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {{releaseId?: string, releasePath: string, revision?: string}} DeployArgs
 * @typedef {{attestation?: string, releaseId: string, releasePath: string, revision: string}} BootstrapIdentity
 * @typedef {{id: string, process: import("./managed-process.js").ManagedProcessStatus}} ProcessStatus
 * @typedef {{disruptive: true, mode: "legacy-first-upgrade", reason: string}} OwnerTransition
 * @typedef {"candidate_ready" | "retiring_previous" | "previous_retired" | "activating_candidate" | "committed_pending" | "committed" | "restoring_committed"} GenerationTransitionPhase
 * @typedef {{candidateReleaseId: string, candidateReleasePath: string, candidateRevision: string, configDigest: string, error?: string, phase: GenerationTransitionPhase, previousReleaseId: string | null, startedAt: string, updatedAt: string}} GenerationTransition
 * @typedef {{activeReleaseId: string | null, application: string, bootstrap: BootstrapIdentity | undefined, control: import("./config.js").ControlConfig, daemonPid: number, daemonRuntime: import("./daemon-runtime.js").DaemonRuntimeIdentity | undefined, generationTransition?: GenerationTransition, ownerRecovery: {configDigest: string} | undefined, ownerTransition?: OwnerTransition, orphans: {id: string, pid: number, releaseId: string | null}[], proxy: {host: string, port: number | undefined, upstreamHost: string}, releaseReferences: {releaseId: string, releasePath: string}[], releases: import("./release-group.js").ReleaseStatus[], services: ProcessStatus[], singletons: ProcessStatus[]}} DaemonStatus
 * @typedef {{configDigest: string, format: number, guardian: {pid?: number, socketPath: string, token: string}, reconnectGraceMs: number}} OwnerRecoveryMetadata
 * @typedef {DaemonStatus & {recovery: OwnerRecoveryMetadata, singletonReleaseIds?: Record<string, string>}} OwnerRecoverySnapshot
 * @typedef {{authority: JsonValue, config: import("./config.js").RollbridgeConfig, releaseConfigs?: Record<string, import("./config.js").RollbridgeConfig>, singletonReleaseIds?: Record<string, string>, snapshot: OwnerRecoverySnapshot}} PrivateOwnerState
 * @typedef {{boundaryCrossed: boolean, incumbentControl?: Awaited<ReturnType<typeof openControlSession>>, incumbentStartTime: string, legacyGuardian: GuardianClient, legacyInventory: {key: string, provenance: string}[], legacyPrepared?: {ownerState: JsonValue, replacementId: string}, legacySnapshot: OwnerRecoverySnapshot, prepared: {ownerState: JsonValue, replacementId: string}, recoverySnapshot: OwnerRecoverySnapshot}} LegacyOwnerBridge
 */

export default class RollbridgeDaemon {
  /**
   * @param {object} args - Options.
   * @param {BootstrapIdentity} [args.bootstrap] - Immutable known-release foreground bootstrap identity.
   * @param {import("./config.js").RollbridgeConfig} args.config - Rollbridge config.
   * @param {string} [args.configPath] - Config file path to reload before deploys.
   * @param {(message: string, data?: Record<string, JsonValue>) => void} [args.logger] - Logger.
   * @param {number} [args.legacyIncumbentPid] - Exact incumbent PID supplied by ensure-daemon.
   * @param {import("./daemon-runtime.js").DaemonRuntimeIdentity} [args.runtime] - Immutable daemon runtime identity.
   */
  constructor({bootstrap, config, configPath, legacyIncumbentPid, logger, runtime}) {
    this.bootstrap = bootstrap ? {...bootstrap} : undefined
    this.config = config
    this.configPath = configPath
    this.runtime = runtime
    this.legacyIncumbentPid = legacyIncumbentPid
    this.eventLog = new EventLog(EVENT_HISTORY_LIMIT)

    const baseLogger = logger || ((message, data = {}) => console.log(JSON.stringify({at: new Date().toISOString(), data, message})))

    // Every operational milestone is logged through this.logger, so recording here
    // gives a structured event history for free (deploys, switches, stops, crashes,
    // restarts, and failed commands).
    this.logger = /** @type {(message: string, data?: Record<string, JsonValue>) => void} */ ((message, data = {}) => {
      this.eventLog.record(message, data)
      baseLogger(message, data)
    })

    this.releases = /** @type {Map<string, ReleaseGroup>} */ (new Map())
    this.services = /** @type {Map<string, import("./managed-process.js").default>} */ (new Map())
    this.servicePorts = /** @type {Record<string, number>} */ ({})
    this.portReservations = /** @type {Set<number>} */ (new Set())
    this.singletons = /** @type {Map<string, import("./managed-process.js").default>} */ (new Map())
    this.singletonReleaseIds = /** @type {Map<string, string>} */ (new Map())
    this.activeRelease = /** @type {ReleaseGroup | undefined} */ (undefined)
    this.generationTransition = /** @type {GenerationTransition | undefined} */ (undefined)
    this.proxy = httpProxy.createProxyServer({ws: true, xfwd: true})
    this.proxyServer = /** @type {http.Server | undefined} */ (undefined)
    this.controlServer = /** @type {net.Server | undefined} */ (undefined)
    this.controlSocketOwned = false
    this.boundControlPath = /** @type {string | undefined} */ (undefined)
    this.controlSockets = /** @type {Set<net.Socket>} */ (new Set())
    this.proxyPort = /** @type {number | undefined} */ (undefined)
    this.stopping = false
    this.statePath = config.statePath
    this.persistTimer = /** @type {ReturnType<typeof setInterval> | undefined} */ (undefined)
    this.persistenceEnabled = false
    this.pendingWrite = /** @type {Promise<void> | undefined} */ (undefined)
    this.stateCleanupEnabled = false
    this.shutdownPromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.retirementPromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.ownerRetired = false
    this.controlClosePromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.proxyClosePromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.listenerHandoff = /** @type {{control: boolean, proxy: boolean, replacementId: string} | undefined} */ (undefined)
    this.listenerHandoffFailure = /** @type {Error | undefined} */ (undefined)
    this.incumbentListenerControl = /** @type {Awaited<ReturnType<typeof openControlSession>> | undefined} */ (undefined)
    this.ownerTransition = /** @type {OwnerTransition | undefined} */ (undefined)
    this.controlCommandsReady = true
    this.startingReleases = /** @type {Set<ReleaseGroup>} */ (new Set())
    this.guardian = /** @type {GuardianClient | undefined} */ (undefined)
    this.guardianIdentity = /** @type {{pid?: number, socketPath: string, token: string} | undefined} */ (undefined)
    // Still-alive managed processes left by a previous daemon (from statePath), captured at
    // startup and surfaced in status(). The daemon cannot re-manage them, only report them.
    this.orphans = /** @type {{id: string, pid: number, releaseId: string | null}[]} */ ([])

    this.proxy.on("error", (error, req, res) => this.onProxyError(error, req, res))
  }

  /**
   * Starts daemon listeners.
   * @param {{exposeControl?: boolean, reportOrphans?: boolean}} [options] - Listener startup options.
   * @returns {Promise<void>} Resolves when the requested listeners are ready.
   */
  async start({exposeControl = true, reportOrphans = true} = {}) {
    if (this.config.ownerRecovery) await this.initializeOwnerRecovery()
    else if (reportOrphans) await this.reportOrphans()
    await this.startProxy()
    if (exposeControl) await this.exposeControl()
  }

  /** Connects to the durable process guardian and reconstructs a matching persisted owner snapshot. */
  async initializeOwnerRecovery() {
    if (!this.statePath) throw new Error("ownerRecovery requires statePath")
    const state = await readState(this.statePath)
    const snapshot = state && typeof state === "object" && !Array.isArray(state) ? /** @type {OwnerRecoverySnapshot} */ (state) : undefined
    const recovery = snapshot?.recovery
    const configDigest = this.ownerRecoveryConfigDigest()

    if (snapshot && !recovery) throw new Error(`Owner recovery state ${this.statePath} is missing durable guardian identity; refusing to overwrite it.`)
    if (recovery && recovery.configDigest !== configDigest) throw new Error("Owner recovery config identity does not match the persisted owner; refusing cross-authority adoption.")
    if (snapshot && ((this.runtime?.digest ?? null) !== (snapshot.daemonRuntime?.digest ?? null))) {
      throw new Error("Owner recovery runtime identity does not match the persisted owner; use the exact same Rollbridge runtime.")
    }

    const guardianIdentity = recovery?.guardian || {
      socketPath: `${this.statePath}.guardian.sock`,
      token: crypto.randomBytes(32).toString("hex")
    }
    this.guardianIdentity = guardianIdentity
    this.guardian = new GuardianClient(guardianIdentity)
    if (recovery) await this.guardian.connect()
    else {
      await this.guardian.launch()
      guardianIdentity.pid = this.guardian.pid
    }
    await this.guardian.claimOwner(this.config.ownerRecovery?.reconnectGraceMs ?? 30000, this.ownerAuthority())
    this.watchOwnerReplacementEvents()

    if (snapshot) {
      if (!Array.isArray(snapshot.releases) || (snapshot.activeReleaseId !== null && typeof snapshot.activeReleaseId !== "string")) {
        throw new Error("Owner recovery state is partial or corrupt; active release metadata is required.")
      }
      let recoveryConfig = this.config
      let releaseConfigs = /** @type {Record<string, import("./config.js").RollbridgeConfig>} */ ({})
      let singletonReleaseIds = snapshot.singletonReleaseIds || /** @type {Record<string, string>} */ ({})
      let recoverySnapshot = snapshot

      if ((recovery?.format ?? 0) >= 2) {
        const ownerState = /** @type {PrivateOwnerState} */ (await this.guardian.ownerState())

        if (!ownerState?.config || !ownerState.releaseConfigs || !ownerState.snapshot) {
          throw new Error("Durable guardian state is missing exact release definitions; refusing partial owner recovery.")
        }
        recoveryConfig = ownerState.config
        releaseConfigs = ownerState.releaseConfigs
        singletonReleaseIds = ownerState.singletonReleaseIds || singletonReleaseIds
        const guardianTransitionAt = Date.parse(ownerState.snapshot.generationTransition?.updatedAt || "")
        const persistedTransitionAt = Date.parse(snapshot.generationTransition?.updatedAt || "")

        if (Number.isFinite(guardianTransitionAt) && (!Number.isFinite(persistedTransitionAt) || guardianTransitionAt > persistedTransitionAt)) {
          recoverySnapshot = ownerState.snapshot
        }
      }
      await this.restoreOwnerState(recoverySnapshot, {config: recoveryConfig, releaseConfigs, resumeDrains: false, singletonReleaseIds})
      this.persistenceEnabled = true
      await this.guardian.reconcileInventory()
      if (this.generationTransition && this.generationTransition.phase !== "committed" && !this.generationTransition.error) {
        try {
          await this.resumeGenerationTransition()
        } catch (error) {
          this.logger("release generation transition recovery failed", {error: error instanceof Error ? error.message : String(error), releaseId: this.generationTransition.candidateReleaseId})
        }
      }
      for (const release of this.releases.values()) {
        if (release.state === "draining" && this.shouldResumeDrain(release)) void this.drainAndPrune(release, release.config)
      }
    }
    else {
      this.persistenceEnabled = true
      await this.persistState({throwOnError: true})
    }
    this.stateCleanupEnabled = true
    await this.publishOwnerState()
  }

  /** @returns {string} Stable identity for same-authority recovery. */
  ownerRecoveryConfigDigest() {
    return ownerConfigDigest(this.config)
  }

  /** Installs event-driven drain fencing for the next prepared owner transaction. */
  watchOwnerReplacementEvents() {
    if (!this.guardian) throw new Error("Owner replacement event fencing requires the durable guardian")
    this.guardian.onEvent("replacement-prepared", () => {
      for (const release of this.releases.values()) release.pauseDrainForOwnerHandoff()
    })
    this.guardian.onEvent("replacement-aborted", () => {
      if (this.listenerHandoff || this.ownerRetired) return
      for (const release of this.releases.values()) {
        release.resumeDrainAfterOwnerHandoff()
        if (release.state === "draining" && this.shouldResumeDrain(release)) void this.drainAndPrune(release, release.config)
      }
    })
  }

  /** @returns {{configDigest: string, runtime: import("./daemon-runtime.js").DaemonRuntimeIdentity | null}} Exact authority fence. */
  ownerAuthority() {
    return {configDigest: this.ownerRecoveryConfigDigest(), runtime: this.runtime ? {...this.runtime} : null}
  }

  /**
   * @param {OwnerRecoverySnapshot} snapshot - Validated persisted owner state.
   * @param {object} [options] - Recovery definition options.
   * @param {import("./config.js").RollbridgeConfig} [options.config] - Owner config for daemon-wide processes.
   * @param {Record<string, import("./config.js").RollbridgeConfig>} [options.releaseConfigs] - Exact generation configs.
   * @param {boolean} [options.resumeDrains] - Whether to resume draining generations immediately.
   * @param {Record<string, string>} [options.singletonReleaseIds] - Exact release owner for each singleton registration.
   * @param {boolean} [options.synchronizeLifecycleRoles] - Whether the caller owns guardian role mutation authority.
   */
  async restoreOwnerState(snapshot, {config = this.config, releaseConfigs = /** @type {Record<string, import("./config.js").RollbridgeConfig>} */ ({}), resumeDrains = true, singletonReleaseIds = snapshot.singletonReleaseIds || /** @type {Record<string, string>} */ ({}), synchronizeLifecycleRoles = true} = {}) {
    if (!Array.isArray(snapshot.releases) || (snapshot.activeReleaseId !== null && typeof snapshot.activeReleaseId !== "string")) {
      throw new Error("Owner recovery state is partial or corrupt; active release metadata is required.")
    }
    this.generationTransition = snapshot.generationTransition ? {...snapshot.generationTransition} : undefined
    if (snapshot.activeReleaseId === null && snapshot.releases.length === 0) return
    if (!this.bootstrap) this.bootstrap = snapshot.bootstrap ? {...snapshot.bootstrap} : undefined
    this.ownerTransition = snapshot.ownerTransition ? {...snapshot.ownerTransition} : undefined
    const singletonOwnerReleaseIds = new Set(Object.values(singletonReleaseIds))

    for (const releaseStatus of snapshot.releases) {
      const transitionCandidate = this.generationTransition?.candidateReleaseId === releaseStatus.releaseId && this.generationTransition.phase !== "committed"
      const singletonOwner = singletonOwnerReleaseIds.has(releaseStatus.releaseId)

      if (releaseStatus.state !== "active" && releaseStatus.state !== "draining" && !transitionCandidate && !singletonOwner) continue
      const release = new ReleaseGroup({
        config: releaseConfigs[releaseStatus.releaseId] || config,
        logger: this.logger,
        portReservations: this.portReservations,
        processFactory: (key, definition) => this.guardianProcess(key, definition),
        releaseId: releaseStatus.releaseId,
        releasePath: releaseStatus.releasePath,
        revision: releaseStatus.revision,
        servicePorts: this.servicePorts,
        shouldStart: () => !this.stopping
      })

      await release.restore(releaseStatus, {synchronizeLifecycleRole: synchronizeLifecycleRoles})
      this.releases.set(release.releaseId, release)
      if (release.releaseId === snapshot.activeReleaseId) this.activeRelease = release
    }

    if (snapshot.activeReleaseId !== null && !this.activeRelease) throw new Error(`Owner recovery state does not contain active release ${snapshot.activeReleaseId}.`)
    const committedBootstrapRelease = this.committedBootstrapRelease()
    const definitionRelease = this.activeRelease || committedBootstrapRelease || [...this.releases.values()].at(-1)
    if (!definitionRelease) throw new Error("Owner recovery state has no release definition for owned processes.")
    if (!this.activeRelease && !committedBootstrapRelease && snapshot.singletons.length > 0) throw new Error("Owner recovery state has release-owned singletons without an active release identity.")
    for (const serviceStatus of snapshot.services) {
      const processConfig = config.processes.find((candidate) => candidate.id === serviceStatus.id && candidate.policy === "service" && candidate.deployStrategy !== "handoff")

      if (!processConfig) throw new Error(`Owner recovery state contains unknown service ${serviceStatus.id}.`)
      const service = definitionRelease.buildProcess(processConfig, {guardianKey: `service:${serviceStatus.id}`, shouldRestart: () => !this.stopping})

      await this.recoverGuardianProcess(service)
      this.services.set(serviceStatus.id, service)
      if (definitionRelease.ports[serviceStatus.id] !== undefined) {
        const port = definitionRelease.ports[serviceStatus.id]

        if (this.portReservations.has(port)) throw new Error(`Persisted daemon service ${serviceStatus.id} port ${port} is already reserved by a live generation`)
        this.portReservations.add(port)
        this.servicePorts[serviceStatus.id] = port
      }
    }
    for (const singletonStatus of snapshot.singletons) {
      const singletonReleaseId = singletonReleaseIds[singletonStatus.id] || definitionRelease.releaseId
      const singletonRelease = this.releases.get(singletonReleaseId)

      if (!singletonRelease) throw new Error(`Owner recovery state contains singleton ${singletonStatus.id} for unknown release ${singletonReleaseId}.`)
      const processConfig = singletonRelease.config.processes.find((candidate) => candidate.id === singletonStatus.id && candidate.policy === "singleton")

      if (!processConfig) throw new Error(`Owner recovery state contains unknown singleton ${singletonStatus.id} for release ${singletonReleaseId}.`)
      const singleton = singletonRelease.buildProcess(processConfig, {guardianKey: `singleton:${singletonReleaseId}:${singletonStatus.id}`})

      await this.recoverGuardianProcess(singleton)
      this.singletons.set(singletonStatus.id, singleton)
      this.singletonReleaseIds.set(singletonStatus.id, singletonReleaseId)
    }
    for (const release of this.releases.values()) {
      if (resumeDrains && release.state === "draining" && this.shouldResumeDrain(release)) void this.drainAndPrune(release, release.config)
    }
    this.logger("owner state recovered", {activeReleaseId: this.activeRelease?.releaseId ?? null, releases: this.releases.size})
  }

  /** Publishes full normalized definitions only over the authenticated guardian channel. */
  async publishOwnerState() {
    if (!this.guardian) return
    await this.guardian.publishOwnerState({
      authority: this.ownerAuthority(),
      config: this.config,
      releaseConfigs: Object.fromEntries([...this.releases].map(([releaseId, release]) => [releaseId, release.config])),
      singletonReleaseIds: Object.fromEntries(this.singletonReleaseIds),
      snapshot: this.status()
    })
  }

  /**
   * Prepares from private guardian state, starts listeners, then asks the committed owner
   * to atomically fence itself and transfer authority.
   */
  async replaceIncompatibleOwner() {
    if (!this.statePath || !this.config.ownerRecovery) throw new Error("Atomic owner replacement requires ownerRecovery and the same statePath transaction anchor")
    this.controlCommandsReady = false
    const state = await readState(this.statePath)
    const persisted = state && typeof state === "object" && !Array.isArray(state) ? /** @type {OwnerRecoverySnapshot} */ (state) : undefined

    if (!persisted?.recovery?.guardian) throw new Error(`No committed durable owner transaction was found at ${this.statePath}`)
    this.guardianIdentity = persisted.recovery.guardian
    this.guardian = new GuardianClient(this.guardianIdentity)
    await this.guardian.connect()
    this.watchOwnerReplacementEvents()
    const persistedAuthority = {
      configDigest: persisted.recovery.configDigest,
      runtime: persisted.daemonRuntime ? {...persisted.daemonRuntime} : null
    }
    const replacementProtocol = await this.guardian.ownerReplacementProtocol()
    const legacyBridge = replacementProtocol === "legacy"
      ? await this.prepareLegacyOwnerReplacement({persisted, persistedAuthority})
      : undefined
    const prepared = legacyBridge?.prepared ?? await this.guardian.prepareOwnerReplacement(persistedAuthority, this.ownerAuthority())
    let preparedStatus
    let reservedProcessKey
    let transfer

    try {
      preparedStatus = await this.guardian.replacementStatus()
      transfer = /** @type {PrivateOwnerState} */ (prepared.ownerState)
      if (!transfer?.config || !transfer.snapshot) throw new Error("Committed owner published incomplete replacement state")
      const registeredProcesses = new Map((await this.guardian.inventory()).map(({key, provenance}) => [key, provenance]))

      reservedProcessKey = legacyBridge ? undefined : reconstructableOwnerSnapshotProcessKeys(transfer.snapshot, transfer.singletonReleaseIds)
        .find((key) => registeredProcesses.has(key))
      if (reservedProcessKey) this.guardian.reserveProcessRecovery(reservedProcessKey, /** @type {string} */ (registeredProcesses.get(reservedProcessKey)))
      await this.restoreOwnerState(transfer.snapshot, {config: transfer.config, releaseConfigs: transfer.releaseConfigs, resumeDrains: false, singletonReleaseIds: transfer.singletonReleaseIds, synchronizeLifecycleRoles: false})
    } catch (error) {
      legacyBridge?.incumbentControl?.close()
      if (legacyBridge) {
        try {
          await this.abandonLegacyOwnerBridge(legacyBridge)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Legacy owner replacement reconstruction failed and its upgrade coordinator could not be abandoned", {cause: cleanupError})
        }
      } else {
        this.guardian.disconnect()
      }
      throw error
    }
    for (const release of this.releases.values()) release.preserveConfigOnRetirement = true
    this.logger("owner replacement candidate prepared", {activeReleaseId: this.activeRelease?.releaseId ?? null, replacementId: prepared.replacementId})

    let committedAuthority = false
    let stagingControlPath
    let finalControlPublished = false
    let listenersYielded = false
    let retiredIncumbentControl = false
    let retainIncumbentControl = false
    let incumbentControl = legacyBridge?.incumbentControl
    let committed = /** @type {Promise<Error | undefined> | undefined} */ (undefined)

    try {
      if (this.config.control.path !== transfer.snapshot.control.path) {
        const finalSocket = await inspectControlSocket(this.config.control.path)

        if (finalSocket.alive) throw new Error(`Owner replacement final control socket ${this.config.control.path} already answers another live process`)
        try {
          await fs.lstat(this.config.control.path)
          throw new Error(`Owner replacement final control socket ${this.config.control.path} already exists; refusing to replace it`)
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
        }
      }

      stagingControlPath = `${this.config.control.path}.replacement-${process.pid}`
      await this.startControlServer(stagingControlPath)
      const sharedFixedProxy = this.config.proxy.port !== 0 &&
        transfer.snapshot.proxy.host === this.config.proxy.host && transfer.snapshot.proxy.port === this.config.proxy.port

      if (!sharedFixedProxy) await this.startProxy()
      if (legacyBridge) {
        await this.crossLegacyDisruptiveBoundary(legacyBridge)
      } else if (preparedStatus.ownerClaimed) {
        try {
          incumbentControl = await openControlSession(transfer.snapshot.control.path)
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
          retiredIncumbentControl = true
        }
        if (incumbentControl) {
          const listenerSession = incumbentControl

          if (reservedProcessKey) await this.guardian.recoverReservedProcess(reservedProcessKey)
          incumbentControl.onEvent((event) => this.handleIncumbentListenerEvent(event, listenerSession))
          await incumbentControl.request({
            command: "yield-owner-listeners",
            control: transfer.snapshot.control.path === this.config.control.path,
            proxy: true,
            replacementId: prepared.replacementId
          })
          listenersYielded = true
        }
      }
      if (sharedFixedProxy) await this.startProxy()
      if (!retiredIncumbentControl) {
        await fs.rename(stagingControlPath, this.config.control.path)
        finalControlPublished = true
        this.boundControlPath = this.config.control.path
      }
      committed = this.guardian.waitForEvent("replacement-committed").then(
        () => undefined,
        (error) => error instanceof Error ? error : new Error(String(error))
      )
      const staged = await this.guardian.stageOwnerReplacement(prepared.replacementId, {
        authority: this.ownerAuthority(),
        config: this.config,
        releaseConfigs: Object.fromEntries([...this.releases].map(([releaseId, release]) => [releaseId, release.config])),
        singletonReleaseIds: Object.fromEntries(this.singletonReleaseIds),
        snapshot: this.status()
      })

      if (staged.committed && reservedProcessKey) {
        committedAuthority = true
        await this.guardian.recoverReservedProcess(reservedProcessKey)
      }

      if (!staged.committed) {
        if (retiredIncumbentControl) {
          const processKey = reservedProcessKey

          if (!processKey || !this.guardian.processes.has(processKey)) throw new Error("Retired owner replacement requires an exact reserved process from committed owner state")
          try {
            await this.guardian.commitRetiredOwnerReplacement(prepared.replacementId, processKey)
            committedAuthority = true
            await this.guardian.recoverReservedProcess(processKey)
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "Guardian commit-retired-owner-replacement requires the committed owner") throw error
            throw new Error(
              "Cannot safely complete atomic owner replacement through the older retained guardian while the incumbent control socket is absent; incumbent owner and connections were preserved",
              {cause: error}
            )
          }
        } else {
          try {
            if (!incumbentControl) throw new Error("Owner replacement incumbent control session is unavailable")
            await incumbentControl.request({command: "commit-owner-replacement", replacementId: prepared.replacementId})
          } catch (error) {
            const status = await this.guardian.replacementStatus()

            if (status.committedReplacementId !== prepared.replacementId || !status.ownerClaimed) throw error
            this.logger("owner replacement commit response lost; guardian commit confirmed", {replacementId: prepared.replacementId})
          }
        }
      }
      const commitmentError = await committed

      if (commitmentError) throw commitmentError
      committedAuthority = true
      if (retiredIncumbentControl) {
        await fs.rename(stagingControlPath, this.config.control.path)
        finalControlPublished = true
        this.boundControlPath = this.config.control.path
      }
      await Promise.all([...this.releases.values()].map((release) => release.synchronizeLifecycleRoles()))
      if (!legacyBridge && incumbentControl && [...this.releases.values()].some((release) => release.hasTransferredConnections())) {
        this.incumbentListenerControl = incumbentControl
        retainIncumbentControl = true
      }
      for (const release of this.releases.values()) {
        if (release.state === "draining" && this.shouldResumeDrain(release)) void this.drainAndPrune(release, release.config)
      }
      this.startStatePersistence()
      await this.persistState({throwOnError: true})
      await this.publishOwnerState()
      this.controlCommandsReady = true
      this.logger("owner replacement committed", {replacementId: prepared.replacementId})
    } catch (error) {
      if (committedAuthority) {
        this.logger("owner replacement post-commit finalization failed", {error: error instanceof Error ? error.message : String(error), replacementId: prepared.replacementId})
        throw error
      }
      await this.closeServer(this.controlServer)
      await this.closeServer(this.proxyServer)
      if (finalControlPublished) await this.removeControlSocket()
      else if (stagingControlPath) await fs.rm(stagingControlPath, {force: true})
      let abortError

      if (listenersYielded && incumbentControl) {
        try {
          await incumbentControl.request({command: "abort-owner-listener-handoff", replacementId: prepared.replacementId})
        } catch (failure) {
          abortError = failure instanceof Error ? failure : new Error(String(failure))
        }
      }
      if (legacyBridge && !legacyBridge.boundaryCrossed) {
        try {
          await this.abandonLegacyOwnerBridge(legacyBridge)
        } catch (failure) {
          abortError = failure instanceof Error ? failure : new Error(String(failure))
        }
      } else {
        this.guardian.disconnect()
        legacyBridge?.legacyGuardian.disconnect()
      }
      if (committed) {
        const commitmentError = await committed

        if (commitmentError && commitmentError !== error && commitmentError.message !== "Process guardian connection closed") {
          abortError = commitmentError
        }
      }
      incumbentControl?.close()
      if (legacyBridge?.boundaryCrossed) {
        this.logger("legacy disruptive owner replacement failed after incumbent exit", {
          error: error instanceof Error ? error.message : String(error),
          recoveryStatePath: this.statePath,
          replacementId: prepared.replacementId
        })
      }
      if (abortError) throw new AggregateError([error, abortError], `Owner replacement failed and recovery cleanup failed: ${abortError.message}`, {cause: error})
      throw error
    } finally {
      if (!retainIncumbentControl) incumbentControl?.close()
    }
  }

  /**
   * Applies authenticated live-connection state from the retired listener owner.
   * @param {Record<string, JsonValue>} event - Incumbent control event.
   * @param {{close: () => void}} session - Exact incumbent session.
   */
  handleIncumbentListenerEvent(event, session) {
    if (event.event !== "owner-connection-state") return
    const releaseId = stringOrUndefined(event.releaseId)
    const connections = event.connections

    if (!releaseId || !connections || typeof connections !== "object" || Array.isArray(connections)) {
      throw new Error("Incumbent listener sent invalid connection state")
    }
    const transferredConnections = {
      http: requiredNonNegativeInteger(connections.http, "connections.http"),
      websocket: requiredNonNegativeInteger(connections.websocket, "connections.websocket")
    }
    const release = this.releases.get(releaseId)

    if (!release && (transferredConnections.http > 0 || transferredConnections.websocket > 0)) throw new Error(`Incumbent listener reported unknown release ${releaseId}`)
    if (release) release.setTransferredConnections(transferredConnections)
    if (this.incumbentListenerControl === session && ![...this.releases.values()].some((candidate) => candidate.hasTransferredConnections())) {
      this.incumbentListenerControl = undefined
      session.close()
    }
  }

  /**
   * Authenticates and prepares the one-time disruptive bridge for an exact legacy guardian protocol.
   * @param {{persisted: OwnerRecoverySnapshot, persistedAuthority: {configDigest: string, runtime: import("./daemon-runtime.js").DaemonRuntimeIdentity | null}}} options - Legacy evidence.
   * @returns {Promise<LegacyOwnerBridge>} Prepared bridge.
   */
  async prepareLegacyOwnerReplacement({persisted, persistedAuthority}) {
    const legacyProcessKey = ownerSnapshotProcessKeys(persisted, persisted.singletonReleaseIds)[0]
    const legacyGuardian = this.guardian
    let legacyPrepared

    if (!legacyProcessKey) throw new Error("Legacy disruptive owner replacement requires an exact guardian-owned process registration in durable state")
    if (!legacyGuardian) throw new Error("Legacy disruptive replacement is missing its authenticated guardian connection")
    try {
      legacyPrepared = await legacyGuardian.prepareOwnerReplacement(persistedAuthority, this.ownerAuthority())
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error)

      if (!isLegacyGuardianPrepareDiagnostic(diagnostic)) throw error
      let probeAccepted = false

      try {
        await legacyGuardian.request({
          authority: persistedAuthority,
          command: "prepare-owner-replacement",
          key: legacyProcessKey,
          nextAuthority: this.ownerAuthority()
        })
        probeAccepted = true
      } catch (probeError) {
        if (!(probeError instanceof Error) || probeError.message !== "Unknown guardian command: prepare-owner-replacement") {
          throw new Error("Guardian does not match the authenticated pre-split replacement protocol signature", {cause: probeError})
        }
      }
      if (probeAccepted) throw new Error("Legacy guardian protocol probe unexpectedly accepted owner replacement", {cause: error})
    }
    let incumbentControl
    let upgraded

    try {
      if (persisted.recovery.configDigest !== this.ownerRecoveryConfigDigest()) {
        throw new Error("The one-time legacy guardian bridge requires the incumbent config identity unchanged; retry the config change after the bridge establishes split-3 authority")
      }
      if (!this.legacyIncumbentPid) throw new Error("The authenticated legacy guardian requires an exact incumbent PID from ensure-daemon for the disruptive bridge")
      if (!this.guardianIdentity?.pid) throw new Error("The authenticated legacy guardian state is missing its exact guardian PID")
      await verifyLegacyGuardianProcess(this.guardianIdentity.pid, this.guardianIdentity.socketPath)
      const incumbentStartTime = await verifyLegacyDaemonProcess(this.legacyIncumbentPid, this.configPath, persisted.control.path)
      if (legacyPrepared) assertLegacyPrivateOwnerState(legacyPrepared.ownerState, persisted, persistedAuthority)
      try {
        incumbentControl = await openControlSession(persisted.control.path)
      } catch (error) {
        if (!legacyPrepared || !error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
      }
      if (incumbentControl) {
        const incumbentStatus = await incumbentControl.request({command: "status"})

        assertLegacyIncumbentStatus(incumbentStatus, persisted)
      }
      const ownerState = legacyPrepared
        ? legacyPrepared.ownerState
        : {
            authority: persistedAuthority,
            config: this.config,
            releaseConfigs: Object.fromEntries(persisted.releases.map((release) => [release.releaseId, this.config])),
            singletonReleaseIds: Object.fromEntries(persisted.singletons.map((singleton) => [singleton.id, persisted.activeReleaseId]).filter((entry) => entry[1] !== null)),
            snapshot: persisted
          }
      const legacyInventory = normalizeLegacyGuardianInventory(await legacyGuardian.inventory())

      assertLegacyGuardianInventoryMembership(legacyInventory, /** @type {PrivateOwnerState} */ (ownerState))
      const upgradedIdentity = /** @type {{pid?: number, socketPath: string, token: string}} */ ({
        socketPath: `${this.statePath}.split3-guardian.sock`,
        token: crypto.randomBytes(32).toString("hex")
      })

      await assertPathAbsent(upgradedIdentity.socketPath, "Legacy upgrade guardian socket")
      upgraded = await legacyGuardian.upgradeLegacyGuardian({ownerState, ...upgradedIdentity})
      upgradedIdentity.pid = upgraded.pid
      this.guardian = upgraded
      this.guardianIdentity = upgradedIdentity
      const prepared = await upgraded.prepareOwnerReplacement(persistedAuthority, this.ownerAuthority())
      const recoverySnapshot = /** @type {OwnerRecoverySnapshot} */ ({
        ...persisted,
        recovery: {...persisted.recovery, guardian: upgradedIdentity}
      })

      this.logger("legacy owner replacement bridge prepared", {
        guardianPid: upgradedIdentity.pid ?? null,
        incumbentPid: this.legacyIncumbentPid,
        replacementId: prepared.replacementId
      })
      return {boundaryCrossed: false, incumbentControl, incumbentStartTime, legacyGuardian, legacyInventory, legacyPrepared, legacySnapshot: persisted, prepared, recoverySnapshot}
    } catch (upgradeError) {
      incumbentControl?.close()
      let cleanupError

      if (upgraded) {
        try {
          await upgraded.abandonLegacyUpgrade()
        } catch (error) {
          cleanupError = error instanceof Error ? error : new Error(String(error))
        }
      }
      legacyGuardian.disconnect()
      if (cleanupError) {
        throw new AggregateError([upgradeError, cleanupError], "Legacy owner replacement validation failed and its upgrade coordinator could not be abandoned", {cause: upgradeError})
      }
      throw upgradeError
    }
  }

  /**
   * Abandons the uncommitted coordinator before releasing the incumbent guardian transaction.
   * @param {LegacyOwnerBridge} bridge - Prepared bridge.
   */
  async abandonLegacyOwnerBridge(bridge) {
    let cleanupError

    try {
      await this.guardian?.abandonLegacyUpgrade()
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error))
    }
    bridge.legacyGuardian.disconnect()
    if (cleanupError) throw cleanupError
  }

  /**
   * Crosses the explicitly disruptive legacy-only boundary after candidate reconstruction.
   * @param {LegacyOwnerBridge} bridge - Prepared bridge.
   */
  async crossLegacyDisruptiveBoundary(bridge) {
    if (!this.legacyIncumbentPid || !this.statePath) throw new Error("Legacy disruptive boundary is missing its exact incumbent identity")
    if (!this.guardian) throw new Error("Legacy disruptive boundary is missing its authenticated upgraded guardian")
    if (!bridge.legacyGuardian.pid) throw new Error("Legacy disruptive boundary is missing its authenticated retained guardian PID")
    await verifyLegacyGuardianProcess(bridge.legacyGuardian.pid, bridge.legacyGuardian.socketPath)
    const currentStartTime = await verifyLegacyDaemonProcess(this.legacyIncumbentPid, this.configPath, bridge.recoverySnapshot.control.path)

    if (currentStartTime !== bridge.incumbentStartTime) throw new Error("Legacy incumbent PID identity changed before the disruptive boundary")
    if (!isDeepStrictEqual(await readState(this.statePath), bridge.legacySnapshot)) {
      throw new Error("Legacy owner recovery state changed before the disruptive boundary")
    }
    if (bridge.incumbentControl) {
      assertLegacyIncumbentStatus(await bridge.incumbentControl.request({command: "status"}), bridge.legacySnapshot)
    }
    const currentInventory = normalizeLegacyGuardianInventory(await bridge.legacyGuardian.inventory())

    if (!isDeepStrictEqual(currentInventory, bridge.legacyInventory)) {
      throw new Error("Legacy guardian process inventory changed before the disruptive boundary")
    }
    const candidateOwnerState = {
      authority: this.ownerAuthority(),
      config: this.config,
      releaseConfigs: Object.fromEntries([...this.releases].map(([releaseId, release]) => [releaseId, release.config])),
      singletonReleaseIds: Object.fromEntries(this.singletonReleaseIds),
      snapshot: this.status()
    }

    assertLegacyGuardianInventoryMembership(currentInventory, candidateOwnerState)
    let legacyCommitted

    if (bridge.legacyPrepared) {
      const status = await bridge.legacyGuardian.replacementStatus()

      if (!status.ownerClaimed) throw new Error("Legacy guardian incumbent ownership changed before the disruptive boundary")
      legacyCommitted = bridge.legacyGuardian.waitForEvent("replacement-committed")
      const staged = await bridge.legacyGuardian.stageOwnerReplacement(bridge.legacyPrepared.replacementId, candidateOwnerState)

      if (staged.committed) throw new Error("Legacy guardian committed replacement before the authenticated disruptive boundary")
    }
    this.logger("legacy owner replacement disruptive boundary", {
      disruptive: true,
      incumbentPid: this.legacyIncumbentPid,
      reason: "retained guardian and daemon lacked atomic replacement protocol"
    })
    await this.guardian.beginLegacyOwnerClaim(bridge.prepared.replacementId, bridge.recoverySnapshot.recovery.reconnectGraceMs)
    process.kill(this.legacyIncumbentPid, "SIGKILL")
    bridge.boundaryCrossed = true
    await bridge.incumbentControl?.closed()
    if (legacyCommitted) await legacyCommitted
    bridge.legacyGuardian.disconnect()
    await this.guardian.completeLegacyOwnerClaim(bridge.prepared.replacementId)
    await writeState(this.statePath, bridge.recoverySnapshot)
    this.ownerTransition = /** @type {OwnerTransition} */ ({
      disruptive: true,
      mode: "legacy-first-upgrade",
      reason: "retained guardian and daemon lacked atomic replacement protocol"
    })
  }

  /**
   * @param {string} key - Guardian key.
   * @param {Parameters<GuardianClient["process"]>[1]} definition - Process definition.
   * @returns {import("./managed-process.js").default} Guardian-backed managed process.
   */
  guardianProcess(key, definition) {
    if (!this.guardian) throw new Error("Process guardian is not initialized")
    return this.guardian.process(key, definition)
  }

  /** @param {import("./managed-process.js").default} processInstance - Guardian-backed process. */
  async recoverGuardianProcess(processInstance) {
    if (!("recover" in processInstance) || typeof processInstance.recover !== "function") throw new Error(`Managed process ${processInstance.id} is not guardian-backed`)
    await processInstance.recover()
  }

  /** Releases only resources created by a fenced startup loser. */
  async abandonOwnerRecoveryAttempt() {
    this.guardian?.disconnect()
    await this.closeServer(this.proxyServer)
  }

  /** @returns {Promise<void>} Exposes control commands and begins periodic state persistence. */
  async exposeControl() {
    if (this.stopping) throw new Error("Rollbridge is shutting down")

    await this.startControlServer()

    if (this.stopping) {
      await this.closeServer(this.controlServer)
      await fs.rm(this.config.control.path, {force: true})
      throw new Error("Rollbridge is shutting down")
    }

    this.startStatePersistence()
  }

  /**
   * @returns {Promise<void>} Starts the stable local proxy.
   */
  async startProxy() {
    const server = http.createServer((request, response) => this.proxyHttp(request, response))

    server.on("upgrade", (request, socket, head) => this.proxyWebSocket(request, socket, head))
    this.proxyServer = server

    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen({host: this.config.proxy.host, port: this.config.proxy.port}, () => {
        const address = server.address()
        this.proxyPort = address && typeof address === "object" ? address.port : this.config.proxy.port
        this.logger("proxy listening", {host: this.config.proxy.host, port: this.proxyPort})
        resolve(undefined)
      })
    })
  }

  /**
   * @param {string} [socketPath] - Socket path to bind.
   * @param {boolean} [applyMetadata] - Whether to apply configured mode and ownership.
   * @returns {Promise<void>} Starts the control socket.
   */
  async startControlServer(socketPath = this.config.control.path, applyMetadata = true) {
    const server = net.createServer((socket) => this.handleControlSocket(socket))

    this.controlServer = server
    await this.prepareControlSocketPath(socketPath)

    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, () => {
        this.controlSocketOwned = true
        this.boundControlPath = socketPath
        this.logger("control socket listening", {path: socketPath})
        resolve(undefined)
      })
    })

    if (applyMetadata) await this.applyControlSocketMetadata(socketPath)
  }

  /**
   * @param {string} socketPath - Bound socket path.
   * @returns {Promise<void>} Metadata application completion.
   */
  async applyControlSocketMetadata(socketPath) {
    if (this.config.control.mode !== undefined) await fs.chmod(socketPath, this.config.control.mode)
    await this.applyControlSocketOwnership(socketPath)
  }

  /**
   * Applies control.owner/control.group to the bound socket via chown, resolving names to ids.
   * @param {string} [socketPath] - Bound socket path.
   * @returns {Promise<void>} Resolves once ownership is applied (no-op when neither is set).
   */
  async applyControlSocketOwnership(socketPath = this.config.control.path) {
    const {group, owner} = this.config.control

    if (owner === undefined && group === undefined) return

    // -1 leaves the uid/gid unchanged (POSIX chown semantics).
    const uid = owner === undefined ? -1 : resolveUserId(owner)
    const gid = group === undefined ? -1 : resolveGroupId(group)

    try {
      await fs.chown(socketPath, uid, gid)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)

      throw new Error(`Could not set control socket owner/group on ${socketPath}: ${reason}. Run the daemon as a user allowed to chown it (for example root, or a member of the target group).`, {cause: error})
    }
  }

  /**
   * @param {string} [socketPath] - Socket path to inspect and prepare.
   * @returns {Promise<void>} Removes a stale Unix socket before binding, or fails clearly when a daemon is alive.
   */
  async prepareControlSocketPath(socketPath = this.config.control.path) {
    const existing = await inspectControlSocket(socketPath)

    if (existing.alive) {
      throw new Error(controlSocketBusyMessage(socketPath, existing))
    }

    try {
      await fs.rm(socketPath, {force: true})
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
      throw error
    }
  }

  /**
   * @param {http.IncomingMessage} request - Client request.
   * @param {http.ServerResponse} response - Client response.
   * @returns {void}
   */
  proxyHttp(request, response) {
    const release = this.activeRelease

    if (!release) {
      response.writeHead(503, {"Content-Type": "text/plain; charset=utf-8"})
      response.end("No active release\n")
      return
    }

    const {target} = release.proxyTarget()
    const releaseConnection = release.retainConnection("http")
    let released = false
    const done = () => {
      if (released) return

      released = true
      releaseConnection()
    }

    response.once("finish", done)
    response.once("close", done)
    this.proxy.web(request, response, {target})
  }

  /**
   * @param {http.IncomingMessage} request - Client request.
   * @param {import("node:stream").Duplex} socket - Client socket.
   * @param {Buffer} head - Upgrade head.
   * @returns {void}
   */
  proxyWebSocket(request, socket, head) {
    const release = this.activeRelease

    if (!release) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n")
      return
    }

    const {target} = release.proxyTarget()
    const releaseConnection = release.retainConnection("websocket")
    socket.once("close", releaseConnection)
    this.proxy.ws(request, socket, head, {target})
  }

  /**
   * @param {Error} error - Proxy error.
   * @param {http.IncomingMessage} _request - Client request.
   * @param {http.ServerResponse | import("node:net").Socket} response - Response or socket.
   * @returns {void}
   */
  onProxyError(error, _request, response) {
    this.logger("proxy error", {error: error.message})

    if ("writeHead" in response && !response.headersSent) {
      response.writeHead(502, {"Content-Type": "text/plain; charset=utf-8"})
      response.end("Bad gateway\n")
      return
    }

    if ("destroy" in response) {
      response.destroy()
    }
  }

  /**
   * @param {import("node:net").Socket} socket - Control socket.
   * @returns {void}
   */
  handleControlSocket(socket) {
    this.controlSockets.add(socket)
    socket.setEncoding("utf8")
    let buffer = ""

    socket.once("close", () => this.controlSockets.delete(socket))
    socket.on("error", (error) => {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null

      this.logger("control connection error", {code, error: error.message})
    })

    socket.on("data", (chunk) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf("\n")

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        this.handleControlLine(line, socket)
        newlineIndex = buffer.indexOf("\n")
      }
    })
  }

  /**
   * @param {string} line - JSON command line.
   * @param {import("node:net").Socket} socket - Control socket.
   * @returns {void}
   */
  handleControlLine(line, socket) {
    const closesConnection = isShutdownControlLine(line)
    const respond = (/** @type {Record<string, JsonValue>} */ response) => {
      const payload = `${JSON.stringify(response)}\n`

      if (closesConnection) {
        socket.end(payload, () => socket.destroy())
      } else if (!socket.destroyed) {
        socket.write(payload)
      }
    }

    this.executeControlLine(line, socket)
      .then((response) => respond({status: "success", ...response}))
      .catch((error) => {
        this.logger("command failed", {error: error instanceof Error ? error.message : String(error)})
        respond({
          error: error instanceof Error ? error.message : String(error),
          status: "error"
        })
      })
  }

  /**
   * @param {string} line - JSON command line.
   * @param {net.Socket} [controlSocket] - Requesting control connection, used only for shutdown completion.
   * @returns {Promise<Record<string, JsonValue>>} Command response.
   */
  async executeControlLine(line, controlSocket) {
    const command = JSON.parse(line)

    if (!command || typeof command !== "object") {
      throw new Error("Control command must be an object")
    }

    const data = /** @type {Record<string, JsonValue>} */ (command)
    const commandName = data.command

    if (!this.controlCommandsReady) throw new Error("Rollbridge replacement candidate is not committed and ready")
    if (this.ownerRetired && commandName !== "status") throw new Error("Rollbridge owner authority has been transferred")

    if (commandName === "deploy") {
      return await this.executeOwnerMutation("deploy", async () => await this.deploy({
          releaseId: stringOrUndefined(data.releaseId),
          releasePath: requiredString(data.releasePath, "releasePath"),
          revision: stringOrUndefined(data.revision)
        }))
    }

    if (commandName === "status") {
      return this.status()
    }

    if (commandName === "events") {
      return {events: this.eventLog.recent(typeof data.limit === "number" ? data.limit : undefined)}
    }

    if (commandName === "stop") {
      return await this.executeOwnerMutation("stop", async () => {
        await this.stopRelease(stringOrUndefined(data.releaseId))
        return this.status()
      })
    }

    if (commandName === "restart") {
      return await this.executeOwnerMutation("restart", async () => await this.restartProcesses({
        policy: stringOrUndefined(data.policy),
        processId: stringOrUndefined(data.processId)
      }))
    }

    if (commandName === "rollback") {
      return await this.executeOwnerMutation("rollback", async () => await this.rollback({releaseId: stringOrUndefined(data.releaseId)}))
    }

    if (commandName === "shutdown") {
      // Stop accepting new control connections before cleanup, but keep this requesting
      // connection open as the completion channel. Waiting for all control connections here
      // would deadlock: server.close() includes the socket awaiting this response.
      await this.shutdown({completionSocket: controlSocket, waitForControlConnections: false})

      return {message: "shutdown"}
    }

    if (commandName === "retire-owner") {
      const attestation = requiredString(data.attestation, "attestation")
      if (!/^sha256:[a-f0-9]{64}$/.test(attestation)) throw new Error("Owner retirement attestation must use the canonical sha256:<64 lowercase hex> format")
      await this.retireOwner({attestation, completionSocket: controlSocket})
      return {message: "owner retired"}
    }

    if (commandName === "commit-owner-replacement") {
      const replacementId = requiredString(data.replacementId, "replacementId")

      if (!this.guardian) throw new Error("Atomic owner replacement requires the durable process guardian")
      let committed = false

      try {
        await this.guardian.commitOwnerReplacement(replacementId)
        committed = true
        await this.retireCommittedOwner(controlSocket)
        await this.guardian.finalizeOwnerReplacement(replacementId)
      } finally {
        if (committed) this.guardian.disconnect()
      }
      return {message: "owner replacement committed"}
    }

    if (commandName === "yield-owner-listeners") {
      await this.yieldOwnerListeners({
        completionSocket: controlSocket,
        control: data.control === true,
        proxy: data.proxy === true,
        replacementId: requiredString(data.replacementId, "replacementId")
      })
      return {message: "owner listeners yielded"}
    }

    if (commandName === "abort-owner-listener-handoff") {
      const replacementId = requiredString(data.replacementId, "replacementId")

      if (!this.listenerHandoff || this.listenerHandoff.replacementId !== replacementId) throw new Error("Owner listener handoff is not the prepared transaction")
      await this.resumeYieldedListeners()
      return {message: "owner listeners resumed"}
    }

    throw new Error(`Unknown command: ${String(commandName)}`)
  }

  /**
   * Runs one owner mutation under the guardian's prepare/commit exclusion fence.
   * @param {string} operation - Mutation diagnostic name.
   * @param {() => Promise<Record<string, JsonValue>>} callback - Mutating operation.
   * @returns {Promise<Record<string, JsonValue>>} Operation result.
   */
  async executeOwnerMutation(operation, callback) {
    if (!this.guardian) return await callback()
    const mutationId = await this.guardian.beginOwnerMutation(operation)
    let result
    let operationError

    try {
      result = await callback()
    } catch (error) {
      operationError = error instanceof Error ? error : new Error(String(error))
    }

    const finalizationErrors = /** @type {Error[]} */ ([])

    try {
      await this.publishOwnerState()
    } catch (error) {
      finalizationErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
    try {
      await this.guardian.endOwnerMutation(mutationId)
    } catch (error) {
      finalizationErrors.push(error instanceof Error ? error : new Error(String(error)))
    }

    if (operationError || finalizationErrors.length > 0) {
      const errors = [...(operationError ? [operationError] : []), ...finalizationErrors]

      if (errors.length === 1) throw errors[0]
      throw new AggregateError(errors, `Owner mutation ${operation} failed: ${errors.map((error) => error.message).join("; ")}`)
    }

    return /** @type {Record<string, JsonValue>} */ (result)
  }

  /**
   * Stops accepting only the listener endpoints that the prepared candidate must bind.
   * Existing proxy connections remain owned by this daemon until they close.
   * @param {{completionSocket?: net.Socket, control: boolean, proxy: boolean, replacementId: string}} options - Handoff request.
   */
  async yieldOwnerListeners({completionSocket, control, proxy, replacementId}) {
    if (!this.guardian) throw new Error("Owner listener handoff requires the durable process guardian")
    if (this.listenerHandoff) throw new Error("Owner listeners are already yielded to a replacement candidate")
    await this.guardian.validateOwnerReplacement(replacementId)
    this.listenerHandoff = {control, proxy, replacementId}
    this.listenerHandoffFailure = undefined

    if (!completionSocket) throw new Error("Owner listener handoff requires its authenticated control session")
    for (const release of this.releases.values()) release.pauseDrainForOwnerHandoff()
    if (proxy) this.proxyClosePromise = this.closeServer(this.proxyServer)
    if (control) {
      this.controlClosePromise = this.closeServer(this.controlServer)
      for (const socket of this.controlSockets) if (socket !== completionSocket) socket.destroy()
      await this.removeControlSocket()
    }
    for (const release of this.releases.values()) {
      const publishConnections = () => {
        if (completionSocket.destroyed) return
        completionSocket.write(`${JSON.stringify({
          connections: release.status().connections,
          event: "owner-connection-state",
          releaseId: release.releaseId
        })}\n`)
      }

      publishConnections()
      if (release.status().connectionCount > 0) release.once("drained", publishConnections)
    }

    const aborted = this.guardian.waitForEvent("replacement-aborted").then(async () => await this.resumeYieldedListeners())
    const retired = this.guardian.waitForEvent("replacement-retired")

    void Promise.race([aborted, retired]).catch((error) => {
      if (this.ownerRetired) return
      this.listenerHandoffFailure = error instanceof Error ? error : new Error(String(error))
      this.logger("owner listener handoff recovery failed", {error: this.listenerHandoffFailure.message, replacementId})
    })
  }

  /** Restores listener endpoints after a prepared candidate aborts before commit. */
  async resumeYieldedListeners() {
    const handoff = this.listenerHandoff

    if (!handoff || this.ownerRetired) return
    for (const release of this.releases.values()) {
      release.resumeDrainAfterOwnerHandoff()
      if (release.state === "draining" && this.shouldResumeDrain(release)) void this.drainAndPrune(release, release.config)
    }
    if (handoff.proxy) {
      await this.startProxy()
    }
    if (handoff.control) {
      await this.startControlServer()
    }
    this.listenerHandoff = undefined
    this.listenerHandoffFailure = undefined
    this.logger("owner listeners resumed", {replacementId: handoff.replacementId})
  }

  /**
   * Starts a new release, switches traffic, and drains the previous release.
   * @param {DeployArgs} args - Deploy args.
   * @returns {Promise<Record<string, JsonValue>>} Deploy result.
   */
  async deploy({releaseId, releasePath, revision}) {
    if (this.stopping) throw new Error("Rollbridge is shutting down")

    const nextConfig = this.configPath ? await loadConfig(this.configPath) : this.config

    this.assertReloadCompatible(nextConfig)

    const newReleaseId = releaseId || revision || new Date().toISOString().replace(/[^0-9]/g, "")
    const transition = this.generationTransition

    if (transition && transition.phase !== "committed") {
      this.assertExactGenerationTransition(transition, {config: nextConfig, releaseId: newReleaseId, releasePath, revision: revision || newReleaseId})
      return await this.resumeGenerationTransition()
    }
    if (transition?.phase === "committed" && transition.candidateReleaseId === newReleaseId && this.activeRelease?.releaseId === newReleaseId) {
      this.assertExactGenerationTransition(transition, {config: nextConfig, releaseId: newReleaseId, releasePath, revision: revision || newReleaseId})
      return {activeReleaseId: newReleaseId, previousReleaseId: transition.previousReleaseId}
    }
    if (transition?.phase === "committed" && !this.activeRelease && this.bootstrap && this.releases.get(transition.candidateReleaseId)?.state === "draining") {
      this.assertExactGenerationTransition(transition, {config: nextConfig, releaseId: newReleaseId, releasePath, revision: revision || newReleaseId})
      this.assertCommittedBootstrapRecoveryReady()
      this.config = nextConfig
      await this.updateGenerationTransition("restoring_committed")
      return await this.resumeGenerationTransition()
    }
    const release = new ReleaseGroup({
      config: nextConfig,
      logger: this.logger,
      portReservations: this.portReservations,
      ...(this.guardian ? {processFactory: (key, definition) => this.guardianProcess(key, definition)} : {}),
      releaseId: newReleaseId,
      releasePath,
      revision,
      servicePorts: this.servicePorts,
      shouldStart: () => !this.stopping
    })

    this.logger("deploy starting", {releaseId: newReleaseId, releasePath, revision})
    const startedServices = /** @type {string[]} */ ([])

    this.startingReleases.add(release)

    try {
      await this.ensureServices(release, startedServices)
      await release.start()
      if (this.stopping) throw new Error("Rollbridge is shutting down")
    } catch (error) {
      this.logger("deploy failed", {error: error instanceof Error ? error.message : String(error), releaseId: newReleaseId})
      await release.stop()
      await this.stopStartedServices(startedServices)
      throw error
    } finally {
      this.startingReleases.delete(release)
    }

    const previousRelease = this.activeRelease

    if (nextConfig.processes.some((processConfig) => processConfig.lifecycle.activateCommand !== undefined)) {
      this.config = nextConfig
      this.releases.set(release.releaseId, release)
      const now = new Date().toISOString()

      this.generationTransition = /** @type {GenerationTransition} */ ({
        candidateReleaseId: release.releaseId,
        candidateReleasePath: release.releasePath,
        candidateRevision: release.revision,
        configDigest: ownerConfigDigest(nextConfig),
        phase: "candidate_ready",
        previousReleaseId: previousRelease?.releaseId ?? null,
        startedAt: now,
        updatedAt: now
      })
      await this.checkpointGenerationTransition()
      return await this.resumeGenerationTransition()
    }

    this.config = nextConfig
    this.releases.set(release.releaseId, release)
    release.activate()
    this.activeRelease = release
    this.logger("traffic switched", {previousReleaseId: previousRelease ? previousRelease.releaseId : null, releaseId: release.releaseId})

    this.refreshServiceDefinitions(release)
    let retirementFailure

    if (previousRelease) {
      try {
        const retirementConfig = previousRelease.preserveConfigOnRetirement ? previousRelease.config : nextConfig

        await previousRelease.beginRetirement(retirementConfig)
        void this.drainAndPrune(previousRelease, retirementConfig)
      } catch (error) {
        retirementFailure = previousRelease.retirementError ?? (error instanceof Error ? error.message : String(error))
        this.logger("release retirement quiescence failed", {error: retirementFailure, releaseId: previousRelease.releaseId})
      }
    }

    await this.replaceSingletons(release)

    await this.persistState()
    await this.publishOwnerState()

    return {
      activeReleaseId: release.releaseId,
      previousReleaseId: previousRelease ? previousRelease.releaseId : null,
      ...(retirementFailure && previousRelease ? {retirement: {error: retirementFailure, releaseId: previousRelease.releaseId, status: "quiescence_failed"}} : {})
    }
  }

  /**
   * Continues one exact durable generation transition without an internal retry loop.
   * @returns {Promise<Record<string, JsonValue>>} Deploy result after commit.
   */
  async resumeGenerationTransition() {
    const transition = this.generationTransition

    if (!transition) throw new Error("No release generation transition to resume")
    const release = this.releases.get(transition.candidateReleaseId)
    const previousRelease = transition.previousReleaseId ? this.releases.get(transition.previousReleaseId) : undefined

    if (!release) throw new Error(`Generation transition candidate ${transition.candidateReleaseId} is not retained`)
    if (transition.previousReleaseId && !previousRelease) throw new Error(`Generation transition previous release ${transition.previousReleaseId} is not retained`)

    if (transition.phase === "candidate_ready") {
      if (previousRelease) await this.updateGenerationTransition("retiring_previous")
      else await this.updateGenerationTransition("previous_retired")
    }

    if (transition.phase === "retiring_previous") {
      try {
        const retirementConfig = previousRelease?.config

        // Every entry into this journaled phase represents one explicit attempt. Reset the
        // process-local acknowledgement cache so exact resume can replay an ambiguous or
        // failed idempotent retirement once; there is no internal retry loop.
        await previousRelease?.beginRetirement(retirementConfig, {retry: true})
      } catch (error) {
        const failure = previousRelease?.retirementError ?? (error instanceof Error ? error.message : String(error))

        await this.failGenerationTransition(failure)
        this.logger("release retirement quiescence failed", {error: failure, releaseId: previousRelease?.releaseId ?? null})
        throw error
      }
      await this.updateGenerationTransition("previous_retired")
    }

    if (transition.phase === "previous_retired") await this.updateGenerationTransition("activating_candidate")

    if (transition.phase === "activating_candidate") {
      try {
        await release.activateGeneration()
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error)

        await this.failGenerationTransition(failure)
        this.logger("release generation activation failed", {error: failure, releaseId: release.releaseId})
        throw error
      }

      // Activation acknowledgement and the logical proxy commit deliberately share one
      // synchronous continuation: no awaited failure boundary may leave jobs active while
      // Rollbridge still points new traffic at the retired generation.
      release.activate()
      this.activeRelease = release
      transition.phase = "committed_pending"
      transition.error = undefined
      transition.updatedAt = new Date().toISOString()
      this.logger("traffic switched", {previousReleaseId: previousRelease?.releaseId ?? null, releaseId: release.releaseId})
    }

    if (transition.phase === "restoring_committed") {
      await this.resumeCommittedBootstrapGeneration(release)
      release.activate()
      this.activeRelease = release
      transition.phase = "committed_pending"
      transition.error = undefined
      transition.updatedAt = new Date().toISOString()
      this.logger("committed bootstrap generation restored", {releaseId: release.releaseId})
    }

    if (transition.phase === "committed_pending") {
      await this.checkpointGenerationTransition()
      this.refreshServiceDefinitions(release)
      if (previousRelease) {
        const retirementConfig = previousRelease.config

        void this.drainAndPrune(previousRelease, retirementConfig)
      }
      try {
        await this.replaceSingletons(release)
      } catch (error) {
        await this.failGenerationTransition(error instanceof Error ? error.message : String(error))
        throw error
      }
      transition.phase = "committed"
      transition.error = undefined
      transition.updatedAt = new Date().toISOString()
      await this.checkpointGenerationTransition()
    }

    return {activeReleaseId: release.releaseId, previousReleaseId: previousRelease?.releaseId ?? null}
  }

  /**
   * @param {GenerationTransition} transition - Pending or committed exact transition.
   * @param {{config: import("./config.js").RollbridgeConfig, releaseId: string, releasePath: string, revision: string}} candidate - Requested identity.
   */
  assertExactGenerationTransition(transition, candidate) {
    if (transition.candidateReleaseId !== candidate.releaseId || transition.candidateReleasePath !== candidate.releasePath || transition.candidateRevision !== candidate.revision || transition.configDigest !== ownerConfigDigest(candidate.config)) {
      throw new Error(`Release generation transition for ${transition.candidateReleaseId} is unresolved at ${transition.phase}; only the exact same release, path, revision, and config authority may resume it`)
    }
  }

  /**
   * Returns the retained candidate only when the foreground bootstrap exactly proves the
   * committed transition that an external owner retirement left without an active role.
   * @returns {ReleaseGroup | undefined} Exact committed bootstrap candidate.
   */
  committedBootstrapRelease() {
    const bootstrap = this.bootstrap
    const transition = this.generationTransition

    if (!bootstrap || !transition || (transition.phase !== "committed" && transition.phase !== "restoring_committed") || transition.candidateReleaseId !== bootstrap.releaseId || transition.candidateReleasePath !== bootstrap.releasePath || transition.candidateRevision !== bootstrap.revision || transition.configDigest !== ownerConfigDigest(this.config)) return undefined
    const release = this.releases.get(bootstrap.releaseId)

    if (!release || release.releasePath !== bootstrap.releasePath || release.revision !== bootstrap.revision) return undefined
    return release
  }

  /**
   * Fails closed before journaling recovery unless external retirement has fully stopped
   * the exact candidate and daemon-owned processes.
   * @returns {void}
   */
  assertCommittedBootstrapRecoveryReady() {
    const release = this.committedBootstrapRelease()

    if (!release) throw new Error("Committed generation has no exact foreground bootstrap recovery proof")
    release.assertCommittedGenerationStopped()
    const ownedProcesses = [
      ...this.services.values(),
      ...this.singletons.values()
    ]
    const stillRetiring = ownedProcesses.find((processInstance) => {
      const {pid, state} = processInstance.status()
      return pid !== undefined || (state !== "stopped" && state !== "failed")
    })

    if (stillRetiring) throw new Error(`Committed generation daemon process ${stillRetiring.id} is still retiring; exact bootstrap recovery will retry after it stops`)
    for (const [singletonId, singletonReleaseId] of this.singletonReleaseIds) {
      if (singletonReleaseId !== release.releaseId) throw new Error(`Committed generation singleton ${singletonId} belongs to retained release ${singletonReleaseId}`)
    }
  }

  /**
   * Resumes a durably journaled committed-candidate restart. Running processes are
   * necessarily owned by this exact recovery phase; stopped processes are restarted.
   * Singleton completion remains in the established committed_pending phase.
   * @param {ReleaseGroup} release - Exact committed candidate.
   * @returns {Promise<void>}
   */
  async resumeCommittedBootstrapGeneration(release) {
    if (this.generationTransition?.phase !== "restoring_committed" || release !== this.committedBootstrapRelease()) {
      throw new Error("Committed bootstrap recovery is not durably journaled for this exact candidate")
    }
    const resumableStates = new Set(["failed", "running", "stopped"])
    const invalidProcess = [...this.services.values(), ...this.singletons.values()].find((processInstance) => {
      const {pid, state} = processInstance.status()
      return !resumableStates.has(state) || (state === "running") !== (pid !== undefined)
    })

    if (invalidProcess) throw new Error(`Committed bootstrap recovery found daemon process ${invalidProcess.id} outside its journaled restart states`)
    release.assertCommittedGenerationRecoverable()

    try {
      for (const processInstance of this.services.values()) {
        await processInstance.start("deploy")
      }
      await release.restartCommittedGeneration()
      await release.activateGeneration()
    } catch (error) {
      await Promise.allSettled([
        release.abortCommittedGenerationRestart(),
        ...[...this.services.values()].map((processInstance) => processInstance.stop())
      ])
      throw error
    }
  }

  /** @param {GenerationTransitionPhase} phase - Durable phase to enter. */
  async updateGenerationTransition(phase) {
    if (!this.generationTransition) throw new Error("No release generation transition to update")
    this.generationTransition.phase = phase
    this.generationTransition.error = undefined
    this.generationTransition.updatedAt = new Date().toISOString()
    await this.checkpointGenerationTransition()
  }

  /** @param {string} error - Exact failed phase diagnostic. */
  async failGenerationTransition(error) {
    if (!this.generationTransition) throw new Error("No release generation transition to fail")
    this.generationTransition.error = error
    this.generationTransition.updatedAt = new Date().toISOString()
    await this.checkpointGenerationTransition()
  }

  /** Persists and publishes the exact transition boundary before another external effect. */
  async checkpointGenerationTransition() {
    // Publish private exact definitions before the public secret-safe state can expose
    // a newer transition authority. A replacement can then reconstruct every guardian
    // registration without reading commands or environment values from statePath.
    await this.publishOwnerState()
    const write = this.persistState({throwOnError: true})

    if (write) await write
  }

  /**
   * @param {ReleaseGroup} release - Retained release.
   * @returns {boolean} Whether its stop drain may run now.
   */
  shouldResumeDrain(release) {
    const transition = this.generationTransition

    if (release === this.committedBootstrapRelease()) return false
    return !transition || transition.phase === "committed_pending" || transition.phase === "committed" || transition.previousReleaseId !== release.releaseId
  }

  /**
   * Relinquishes only daemon authority/listeners after the guardian has committed a
   * prepared replacement. Guardian-owned processes and drains are never stopped.
   * @param {net.Socket | undefined} completionSocket - Commit response connection.
   */
  async retireCommittedOwner(completionSocket) {
    this.ownerRetired = true
    if (this.persistTimer) clearInterval(this.persistTimer)
    this.persistTimer = undefined
    this.persistenceEnabled = false
    if (this.pendingWrite) await this.pendingWrite
    this.stateCleanupEnabled = false
    this.controlClosePromise = this.closeServer(this.controlServer)
    for (const socket of this.controlSockets) if (socket !== completionSocket) socket.destroy()
    await this.removeControlSocket()
    void this.closeServer(this.proxyServer)
    this.logger("owner authority transferred", {activeReleaseId: this.activeRelease?.releaseId ?? null})
  }

  /**
   * Rejects config changes that require rebinding daemon-owned resources or changing process topology.
   * @param {import("./config.js").RollbridgeConfig} nextConfig - Freshly loaded config.
   * @returns {void}
   */
  assertReloadCompatible(nextConfig) {
    /** @type {string[]} */
    const restartRequired = []

    if (nextConfig.application !== this.config.application) restartRequired.push("application")
    if (!isDeepStrictEqual(nextConfig.control, this.config.control)) restartRequired.push("control")
    if (nextConfig.statePath !== this.config.statePath) restartRequired.push("statePath")
    if (!isDeepStrictEqual(nextConfig.ownerRecovery, this.config.ownerRecovery)) restartRequired.push("ownerRecovery")

    if (nextConfig.proxy.host !== this.config.proxy.host) restartRequired.push("proxy.host")
    if (nextConfig.proxy.port !== this.config.proxy.port) restartRequired.push("proxy.port")
    if (nextConfig.proxy.upstreamHost !== this.config.proxy.upstreamHost) restartRequired.push("proxy.upstreamHost")

    if (nextConfig.processes.length !== this.config.processes.length) {
      restartRequired.push("processes")
    } else {
      for (const processConfig of this.config.processes) {
        const nextProcessConfig = nextConfig.processes.find((candidate) => candidate.id === processConfig.id)

        if (!nextProcessConfig ||
          nextProcessConfig.policy !== processConfig.policy ||
          nextProcessConfig.deployStrategy !== processConfig.deployStrategy ||
          nextProcessConfig.replicas !== processConfig.replicas ||
          !isDeepStrictEqual(nextProcessConfig.port, processConfig.port)) {
          restartRequired.push("processes")
          break
        }
      }
    }

    if (restartRequired.length > 0) {
      throw new Error(`Config changes to ${restartRequired.join(", ")} cannot be applied live; restart the Rollbridge daemon before deploying.`)
    }
  }

  /**
   * Rolls back to a previously-active release by re-running the deploy flow on its
   * retained metadata: it re-starts the target release, health-checks it, switches
   * traffic, replaces singletons, and drains the current release — just like a deploy,
   * so a failed rollback leaves the current release active.
   * @param {{releaseId?: string}} [args] - Target release id; defaults to the most recently retired release.
   * @returns {Promise<Record<string, JsonValue>>} The rollback result.
   */
  async rollback({releaseId} = {}) {
    this.assertNoUnresolvedGenerationTransition("rollback")
    const target = releaseId ? this.releases.get(releaseId) : this.previousRelease()

    if (!target) {
      throw new Error(releaseId ? `No retained release "${releaseId}" to roll back to.` : "No previous release to roll back to.")
    }

    if (target === this.activeRelease) {
      throw new Error(`Release "${target.releaseId}" is already active.`)
    }

    // The target may still be draining a prior deploy (live processes). Stop it before the
    // deploy below re-uses its id in this.releases, otherwise the still-running instance
    // would be dropped from status/pruning/shutdown and could be orphaned.
    if (target.state !== "stopped" && target.state !== "failed") {
      await target.stop()
    }

    this.logger("rollback starting", {releaseId: target.releaseId, releasePath: target.releasePath})

    return await this.deploy({releaseId: target.releaseId, releasePath: target.releasePath, revision: target.revision})
  }

  /**
   * @returns {ReleaseGroup | undefined} The most recently active release other than the current one, if any.
   */
  previousRelease() {
    /** @type {ReleaseGroup | undefined} */
    let previous

    for (const release of this.releases.values()) {
      if (release === this.activeRelease || !release.activatedAt) continue
      if (!previous || Date.parse(release.activatedAt) >= Date.parse(/** @type {string} */ (previous.activatedAt))) previous = release
    }

    return previous
  }

  /**
   * Starts missing daemon-wide services before release-owned processes need them.
   * @param {ReleaseGroup} release - Release providing templates and ports.
   * @param {string[]} startedServices - Service ids started by this deploy.
   * @returns {Promise<void>} Resolves when missing services are running.
   */
  async ensureServices(release, startedServices) {
    await release.allocatePorts()

    for (const processConfig of release.config.processes) {
      if (this.stopping) throw new Error("Rollbridge is shutting down")
      if (processConfig.policy !== "service" || processConfig.deployStrategy === "handoff") continue
      if (this.services.has(processConfig.id)) continue

      const service = release.buildProcess(processConfig, {guardianKey: `service:${processConfig.id}`, shouldRestart: () => !this.stopping})

      this.services.set(processConfig.id, service)

      if (release.ports[processConfig.id] !== undefined) {
        this.servicePorts[processConfig.id] = release.ports[processConfig.id]
      }

      try {
        await service.start("deploy")
        release.transferPortReservation(processConfig.id)
        startedServices.push(processConfig.id)
      } catch (error) {
        this.services.delete(processConfig.id)
        delete this.servicePorts[processConfig.id]
        throw error
      }

      if (this.stopping) throw new Error("Rollbridge is shutting down")
    }
  }

  /**
   * Stops services that were started for a failed deploy.
   * @param {string[]} startedServices - Service ids started by the failed deploy.
   * @returns {Promise<void>} Resolves when cleanup finishes.
   */
  async stopStartedServices(startedServices) {
    for (const serviceId of startedServices) {
      const service = this.services.get(serviceId)

      if (!service) continue

      await service.stop()
      this.services.delete(serviceId)
      const port = this.servicePorts[serviceId]

      if (port !== undefined) this.portReservations.delete(port)
      delete this.servicePorts[serviceId]
    }
  }

  /**
   * Updates daemon-wide service restart templates after a successful deploy.
   * @param {ReleaseGroup} release - Active release.
   * @returns {void}
   */
  refreshServiceDefinitions(release) {
    for (const processConfig of this.config.processes) {
      if (processConfig.policy !== "service") continue

      const service = this.services.get(processConfig.id)

      if (!service) continue

      const nextDefinition = release.buildProcess(processConfig, {shouldRestart: () => !this.stopping})

      service.updateDefinition(nextDefinition)
    }
  }

  /**
   * Restarts singleton processes for the new release without overlapping old singleton processes.
   * @param {ReleaseGroup} release - Active release.
   * @returns {Promise<void>} Resolves when singletons have been replaced.
   */
  async replaceSingletons(release) {
    for (const processConfig of this.config.processes) {
      if (this.stopping) throw new Error("Rollbridge is shutting down")
      if (processConfig.policy !== "singleton") continue

      const previous = this.singletons.get(processConfig.id)
      const previousReleaseId = this.singletonReleaseIds.get(processConfig.id)

      if (previous && previousReleaseId === release.releaseId && previous.status().state === "running") continue

      if (previous) {
        await previous.stop()
        if (this.stopping) throw new Error("Rollbridge is shutting down")
      }

      const singleton = release.buildProcess(processConfig, {guardianKey: `singleton:${release.releaseId}:${processConfig.id}`})

      this.singletons.set(processConfig.id, singleton)
      this.singletonReleaseIds.set(processConfig.id, release.releaseId)
      await singleton.start("deploy")
    }
    this.pruneStoppedReleases()
  }

  /**
   * Restarts non-proxied processes selected by id or policy, or all of them: running
   * processes are bounced (stop then start) and crashed or stopped ones are revived,
   * matching the conventional meaning of "restart".
   *
   * The proxied process is never restarted in place (that would drop traffic); use a
   * deploy for a zero-downtime replacement.
   * @param {{policy?: string, processId?: string}} selector - Restart selector; restarts all non-proxied processes when both are omitted.
   * @returns {Promise<Record<string, JsonValue>>} The ids that were restarted.
   */
  async restartProcesses({policy, processId} = {}) {
    this.assertNoUnresolvedGenerationTransition("restart")
    if (policy === "proxied" || (processId !== undefined && this.isProxiedId(processId))) {
      throw new Error('The proxied process cannot be restarted in place; use "rollbridge deploy" for a zero-downtime replacement.')
    }

    const targets = this.collectRestartTargets({policy, processId})

    if (processId !== undefined && targets.length === 0) {
      throw new Error(`No managed process with id "${processId}" to restart.`)
    }

    for (const target of targets) {
      this.logger("process restart requested", {processId: target.id})
      await target.process.stop()
      await target.process.start("manual", target.process.lifecycle.activateCommand ? "active" : undefined)
    }

    return {restarted: targets.map((target) => target.id)}
  }

  /**
   * @param {{policy?: string, processId?: string}} selector - Restart selector.
   * @returns {{id: string, process: import("./managed-process.js").default}[]} Running non-proxied processes matching the selector.
   */
  collectRestartTargets({policy, processId}) {
    const targets = /** @type {{id: string, process: import("./managed-process.js").default}[]} */ ([])

    for (const processConfig of this.config.processes) {
      if (processConfig.policy === "proxied") continue
      if (policy !== undefined && processConfig.policy !== policy) continue

      for (const instance of this.runningInstances(processConfig)) {
        // A processId selector matches the base config id (all replicas) or one replica's id.
        if (processId !== undefined && processId !== processConfig.id && processId !== instance.id) continue

        targets.push(instance)
      }
    }

    return targets
  }

  /**
   * @param {import("./config.js").ProcessConfig} processConfig - Process definition.
   * @returns {{id: string, process: import("./managed-process.js").default}[]} Running instances (replicas) for this config.
   */
  runningInstances(processConfig) {
    if (processConfig.policy === "service") {
      const service = this.services.get(processConfig.id)

      return service ? [{id: processConfig.id, process: service}] : []
    }

    if (processConfig.policy === "singleton") {
      const singleton = this.singletons.get(processConfig.id)

      return singleton ? [{id: processConfig.id, process: singleton}] : []
    }

    return this.activeRelease ? this.activeRelease.getProcesses(processConfig.id) : []
  }

  /**
   * @param {string} id - Process id.
   * @returns {boolean} True when the id belongs to the proxied process.
   */
  isProxiedId(id) {
    return this.config.processes.some((processConfig) => processConfig.policy === "proxied" && processConfig.id === id)
  }

  /**
   * @param {string | undefined} releaseId - Release id, or active release when omitted.
   * @returns {Promise<void>} Resolves when stopped.
   */
  async stopRelease(releaseId) {
    this.assertNoUnresolvedGenerationTransition("stop")
    const release = releaseId ? this.releases.get(releaseId) : this.activeRelease

    if (!release) throw new Error(`Release not found: ${releaseId || "active"}`)
    if (release === this.activeRelease) this.activeRelease = undefined

    await release.stop()
    this.logger("release stopped", {releaseId: release.releaseId})
    this.pruneStoppedReleases()
    this.persistState()
  }

  /** @param {string} operation - Mutating control operation. */
  assertNoUnresolvedGenerationTransition(operation) {
    const transition = this.generationTransition

    if (transition && transition.phase !== "committed") {
      throw new Error(`Cannot ${operation} while release generation transition ${transition.candidateReleaseId} is unresolved at ${transition.phase}; resume the exact deploy first`)
    }
  }

  /**
   * Drains and stops a retired release in the background, then prunes stopped releases.
   * @param {ReleaseGroup} release - Release to drain and stop.
   * @param {import("./config.js").RollbridgeConfig} [config] - Refreshed config governing retirement.
   * @returns {Promise<void>} Resolves once drained, stopped, and pruned.
   */
  async drainAndPrune(release, config = this.config) {
    try {
      await release.drainAndStop(config.proxy.drainTimeoutMs, config)
      this.logger("release drained", {releaseId: release.releaseId})
    } catch (error) {
      this.logger("release drain failed", {error: error instanceof Error ? error.message : String(error), releaseId: release.releaseId})
    } finally {
      if (!release.isDrainPausedForOwnerHandoff()) {
        this.pruneStoppedReleases()
        this.persistState()
      }
    }
  }

  /** @returns {void} Removes stopped releases beyond the retention policy. */
  pruneStoppedReleases() {
    const singletonOwnerReleaseIds = new Set(this.singletonReleaseIds.values())
    const statuses = [...this.releases.values()]
      .filter((release) => !singletonOwnerReleaseIds.has(release.releaseId))
      .map((release) => release.status())

    for (const releaseId of releasesToPrune(statuses, this.config.releaseRetention, Date.now())) {
      this.releases.get(releaseId)?.releasePortReservations()
      this.releases.delete(releaseId)
    }
  }

  /** @returns {void} Starts periodic state persistence when statePath is configured. */
  startStatePersistence() {
    if (!this.statePath) return

    this.stateCleanupEnabled = true
    this.persistenceEnabled = true
    this.persistState()
    this.persistTimer = setInterval(() => this.persistState(), STATE_PERSIST_INTERVAL_MS)
    this.persistTimer.unref?.()
  }

  /**
   * Persists a state snapshot (status plus recent events) to statePath, atomically and
   * fire-and-forget unless the caller awaits the returned write. A failed write is logged.
   * @param {{allowStopping?: boolean, throwOnError?: boolean}} [options] - Write behavior.
   * @returns {Promise<void> | undefined} The queued write, or undefined when persistence is disabled.
   */
  persistState({allowStopping = false, throwOnError = false} = {}) {
    if (!this.statePath || !this.persistenceEnabled || (this.stopping && !allowStopping)) return

    const statePath = this.statePath
    const status = /** @type {Record<string, JsonValue>} */ (secretSafeStateValue(this.status()))
    const events = secretSafeStateValue(this.eventLog.recent())
    const snapshot = {
      ...status,
      events,
      persistedAt: new Date().toISOString(),
      ...(this.hasActivationLifecycle() ? {singletonReleaseIds: Object.fromEntries(this.singletonReleaseIds)} : {}),
      ...(this.guardianIdentity ? {recovery: {
        configDigest: this.ownerRecoveryConfigDigest(),
        format: this.hasActivationLifecycle() ? 2 : 1,
        guardian: this.guardianIdentity,
        reconnectGraceMs: this.config.ownerRecovery?.reconnectGraceMs
      }} : {})
    }

    // Serialize writes (and track the tail) so shutdown can wait for an in-flight write before
    // clearing the file — otherwise a write started before shutdown could recreate it afterward.
    this.pendingWrite = Promise.resolve(this.pendingWrite)
      .catch(() => {})
      .then(() => writeState(statePath, snapshot))
      .then(() => this.publishOwnerState())
      .catch((error) => {
        this.logger("state persist failed", {error: error instanceof Error ? error.message : String(error)})
        if (throwOnError) throw error
      })

    return this.pendingWrite
  }

  /** @returns {boolean} Whether the current authority uses explicit generation activation. */
  hasActivationLifecycle() {
    return Boolean(this.generationTransition) || this.config.processes.some((processConfig) => processConfig.lifecycle?.activateCommand !== undefined) || [...this.releases.values()].some((release) => release.config.processes.some((processConfig) => processConfig.lifecycle?.activateCommand !== undefined))
  }

  /**
   * On startup, reads any state left by a previous daemon and reports managed processes whose
   * pids are still alive — likely orphans from a daemon that did not shut down cleanly. This is
   * advisory (Rollbridge cannot re-adopt detached children); the operator stops the leftovers.
   * A recycled pid could be a false positive, so reports are a prompt to investigate.
   * @returns {Promise<void>} Resolves once orphans are reported.
   */
  async reportOrphans() {
    if (!this.statePath) return

    this.stateCleanupEnabled = true
    const orphans = liveProcesses(await readState(this.statePath))

    // Keep them for status() so `rollbridge status` reflects still-running children after a
    // restart, not just the startup log below.
    this.orphans = orphans

    for (const orphan of orphans) {
      this.logger("orphaned managed process detected", {pid: orphan.pid, processId: orphan.id, releaseId: orphan.releaseId})
    }

    if (orphans.length > 0) {
      this.logger("orphaned processes from a previous daemon", {count: orphans.length, hint: "a previous daemon did not shut down cleanly; verify these pids and stop any leftovers"})
    }
  }

  /**
   * Stops proxy, control socket, and child processes.
   * @param {{completionSocket?: net.Socket, waitForControlConnections?: boolean}} [options] - Shutdown connection behavior.
   * @returns {Promise<void>} Resolves when owned resources are stopped (and, by default, control connections close).
   */
  async shutdown({completionSocket, waitForControlConnections = true} = {}) {
    if (!this.shutdownPromise) this.shutdownPromise = this.performShutdown(completionSocket)

    await this.shutdownPromise
    if (waitForControlConnections && this.controlClosePromise) await this.controlClosePromise
  }

  /**
   * Relinquishes stable listeners promptly while retaining draining children under
   * this daemon until their normal stop contract completes.
   * @param {{attestation: string, completionSocket?: net.Socket}} options - Attested handoff request.
   * @returns {Promise<void>} Resolves once a replacement can exclusively bind listeners.
   */
  async retireOwner({attestation, completionSocket}) {
    if (this.retirementPromise) return await this.retirementPromise
    this.retirementPromise = this.performOwnerRetirement(attestation, completionSocket)
    return await this.retirementPromise
  }

  /**
   * @param {string} attestation - Replacement boot attestation.
   * @param {net.Socket | undefined} completionSocket - Requesting handoff connection.
   * @returns {Promise<void>} Resolves after quiesce and listener release.
   */
  async performOwnerRetirement(attestation, completionSocket) {
    this.stopping = true
    if (this.persistTimer) {
      clearInterval(this.persistTimer)
      this.persistTimer = undefined
    }
    if (this.pendingWrite) await this.pendingWrite
    this.stateCleanupEnabled = false
    this.controlClosePromise = this.closeServer(this.controlServer)
    for (const socket of this.controlSockets) if (socket !== completionSocket) socket.destroy()
    if (this.activeRelease) {
      await this.activeRelease.beginRetirement(this.activeRelease.config)
      this.activeRelease = undefined
    }
    await Promise.all([
      ...[...this.services.values()].map((processInstance) => processInstance.quiesce()),
      ...[...this.singletons.values()].map((processInstance) => processInstance.quiesce()),
      ...[...this.startingReleases].map((release) => release.quiesce()),
      ...[...this.releases.values()].map((release) => release.quiesce())
    ])
    await this.persistState({allowStopping: true, throwOnError: true})
    this.persistenceEnabled = false
    await this.removeControlSocket()
    void this.closeServer(this.proxyServer)
    if (this.guardian) {
      await this.guardian.retireOwner()
      this.guardian.disconnect()
    } else {
      void Promise.allSettled([
        ...[...this.services.values()].map((processInstance) => processInstance.stop()),
        ...[...this.singletons.values()].map((processInstance) => processInstance.stop()),
        ...[...this.startingReleases].map((release) => release.stop()),
        ...[...this.releases.values()].map((release) => release.stop())
      ])
    }
    this.logger("external owner retired", {attestation, status: "draining"})
  }

  /**
   * @param {net.Socket | undefined} completionSocket - Requester retained for the final response.
   * @returns {Promise<void>} Retires listeners and cleans up every daemon-owned resource.
   */
  async performShutdown(completionSocket) {
    this.stopping = true
    const cleanupErrors = /** @type {Error[]} */ ([])

    this.incumbentListenerControl?.close()
    this.incumbentListenerControl = undefined

    // server.close() stops new connections synchronously. Unlink immediately afterward so a
    // replacement can bind as soon as cleanup completes; existing connections remain usable for
    // the shutdown completion/error response.
    this.controlClosePromise = this.closeServer(this.controlServer)

    for (const socket of this.controlSockets) {
      if (socket !== completionSocket) socket.destroy()
    }

    await captureShutdownError(cleanupErrors, "control socket unlink", () => this.removeControlSocket())

    if (this.persistTimer) {
      clearInterval(this.persistTimer)
      this.persistTimer = undefined
    }

    await captureShutdownError(cleanupErrors, "proxy close", async () => this.proxy.close())
    const dependentStopResults = await Promise.allSettled([
      ...[...this.singletons.values()].map((processInstance) => processInstance.stop()),
      ...[...this.startingReleases].map((release) => release.stop()),
      ...[...this.releases.values()].map((release) => release.stop())
    ])
    const serviceStopResults = await Promise.allSettled([...this.services.values()].map((processInstance) => processInstance.stop()))
    const stopResults = [...dependentStopResults, ...serviceStopResults]
    const guardian = this.guardian
    if (guardian) await captureShutdownError(cleanupErrors, "process guardian shutdown", () => guardian.shutdown())
    await captureShutdownError(cleanupErrors, "proxy server close", () => this.closeServer(this.proxyServer))

    // Wait for any in-flight write first so it can't recreate or overwrite the final state (no
    // new writes start: stopping is set and the persist timer is cleared above). Prior-daemon
    // orphans are not owned by this daemon, so retain their records until they are confirmed gone.
    await captureShutdownError(cleanupErrors, "persistent state cleanup", async () => {
      if (!this.statePath || !this.stateCleanupEnabled) return
      if (this.pendingWrite) await this.pendingWrite
      const orphans = this.orphans.filter((orphan) => isProcessAlive(orphan.pid))

      if (orphans.length > 0) {
        await writeState(this.statePath, {activeReleaseId: null, orphans, releases: [], services: [], singletons: []})
      } else {
        await clearState(this.statePath)
      }
    })

    const stopErrors = stopResults.filter((result) => result.status === "rejected").map((result) => result.reason)

    if (stopErrors.length > 0) {
      cleanupErrors.push(new AggregateError(stopErrors, `Shutdown failed to stop ${stopErrors.length} owned resource${stopErrors.length === 1 ? "" : "s"}.`))
    }

    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, cleanupErrors.map((error) => error.message).join("; "))
  }

  /** @returns {Promise<void>} Removes the configured control socket path. */
  async removeControlSocket() {
    if (!this.controlSocketOwned) return

    await fs.rm(this.boundControlPath || this.config.control.path, {force: true})
    this.controlSocketOwned = false
    this.boundControlPath = undefined
  }

  /**
   * @param {net.Server | http.Server | undefined} server - Server.
   * @returns {Promise<void>} Resolves when closed.
   */
  async closeServer(server) {
    if (!server || !server.listening) return

    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }

  /** @returns {number | undefined} Current proxy port. */
  getProxyPort() {
    return this.proxyPort
  }

  /** @returns {DaemonStatus} Status payload. */
  status() {
    // Re-check liveness and prune the dead permanently, so the list self-clears as the operator
    // stops the leftovers (e.g. via `rollbridge recover`). Pruning (not just filtering) matters:
    // a cleared orphan must not reappear if the OS later recycles its pid for an unrelated process.
    this.orphans = this.orphans.filter((orphan) => isProcessAlive(orphan.pid))

    const singletonOwnerReleaseIds = new Set(this.singletonReleaseIds.values())

    return {
      activeReleaseId: this.activeRelease ? this.activeRelease.releaseId : null,
      application: this.config.application,
      bootstrap: this.bootstrap ? {...this.bootstrap} : undefined,
      control: {...this.config.control},
      daemonPid: process.pid,
      daemonRuntime: this.runtime ? {...this.runtime} : undefined,
      generationTransition: this.generationTransition ? {...this.generationTransition} : undefined,
      ownerRecovery: this.guardian ? {configDigest: this.ownerRecoveryConfigDigest()} : undefined,
      ownerTransition: this.ownerTransition ? {...this.ownerTransition} : undefined,
      orphans: [...this.orphans],
      proxy: {
        host: this.config.proxy.host,
        port: this.proxyPort ?? this.config.proxy.port,
        upstreamHost: this.config.proxy.upstreamHost
      },
      releaseReferences: [...this.releases.values()]
        .filter((release) => release.state === "active" || release.state === "draining" || singletonOwnerReleaseIds.has(release.releaseId) || (this.generationTransition?.phase !== "committed" && this.generationTransition?.candidateReleaseId === release.releaseId))
        .map((release) => ({releaseId: release.releaseId, releasePath: release.releasePath})),
      releases: [...this.releases.values()].map((release) => release.status()),
      services: [...this.services.entries()].map(([id, processInstance]) => ({
        id,
        process: processInstance.status()
      })),
      singletons: [...this.singletons.entries()].map(([id, processInstance]) => ({
        id,
        process: processInstance.status()
      }))
    }
  }
}

/**
 * @param {import("./config.js").RollbridgeConfig} config - Normalized config.
 * @returns {string} Stable config authority digest.
 */
export function ownerConfigDigest(config) {
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex")
}

/**
 * Accepts only the two exact authenticated diagnostics emitted by pre-split guardians.
 * @param {string} diagnostic - Guardian response diagnostic.
 * @returns {boolean} Whether the response can proceed to full legacy process attestation.
 */
export function isLegacyGuardianPrepareDiagnostic(diagnostic) {
  return diagnostic === "Guardian prepare-owner-replacement requires a process key" ||
    diagnostic === "Unknown guardian command: prepare-owner-replacement"
}

/**
 * @param {DaemonStatus} snapshot - Serialized owner process snapshot.
 * @param {Record<string, string>} [singletonReleaseIds] - Exact singleton owner releases.
 * @returns {string[]} Exact guardian registration keys present in the snapshot.
 */
function ownerSnapshotProcessKeys(snapshot, singletonReleaseIds = {}) {
  const keys = []

  for (const release of snapshot.releases) {
    for (const processStatus of release.processes) keys.push(`release:${release.releaseId}:${processStatus.id}`)
  }
  for (const service of snapshot.services) keys.push(`service:${service.id}`)
  for (const singleton of snapshot.singletons) {
    const releaseId = singletonReleaseIds[singleton.id] || snapshot.activeReleaseId

    if (releaseId) keys.push(`singleton:${releaseId}:${singleton.id}`)
  }
  return keys
}

/**
 * Selects only committed guardian registrations that restoreOwnerState will reconstruct.
 * @param {OwnerRecoverySnapshot} snapshot - Serialized owner process snapshot.
 * @param {Record<string, string>} [singletonReleaseIds] - Exact singleton owner releases.
 * @returns {string[]} Exact reconstructable guardian registration keys.
 */
function reconstructableOwnerSnapshotProcessKeys(snapshot, singletonReleaseIds = {}) {
  const singletonOwnerReleaseIds = new Set(Object.values(singletonReleaseIds))
  const releaseProcessKeys = new Set()

  for (const release of snapshot.releases) {
    const transitionCandidate = snapshot.generationTransition?.candidateReleaseId === release.releaseId && snapshot.generationTransition.phase !== "committed"
    const singletonOwner = singletonOwnerReleaseIds.has(release.releaseId)

    if (release.state !== "active" && release.state !== "draining" && !transitionCandidate && !singletonOwner) continue
    for (const processStatus of release.processes) releaseProcessKeys.add(`release:${release.releaseId}:${processStatus.id}`)
  }
  return ownerSnapshotProcessKeys(snapshot, singletonReleaseIds)
    .filter((key) => !key.startsWith("release:") || releaseProcessKeys.has(key))
}

/**
 * Canonicalizes the authenticated guardian inventory without relying on map insertion order.
 * @param {{key: string, provenance: string}[]} inventory - Guardian inventory response.
 * @returns {{key: string, provenance: string}[]} Exact key/provenance fence.
 */
function normalizeLegacyGuardianInventory(inventory) {
  const normalized = inventory.map((entry) => {
    if (!entry || typeof entry.key !== "string" || !entry.key || typeof entry.provenance !== "string" || !entry.provenance) {
      throw new Error("Legacy guardian returned an invalid process inventory")
    }
    return {key: entry.key, provenance: entry.provenance}
  }).sort((left, right) => left.key.localeCompare(right.key))

  if (new Set(normalized.map(({key}) => key)).size !== normalized.length) {
    throw new Error("Legacy guardian returned duplicate process registrations")
  }
  return normalized
}

/**
 * Requires every and only the process registrations serialized by committed private owner state.
 * @param {{key: string, provenance: string}[]} inventory - Canonical guardian inventory.
 * @param {{snapshot: DaemonStatus, singletonReleaseIds?: Record<string, string>}} ownerState - Authenticated owner process snapshot.
 */
function assertLegacyGuardianInventoryMembership(inventory, ownerState) {
  if (!ownerState?.snapshot) throw new Error("Legacy guardian owner state is missing its committed process snapshot")
  const inventoryKeys = inventory.map(({key}) => key)
  const snapshotKeys = ownerSnapshotProcessKeys(ownerState.snapshot, ownerState.singletonReleaseIds).sort((left, right) => left.localeCompare(right))

  if (!isDeepStrictEqual(inventoryKeys, snapshotKeys)) {
    throw new Error("Legacy guardian process inventory does not match committed owner state")
  }
}

/**
 * Verifies the exact authenticated guardian process and socket without scanning other PIDs.
 * @param {number} pid - Persisted guardian PID.
 * @param {string} socketPath - Persisted guardian socket.
 */
async function verifyLegacyGuardianProcess(pid, socketPath) {
  const args = await processArguments(pid, "legacy guardian")
  const script = args.find((argument) => argument.endsWith("process-guardian.js"))

  if (!script || !args.includes(socketPath)) throw new Error(`Persisted guardian PID ${pid} does not match the retained guardian command and socket`)
  await verifyProcessUser(pid, "legacy guardian")
  await verifyUnixSocketOwner(pid, socketPath, "legacy guardian")
}

/**
 * Verifies the exact incumbent daemon process and control socket without scanning other PIDs.
 * @param {number} pid - Incumbent PID from the daemon PID file.
 * @param {string | undefined} configPath - Exact daemon config path.
 * @param {string} socketPath - Persisted control socket.
 * @returns {Promise<string>} Linux process start-time identity.
 */
async function verifyLegacyDaemonProcess(pid, configPath, socketPath) {
  if (!configPath) throw new Error("Legacy disruptive replacement requires the daemon's exact config path")
  const args = await processArguments(pid, "legacy daemon")
  const daemonIndex = args.indexOf("daemon")
  const configIndex = args.indexOf("--config")

  if (daemonIndex < 0 || configIndex < 0 || args[configIndex + 1] !== configPath) {
    throw new Error(`Daemon PID ${pid} does not match the exact retained daemon config command`)
  }
  await verifyProcessUser(pid, "legacy daemon")
  await verifyUnixSocketOwner(pid, socketPath, "legacy daemon")
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
  const closingParenthesis = stat.lastIndexOf(")")
  const fields = stat.slice(closingParenthesis + 2).split(" ")
  const startTime = fields[19]

  if (!startTime) throw new Error(`Could not attest start time for legacy daemon PID ${pid}`)
  return startTime
}

/**
 * @param {number} pid - Exact process PID.
 * @param {string} label - Diagnostic label.
 * @returns {Promise<string[]>} NUL-delimited argv.
 */
async function processArguments(pid, label) {
  try {
    return (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean)
  } catch (error) {
    throw new Error(`Could not verify exact ${label} PID ${pid}`, {cause: error})
  }
}

/**
 * @param {number} pid - Exact process PID.
 * @param {string} label - Diagnostic label.
 */
async function verifyProcessUser(pid, label) {
  if (typeof process.getuid !== "function") throw new Error(`Cannot verify ${label} ownership on this platform`)
  const stats = await fs.stat(`/proc/${pid}`)

  if (stats.uid !== process.getuid()) throw new Error(`Refusing ${label} PID ${pid} owned by another user`)
}

/**
 * @param {number} pid - Exact process PID.
 * @param {string} socketPath - Exact Unix socket pathname.
 * @param {string} label - Diagnostic label.
 */
async function verifyUnixSocketOwner(pid, socketPath, label) {
  const rows = (await fs.readFile("/proc/net/unix", "utf8")).split("\n").map((line) => line.trim().split(/\s+/))
  const row = rows.find((columns) => columns[7] === socketPath)

  if (!row?.[6]) throw new Error(`Could not find exact ${label} socket ${socketPath} in the kernel socket table`)
  const expected = `socket:[${row[6]}]`
  const descriptors = await fs.readdir(`/proc/${pid}/fd`)
  let owned = false

  for (const descriptor of descriptors) {
    try {
      if (await fs.readlink(`/proc/${pid}/fd/${descriptor}`) === expected) {
        owned = true
        break
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
    }
  }
  if (!owned) throw new Error(`Exact ${label} PID ${pid} does not own socket ${socketPath}`)
}

/**
 * @param {Record<string, JsonValue>} status - Authenticated incumbent status response.
 * @param {OwnerRecoverySnapshot} persisted - Durable expected identity.
 */
function assertLegacyIncumbentStatus(status, persisted) {
  const control = status.control
  const runtime = status.daemonRuntime
  const ownerRecovery = status.ownerRecovery

  if (status.application !== persisted.application || !control || typeof control !== "object" || Array.isArray(control) || control.path !== persisted.control.path ||
    !runtime || typeof runtime !== "object" || Array.isArray(runtime) || runtime.digest !== persisted.daemonRuntime?.digest ||
    !ownerRecovery || typeof ownerRecovery !== "object" || Array.isArray(ownerRecovery) || ownerRecovery.configDigest !== persisted.recovery.configDigest) {
    throw new Error("Responsive incumbent does not match the exact persisted retained-daemon authority")
  }
}

/**
 * Validates private committed state returned by a partial transaction guardian.
 * @param {JsonValue} value - Authenticated guardian owner state.
 * @param {OwnerRecoverySnapshot} persisted - Durable expected identity.
 * @param {{configDigest: string, runtime: import("./daemon-runtime.js").DaemonRuntimeIdentity | null}} persistedAuthority - Exact committed authority.
 */
function assertLegacyPrivateOwnerState(value, persisted, persistedAuthority) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Partial legacy guardian returned invalid committed owner state")
  const state = /** @type {Record<string, JsonValue>} */ (value)
  const config = state.config
  const snapshot = state.snapshot

  if (!isDeepStrictEqual(state.authority, persistedAuthority) || !config || typeof config !== "object" || Array.isArray(config) ||
    ownerConfigDigest(/** @type {import("./config.js").RollbridgeConfig} */ (config)) !== persistedAuthority.configDigest ||
    !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Partial legacy guardian committed owner state does not match the persisted authority")
  }
  const privateSnapshot = /** @type {OwnerRecoverySnapshot} */ (snapshot)

  assertLegacyIncumbentStatus(/** @type {Record<string, JsonValue>} */ (snapshot), persisted)
  if (!isDeepStrictEqual(
    ownerSnapshotProcessKeys(privateSnapshot, state.singletonReleaseIds && typeof state.singletonReleaseIds === "object" && !Array.isArray(state.singletonReleaseIds)
      ? /** @type {Record<string, string>} */ (state.singletonReleaseIds)
      : {}).sort(),
    ownerSnapshotProcessKeys(persisted, persisted.singletonReleaseIds).sort()
  )) throw new Error("Partial legacy guardian committed process membership does not match durable recovery state")
}

/**
 * @param {string} candidatePath - Path that must not preexist.
 * @param {string} label - Diagnostic label.
 */
async function assertPathAbsent(candidatePath, label) {
  try {
    await fs.lstat(candidatePath)
    throw new Error(`${label} ${candidatePath} already exists; refusing legacy upgrade`)
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
  }
}

/**
 * @param {JsonValue} value - Value.
 * @returns {string | undefined} String value.
 */
function stringOrUndefined(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Error("Expected string value")

  return value
}

/**
 * @param {string} line - Raw control line.
 * @returns {boolean} Whether the line requests shutdown and needs a terminal response connection.
 */
function isShutdownControlLine(line) {
  try {
    const command = JSON.parse(line)

    return Boolean(command && typeof command === "object" && ["commit-owner-replacement", "retire-owner", "shutdown"].includes(command.command))
  } catch {
    return false
  }
}

/**
 * Runs one shutdown cleanup step and records a labeled failure without skipping later cleanup.
 * @param {Error[]} errors - Accumulated cleanup errors.
 * @param {string} label - Non-secret cleanup step name.
 * @param {() => Promise<void>} operation - Cleanup operation.
 * @returns {Promise<void>} Resolves after the operation succeeds or its failure is recorded.
 */
async function captureShutdownError(errors, label, operation) {
  try {
    await operation()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    errors.push(new Error(`${label} failed: ${reason}`, {cause: error}))
  }
}

const SECRET_BEARING_STATE_KEYS = new Set(["children", "command", "cwd", "env", "environment", "logs", "output"])

/**
 * Removes process definitions and captured output from a value before it reaches statePath.
 * The live status/events APIs retain those diagnostics in memory; persistent state is only a
 * secret-safe recovery aid and must not become a second process log or configuration store.
 * @param {JsonValue} value - JSON value to sanitize.
 * @returns {JsonValue} A secret-safe copy.
 */
function secretSafeStateValue(value) {
  if (Array.isArray(value)) return value.map((entry) => secretSafeStateValue(entry))
  if (!value || typeof value !== "object") return value

  /** @type {Record<string, JsonValue>} */
  const safe = {}

  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_BEARING_STATE_KEYS.has(key)) continue
    safe[key] = secretSafeStateValue(entry)
  }

  return safe
}

/**
 * @param {JsonValue} value - Value.
 * @param {string} key - Key.
 * @returns {string} String value.
 */
function requiredString(value, key) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`)
  }

  return value
}

/**
 * @param {JsonValue} value - Value.
 * @param {string} key - Key.
 * @returns {number} Non-negative integer.
 */
function requiredNonNegativeInteger(value, key) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`)
  return value
}

/**
 * @typedef {{releaseId: string, state: string, stoppedAt: string | undefined}} PrunableRelease
 */

/**
 * Selects stopped releases to prune by the retention policy, keeping the most recent.
 * @param {PrunableRelease[]} releases - Status of all tracked releases, in deploy order (oldest first).
 * @param {import("./config.js").ReleaseRetentionConfig} policy - Retention policy.
 * @param {number} now - Current epoch milliseconds.
 * @returns {string[]} Release ids to remove.
 */
export function releasesToPrune(releases, policy, now) {
  const stopped = releases
    .filter((release) => release.state === "stopped")
    .map((release, index) => ({deployOrder: index, releaseId: release.releaseId, stoppedAtMs: release.stoppedAt ? Date.parse(release.stoppedAt) : 0}))
    // Most recent first; ties (same stoppedAt millisecond) prefer the later-deployed release.
    .sort((first, second) => second.stoppedAtMs - first.stoppedAtMs || second.deployOrder - first.deployOrder)

  /** @type {string[]} */
  const remove = []

  stopped.forEach((release, index) => {
    const beyondKeep = index >= policy.keep
    const tooOld = policy.maxAgeMs > 0 && release.stoppedAtMs > 0 && now - release.stoppedAtMs > policy.maxAgeMs

    if (beyondKeep || tooOld) remove.push(release.releaseId)
  })

  return remove
}

/**
 * @typedef {{alive: boolean, application?: string, activeReleaseId?: string | null, proxy?: {host: string, port: number}}} ControlSocketInspection
 */

/**
 * Builds an operator-facing message explaining why the control socket cannot be bound.
 * @param {string} socketPath - Control socket path.
 * @param {ControlSocketInspection} inspection - Result of probing the socket.
 * @returns {string} Diagnostic message.
 */
function controlSocketBusyMessage(socketPath, inspection) {
  if (inspection.application === undefined) {
    return `The control socket ${socketPath} is already in use by another process. Stop that process or set a different control.path.`
  }

  const releaseDetail = inspection.activeReleaseId ? `active release: ${inspection.activeReleaseId}` : "no active release"

  return `A Rollbridge daemon for application "${inspection.application}" is already running on ${socketPath} (${releaseDetail}). ` +
    `Run "rollbridge status" to inspect it or "rollbridge shutdown" to stop it, or set a different control.path.`
}

/**
 * Probes an existing control socket to see whether a daemon is alive, and identifies it when it is Rollbridge.
 * @param {string} socketPath - Control socket path.
 * @param {number} [timeoutMs] - How long to wait for a status response before treating the socket as busy.
 * @returns {Promise<ControlSocketInspection>} Whether the socket is live and, when it is Rollbridge, its identity.
 */
export async function inspectControlSocket(socketPath, timeoutMs = 1000) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ""
    let settled = false
    let timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined)

    const finish = (/** @type {ControlSocketInspection} */ result) => {
      if (settled) return

      settled = true
      if (timer) clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    timer = setTimeout(() => finish({alive: true}), timeoutMs)
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(`${JSON.stringify({command: "status"})}\n`))
    socket.on("data", (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf("\n")

      if (newlineIndex < 0) return

      const status = parseControlStatus(buffer.slice(0, newlineIndex))

      finish(status ? {activeReleaseId: status.activeReleaseId, alive: true, application: status.application, proxy: status.proxy} : {alive: true})
    })
    socket.once("error", (error) => {
      if (settled) return

      if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        settled = true
        if (timer) clearTimeout(timer)
        resolve({alive: false})
        return
      }

      settled = true
      if (timer) clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * Parses a control status response line into a Rollbridge identity, if it is one.
 * @param {string} line - JSON response line.
 * @returns {{application: string, activeReleaseId: string | null, proxy: {host: string, port: number} | undefined} | undefined} Identity, or undefined when unrecognized.
 */
function parseControlStatus(line) {
  /** @type {JsonValue} */
  let parsed

  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  if (typeof parsed.application !== "string") return undefined

  const proxy = "proxy" in parsed && parsed.proxy && typeof parsed.proxy === "object" && !Array.isArray(parsed.proxy) && typeof parsed.proxy.host === "string" && typeof parsed.proxy.port === "number" ? {host: parsed.proxy.host, port: parsed.proxy.port} : undefined

  return {activeReleaseId: typeof parsed.activeReleaseId === "string" ? parsed.activeReleaseId : null, application: parsed.application, proxy}
}
