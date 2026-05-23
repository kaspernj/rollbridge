# Rollbridge TODO

This roadmap tracks planned Rollbridge features and documentation. Rollbridge should stay deploy-tool agnostic: Capistrano, shell scripts, CI, or other deploy systems should call Rollbridge through CLI commands instead of Rollbridge shipping Capistrano tasks or plugins.

## Current Baseline

- [x] Stable local HTTP/WebSocket proxy in front of one active release.
- [x] Unix socket control API used by the CLI.
- [x] `daemon`, `ensure-daemon`, `deploy`, `status`, `stop`, and `shutdown` commands.
- [x] Per-release process startup with templated `releasePath`, `releaseId`, `revision`, and ports.
- [x] Process policies for `proxied`, `companion`, `singleton`, and `service`.
- [x] HTTP health check before switching traffic to a new web process.
- [x] Drain old HTTP/WebSocket connections before stopping previous release processes.
- [x] Restart crashed active release processes after `restartDelayMs`.
- [x] Restart crashed daemon-wide service processes from the latest successful release template.
- [x] Graceful `SIGTERM` followed by `SIGKILL` after timeout.
- [x] TensorBuzz production example config.
- [x] ESLint, TypeScript `checkJs`, TensorBuzz CI, and `release:patch`.

## Major Features

- [ ] Memory supervision.
  - [ ] Add per-process memory config with an RSS limit, check interval, warning threshold, and restart policy.
  - [ ] Measure the managed process tree, not only the shell wrapper PID.
  - [ ] Report memory stats and last memory-triggered restart in `status`.
  - [ ] Restart memory-heavy workers gracefully when possible, with a forced stop timeout.
  - [ ] Add tests with a fixture process that allocates memory above the configured limit.
- [ ] Worker auto-restart and restart policy controls.
  - [x] Add config for max restarts, restart window, exponential backoff, and disabled restart behavior (per-process `restart` policy).
  - [x] Distinguish crash restarts, deploy replacements, manual restarts, and memory restarts in status/events. (Per-process `lastStartReason` + a `reason` on the `process started` event; the `memory` reason is wired and fires once memory supervision restarts a process.)
  - [x] Add a `restart` CLI command for a single process, a policy group, or all non-proxied workers.
  - [ ] Keep restart behavior safe for job workers by using lifecycle hooks before termination.
- [ ] Graceful job-worker lifecycle.
  - [ ] Add generic lifecycle hooks such as `quietCommand`, `drainCommand`, `drainTimeoutMs`, and `stopCommand`.
  - [ ] Support signal-only lifecycle steps for workers that can quiet on a Unix signal.
  - [ ] Add a non-blocking drain mode so new workers can start while old workers finish running jobs.
  - [ ] Document a Velocious background-jobs-worker recipe once the lifecycle contract is implemented.
- [ ] Replicas and stable worker indexes.
  - [ ] Allow one process config to start multiple replicas.
  - [ ] Expose `ROLLBRIDGE_REPLICA_INDEX`, replica count, and per-replica template context.
  - [ ] Restart or stop one replica without affecting the rest.
  - [ ] Preserve readable status output for replica groups.
- [ ] Persistent daemon state and recovery.
  - [ ] Persist active release, draining releases, process metadata, counters, and recent events.
  - [ ] Reconnect status to still-running child processes after daemon restart where possible.
  - [ ] Detect and report orphaned Rollbridge-managed processes.
  - [ ] Add a recovery mode for safe startup after daemon crash or machine reboot.
- [ ] Rollback support.
  - [ ] Keep enough release metadata to switch traffic back to a previous healthy release.
  - [ ] Add a `rollback` CLI command that health-checks the target before switching.
  - [ ] Define how rollback interacts with singleton workers and draining releases.
  - [ ] Document migration constraints for rollback.
- [ ] Observability and diagnostics.
  - [x] Add structured event history for deploys, switches, stops, crashes, memory restarts, and failed commands. (In-memory `EventLog` tapping the daemon logger; memory-restart events populate once memory supervision logs them.)
  - [x] Add restart counters and uptime to status (exit reasons already reported via `exitCode`/`exitSignal`/`state`).
  - [ ] Add memory stats and child-process-tree details to status (with memory supervision).
  - [x] Add a `logs` CLI command (recent per-process output from status).
  - [x] Add an `events` CLI command (after structured event history lands).
  - [ ] Add optional file logging with rotation guidance.
  - [x] Add machine-readable JSON output for all CLI commands (data commands print JSON; `validate`/`doctor`/`logs` take `--json`).
- [ ] Config validation and doctoring.
  - [x] Add `validate` to parse config and report all config errors without starting the daemon.
  - [x] Add `doctor` to check config validity, control socket reachability, proxy port availability, and control-socket directory writability.
  - [ ] Extend `doctor` with process-command, release-path, and log/state-path checks once those are resolvable (rendered templates, persisted state).
  - [x] Validate duplicate process IDs, missing ports on proxied processes, invalid ranges, and the single-proxied-process policy rule.
  - [ ] Validate unsupported lifecycle-hook combinations once worker lifecycle hooks land.
  - [x] Include example fixes in validation output.

## Minor Features

- [x] Add a control-socket permission option (`control.mode`) for shared deploy users.
- [ ] Add control-socket owner/group options for shared deploy users (needs name-to-id resolution).
- [x] Make stale control socket diagnostics clearer when another daemon is still alive.
- [x] Add old-release cleanup policies by age, count, and stopped state (`releaseRetention`).
- [x] Add port allocation diagnostics when a range is exhausted.
- [x] Add an optional startup delay (`health.startDelayMs`) before health checks begin.
- [x] Add process output retention config instead of a fixed recent-log count.
- [x] Add environment variable interpolation from the daemon environment.
- [x] Add `--config` default lookup resolving to `rollbridge.js` when no path is given.
- [x] Add shell completion generation for common shells (`rollbridge completion bash|zsh`).
- [x] Add npm package metadata such as repository, license, bugs, and homepage.
- [x] Add systemd service examples for the Rollbridge daemon.
- [x] Add tests for malformed control socket JSON and unknown control commands.
- [x] Add tests for duplicate IDs and singleton replacement failure behavior.
- [x] Add tests for proxy behavior when the active release exits unexpectedly.

## Documentation TODO

- [x] Write a full config reference covering every field, default, and template variable (`docs/config.md`).
- [x] Write a CLI reference for `daemon`, `ensure-daemon`, `deploy`, `status`, `stop`, `shutdown`, and future commands (`docs/cli.md`).
- [x] Expand process policy docs with deployment examples for `proxied`, `companion`, `singleton`, and `service`.
- [ ] Document memory checks and auto-restart behavior after the feature lands.
- [ ] Document worker lifecycle hooks and safe background-job deployment patterns after the feature lands.
- [x] Add a Velocious deployment guide with Beacon, background-jobs-main, background-jobs-worker, and web process examples (`docs/velocious.md`).
- [x] Add an Nginx guide with WebSocket headers, timeouts, and common failure modes (`docs/nginx.md`).
- [x] Add deploy-tool recipes that call Rollbridge CLI commands directly (`docs/deploy-recipes.md`).
- [x] Add a Capistrano recipe showing shell commands only; do not add a Capistrano plugin or Rollbridge-specific Capistrano tasks (`docs/deploy-recipes.md`).
- [ ] Add a TensorBuzz-specific runbook for current production ports, external services, deploy ordering, and rollback constraints.
- [x] Add troubleshooting docs for health-check failures, port conflicts, stale sockets, crash loops, and stuck draining releases (`docs/troubleshooting.md`).
- [ ] Add a release checklist for maintainers using `npm run release:patch`.
