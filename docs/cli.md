# Rollbridge CLI reference

```
rollbridge <command> [options]
```

This reference covers every current command. See the README for config and
process-policy details.

## Global behavior

- **`-c, --config <path>`** is accepted by every command and is optional. When
  omitted, Rollbridge loads `rollbridge.js` from the current directory (a
  JavaScript module that `export default`s the config object or a function
  returning it).
- Commands that talk to a running daemon — `deploy`, `status`, `stop`,
  `shutdown`, and `logs` — connect to the control socket (`control.path`). They
  fail with an error if no daemon is listening; start one first with
  `rollbridge daemon` or `rollbridge deploy --ensure-daemon`.
- `validate`, `doctor`, and `logs` accept `--json` for machine-readable output.
  `deploy`, `status`, `stop`, `shutdown`, and `ensure-daemon` always print JSON.

## `daemon`

```
rollbridge daemon [--config <path>] [--takeover-owner]
                  [--release-path <path> --release-id <id> --revision <sha>
                   [--boot-attestation <sha256:digest>]]
```

Runs the supervisor in the foreground: binds the stable proxy port and the
control socket and stays running. On `SIGINT`/`SIGTERM` it stops its managed
processes, closes the servers, removes the control socket, and exits `0`.
Structured JSON log lines are written to stdout. Run it under a process manager
such as systemd (see `examples/rollbridge.service`).

For boot/crash recovery, pass an explicit absolute `--config` and all three
release options together. Rollbridge validates every bootstrap input before it
binds listeners or starts processes, then binds the proxy and activates that
exact release through the normal deploy path: services,
companions, the proxied process and health check, traffic switching, singletons,
and service-template refresh. Only after activation succeeds does it expose the
control socket, preventing another deployment from overlapping bootstrap. It
then remains in the foreground with the normal signal behavior.

Bootstrap paths must be absolute and normalized, the release path must be an
accessible directory, and release id/revision values accept letters, numbers,
dots, underscores, and hyphens (maximum 200 characters, beginning with a letter
or number). Supplying only some bootstrap options, or an invalid value, exits
non-zero before listeners start. Activation failure emits a structured
`bootstrap activation failed` event, cleans up processes owned by that attempt,
and exits non-zero without exposing the control socket or inventing an active
release. With `ownerRecovery`, daemon startup first claims the matching guardian
and reconstructs its active/draining generations. Without it, `statePath`
entries remain advisory orphans for explicit recovery.

`--boot-attestation` is an optional, non-secret opaque ownership token for an
external supervisor. Its canonical format is exactly `sha256:` followed by 64
lowercase hexadecimal characters. It is accepted only with the complete
known-release bootstrap tuple above and is never accepted by `ensure-daemon`.
After successful activation, `status` echoes it unchanged in the bootstrap
identity. Rollbridge does not calculate or interpret the digest.

With no release options, daemon behavior is unchanged: it starts listener-only
and waits for control-socket deployments.

If an external owner retirement has already journaled a committed generation but
cleared its active role, only a foreground bootstrap with that exact release id,
path, revision, and config authority may restore it. Rollbridge waits for the
retiring candidate processes to stop, journals `restoring_committed`, reconnects
their existing guardian registrations, restarts that candidate, health-checks it,
and restores its generation activation before completing singletons and exposing
control. A later exact bootstrap resumes the journaled restart without duplicating
processes. A mismatched tuple or a candidate that is still retiring fails closed
without stopping other retained generations.

`--takeover-owner` requires the complete bootstrap tuple. It bootstraps and
health-checks the replacement before sending the current daemon the private
retirement command. The current `performOwnerRetirement` path quiesces every
service, singleton, starting release, and retained release, releases the stable
listeners, and starts asynchronous `stop()` calls for all of them. It neither
preserves nor transfers retained-generation supervision to the replacement.
The replacement can bind before those stops finish. A bootstrap failure occurs
before retirement, so the previously accepted owner remains available.

`ownerRecovery` covers unexpected process exit under the exact same authority.
Guardian-fenced incompatible config/package/runtime/control-socket handoff is
provided by `ensure-daemon`, not `--takeover-owner`; it preserves supervision
without handing old workers to a new jobs-main.

## `ensure-daemon`

```
rollbridge ensure-daemon [--config <path>]
                         [--daemon-log-path <path>]
                         [--daemon-pid-path <path>]
                         [--daemon-runtime-path <path>]
                         [--daemon-start-timeout-ms <ms>]
```

Starts the daemon as a detached process **only if** the control socket is not
already accepting commands, waits until it responds and its guardian accepts
the ready owner, then prints the daemon status JSON. Idempotent — safe to call
before every deploy. The detached daemon uses the config file's directory as its
working directory, rather than the invoking release, so release retention cannot
remove the accepted recovery cwd.

Before starting a detached daemon, Rollbridge atomically copies its runtime code
and production dependency closure into a content-addressed directory outside
the invoking release. This keeps the long-lived daemon valid when deploy
retention removes that release. A responsive daemon is reused only when its
runtime and normalized config authority match. With `ownerRecovery` and the same
`statePath`, an incompatible config/control-socket/package/runtime owner is
replaced candidate-first: the guardian retains active and draining generations,
the candidate binds and validates its listeners, and an authenticated fenced
transaction commits guardian authority and the final control socket. A lost
control response is accepted only when the guardian confirms the exact committed
transaction id. The first authenticated upgrade from a genuine pre-replacement
guardian/daemon, or from a retained prepare/stage guardian that explicitly lacks
the retired-owner commit capability, is the sole exception: `ensure-daemon` preserves its exact
guardian-owned processes but deliberately retires the old listeners before the
Node 20 candidate binds, so existing proxy/control connections may close.
Successful status JSON records this as `ownerTransition.disruptive: true` and
`ownerTransition.mode: "legacy-first-upgrade"`. This one-time bridge requires
the incumbent config identity unchanged; make config/socket changes in a second,
atomic invocation. Auth, transport, malformed-response, arbitrary unknown-command,
and authority failures do not qualify and fail before any deploy is sent.

- `--daemon-log-path <path>` — file the detached daemon's stdout/stderr is
  appended to. Default: `/tmp/rollbridge-<application>.log`. See
  [`logging.md`](logging.md) for the log format and rotation guidance.
- `--daemon-pid-path <path>` — file the detached daemon's PID is written to.
  Default: `/tmp/rollbridge-<application>.pid`. During replacement, the file
  continues to name the incumbent until the authenticated guardian atomically
  publishes the ready winner's exact `daemonPid`.
- `--daemon-runtime-path <path>` — parent directory for content-addressed daemon
  runtime snapshots. Default:
  `/tmp/rollbridge-<user-id>-<application-hash>-runtime`. The directory must be owned
  by the current user and must not be group/world writable; preparation or
  validation failure aborts before daemon startup or deploy handoff.
- `--daemon-start-timeout-ms <ms>` — how long to wait for the daemon to accept
  control commands before failing. Default: `10000`.

## `deploy`

```
rollbridge deploy --release-path <path>
                  [--config <path>]
                  [--release-id <id>]
                  [--revision <sha>]
                  [--ensure-daemon]
                  [--daemon-log-path <path>]
                  [--daemon-pid-path <path>]
                  [--daemon-runtime-path <path>]
                  [--daemon-start-timeout-ms <ms>]
```

Starts the complete prepared release generation, health-checks the proxied
process, and switches new traffic to it. The current daemon then starts
retirement of the previous release asynchronously, so the command does not wait
for old workers, jobs, or HTTP/WebSocket connections to finish. Prints
`{"status": "success", "activeReleaseId": "...", "previousReleaseId": "..."}`.
If the new release fails to start or health-check, the previous release stays
active and the command errors.

With an opt-in handoff-service `lifecycle.activateCommand`, deploy journals the
exact transition, waits for old retirement acknowledgement, waits for candidate
activation acknowledgement, and synchronously commits the active proxy target.
An unresolved failure blocks different deploys; only the exact same release,
path, revision, and config authority may explicitly resume its incomplete
idempotent phase. A durable `committed_pending` phase keeps exact retry from
reporting success until singleton replacement finishes. Stop, restart, and
rollback mutations are rejected while the transition is unresolved. Automatic
replay also fences `shutdown` and `retire-owner` until the replay attempt settles.
An owner replacement may change runtime/package identity during an unresolved
transition, but it cannot change config authority until that transition commits;
the incumbent owner remains in place when such a replacement is rejected.
Hook-free configs retain the existing post-activation quiet behavior and
retirement result. `status.releaseReferences` lists `{releaseId, releasePath}`
for every active or draining release and for a stopped release that still owns a
persistent service definition, pending singleton, or unresolved generation
transition; unrelated fully stopped history is excluded.

For hook-free configs, after candidate activation `Daemon.deploy()` begins old-generation retirement
and asynchronous drain before awaiting singleton replacement. A singleton
replacement failure can therefore return non-zero while the candidate remains
active, but it cannot leave the old jobs generation dispatching.

With `ownerRecovery`, active and draining generations remain guardian-supervised
across unexpected same-authority daemon exit and reconstruct on replacement;
they also transfer intact through an incompatible `ensure-daemon` owner handoff.
Without it, surviving PIDs remain advisory orphans for `recover --force`.

Before each deploy, the daemon reloads the config path it was started with.
Compatible process and lifecycle changes apply to the new release and govern
how the previous release retires, including updated `nonBlockingDrain`,
`stopSignal`, `lifecycle`, and `gracefulStopMs` settings. The daemon adopts the
new config only after the replacement release starts successfully. Changes to
daemon-owned listeners or process topology fail the deploy with a restart
instruction; see [Config reloads](config.md#config-reloads).

- `--release-path <path>` (**required**) — path to the prepared release
  directory; available to process templates as `{{releasePath}}`.
- `--release-id <id>` — identifier for the release. Defaults to `--revision`,
  or a timestamp when neither is given.
- `--revision <sha>` — VCS revision; available as `{{revision}}`.
- `--ensure-daemon` — start the daemon first if it isn't running (honors the
  same `--daemon-*` options as `ensure-daemon`).

## `recover-generation-transition`

`rollbridge recover-generation-transition --release-path <path> --release-id <id>
--revision <sha> --previous-release-id <id> [--config <path>]
[--accept-retired-incumbent]`

By default, restores the incumbent before clearing an exact failed transition.
`--accept-retired-incumbent` instead requires an exact `restoring_previous`
journal, terminal restoration failure, retired candidate, retired incumbent
coordinator, and live incumbent proxy processes. It safely stops the failed
candidate and persists a `degraded_active` fence without reactivating either jobs
generation, reporting `jobsStatus: "degraded"`. Incumbent web survives owner
recovery, and a fresh normal deployment replaces the fence through normal cutover.

## `rollback`

```
rollbridge rollback [--config <path>] [--release-id <id>]
```

Rolls back to a previously-active release by re-running the deploy flow on its
retained metadata: it re-starts that release, health-checks the proxied process,
switches traffic, replaces singletons, and drains the current release — exactly
like a deploy. With no `--release-id`, it targets the **most recently retired**
release (the one active just before the current). Prints the same
`{"activeReleaseId", "previousReleaseId"}` result as `deploy`.

Because rollback reuses the deploy flow, a failed rollback (the target won't
start or health-check) leaves the current release active and errors — it never
takes the site down. Singletons are replaced (old stopped, then the target's
started) and the current release is drained, just like any deploy.

Errors when there is no previous release, the `--release-id` is not a retained
release, or the target is already active. Only releases Rollbridge still retains
(see [`releaseRetention`](config.md#releaseretention)) can be rolled back to.

**Migration constraints.** Rollback only manages processes — it does **not**
revert database migrations or other external state. The target release's on-disk
directory must still exist, and its code must be compatible with the current
schema. Keep migrations backwards-compatible (the same rule that lets old and
new releases overlap during a deploy) so rolling code back to a retained release
stays safe.

## `status`

```
rollbridge status [--config <path>]
```

Prints the daemon status JSON: the active release id, the proxy address, and —
per release, service, and singleton process — its `state`, `pid`, automatic
`restarts`, `startedAt`, `uptimeMs`, last `exitCode`/`exitSignal`,
`lastStartReason` (`deploy`, `crash`, `manual`, or `memory`), and recent `logs`.
Memory-supervised processes also report `rssBytes`, `memoryRestarts`,
`lastMemoryRestartAt`, and `children` (the process tree: each group member's
`pid`, `command`, and `rssBytes`).

`daemonRuntime` identifies the immutable Rollbridge runtime serving the proxy:
its runtime `format`, package `version`, content `digest`, and absolute `path`.
`ensure-daemon` uses this attestation before reusing a responsive daemon.
With `ownerRecovery`, `ownerRecovery.ready` becomes `true` only after the
guardian has accepted that daemon's listener readiness and atomically published
its configured PID file; `ensure-daemon` does not return a pre-ready status.

A foreground known-release daemon also reports the exact CLI bootstrap identity:

```json
{
  "bootstrap": {
    "releaseId": "20260813090000",
    "releasePath": "/srv/app/releases/20260813090000/app",
    "revision": "abc123",
    "attestation": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

`attestation` is omitted when the optional argument was not supplied. Ordinary
listener-only daemons and detached daemons created by `ensure-daemon` omit the
entire `bootstrap` object. External supervisors can therefore distinguish two
otherwise identical foreground boots by comparing the opaque attestation.

When [`statePath`](config.md#statepath) is configured, status also includes an
`orphans` array: managed processes from a **previous** daemon that are still
alive (`id`, `pid`, `releaseId`) — for example after the daemon restarted but its
detached children kept running. It is empty in the normal case. Liveness is
re-checked on each call, so the list clears itself as you stop the leftovers (see
[`recover`](#recover)). These are reported only — the new daemon can't re-adopt
them.

## `stop`

```
rollbridge stop [--config <path>] [--release-id <id>]
```

Stops the active release (or the release named by `--release-id`) and prints the
updated status JSON. With no active release, the proxy answers `503` until the
next deploy.

## `restart`

```
rollbridge restart [--config <path>] [--process <id>] [--policy <policy>]
```

Restarts **non-proxied** processes and prints `{"restarted": [<ids>]}`. Like
`systemctl restart`, a running process is bounced (stop, then start) and a
crashed or stopped one is revived — so this is also how you bring back a process
that exhausted its `restart` budget (see [`config.md`](config.md#processesrestart)).
Selectors:

- no selector — restart every non-proxied process (companions, singletons, and services);
- `--process <id>` — restart only that process;
- `--policy <companion|singleton|service>` — restart only processes with that policy.

The proxied process is never restarted in place — that would drop traffic.
Targeting it (by id or `--policy proxied`) is an error; use `rollbridge deploy`
for a zero-downtime replacement. `--process <id>` with an id that is not a
managed process (unknown, or a companion with no active release) is also an
error. Restarting a `service` bounces a shared broker (for example Velocious
Beacon), which briefly disrupts every process that depends on it. For a handoff
service, restart targets only the active release's instance and restores its
active lifecycle role before reporting success.

## `predeploy-cleanup`

```
rollbridge predeploy-cleanup [--config <path>] [--release-path <path>]
```

Prepares a host for the first Rollbridge deploy. If a Rollbridge daemon already
has an active release, the command exits without stopping anything. Otherwise it
recovers Rollbridge-managed orphans from `statePath` and stops the legacy
processes configured in [`legacyTakeover`](config.md#legacytakeover), then exits
before `rollbridge deploy` starts the new daemon/proxy.

When `--release-path` is provided, the command also restarts the existing daemon
if the active release uses a different Rollbridge package version than the
pending release. It also restarts the daemon when the active daemon's proxy host,
port, or upstream host differs from the pending config.

Use it immediately before `rollbridge deploy --ensure-daemon` when migrating an
app from `screen`, `process_bot`, or another old supervisor to Rollbridge.

## `recover`

```
rollbridge recover [--config <path>] [--force]
```

Cleans up orphaned managed processes left by a **crashed** daemon. It reads the
persisted state ([`statePath`](config.md#statepath)) and finds managed processes
whose pids are still alive. Without `--force` it only **lists** them (a dry run);
with `--force` it stops each one's process group (`SIGTERM`, then `SIGKILL` after
`proxy.forceStopTimeoutMs`) and clears the stale state file.

Run it **before** restarting the daemon after a crash. It refuses to run while a
daemon (or another process) holds the control socket — those pids belong to a
live daemon, not a crash. A recycled pid can be a false positive, so review the
dry-run list before using `--force`.

If `--force` cannot stop some orphan (for example one now owned by another user,
so it can't be signaled), that process is reported as still running, the state
file is **kept** so you can investigate and re-run `recover`, and the command
exits non-zero. Requires `statePath`; also exits non-zero when it is unset or a
daemon is running.

## `shutdown`

```
rollbridge shutdown [--config <path>]
```

Stops all managed processes (services, singletons, and releases), closes the
proxy and control socket, removes the socket file, and prints
`{"status": "success", "message": "shutdown"}`. The success response is a
completion signal, not an early acknowledgement: before sending it, Rollbridge
stops accepting new control connections, removes the targeted socket, finishes
owned-process and proxy cleanup, and finalizes persistent state. A caller may
immediately start or ensure a replacement daemon after the command returns.

If cleanup fails, the command exits non-zero with the daemon's error instead of
reporting success. Calling `shutdown` when no daemon owns the configured control
socket also remains an explicit connection error.

## `validate`

```
rollbridge validate [--config <path>] [--json]
```

Parses and validates the config without starting the daemon, reporting every
issue with an example fix. Exits `1` when issues are found. With `--json`, prints
`{"config": {...} | null, "issues": [{"message", "fix"}], "path", "valid"}`.

## `doctor`

```
rollbridge doctor [--config <path>]
                  [--release-path <path>]
                  [--release-id <id>]
                  [--revision <sha>]
                  [--json]
```

Validates the config, then probes the environment: whether a daemon already
holds the control socket, whether the control socket's directory is writable,
and whether the proxy port can be bound. When [`statePath`](config.md#statepath)
is configured, it also checks that the state file's directory is writable and
reports any **orphaned processes** — managed processes still alive in a prior
state file, left by a daemon that didn't shut down cleanly (advisory; a recycled
pid can be a false positive, so verify before stopping). Exits `1` when any check
fails (so a green `doctor` means a fresh daemon can start). With `--json`, prints
`{"checks": [{"name", "ok", "detail"}], "ok"}`.

### Pre-flighting a release with `--release-path`

Process commands, working directories, and env values are
[templates](config.md#template-variables) (`{{releasePath}}`, `{{port}}`, …) that
are only rendered at deploy time, against a specific release. Pass
`--release-path <path>` to a **prepared release directory** to add deploy-time
checks against it:

- **release path** — the release directory exists.
- **process templates** — every process's `command`, `cwd`, and `env` templates
  resolve (no `{{…}}` references an undefined variable). Ports are rendered with
  the low end of each process's configured range.
- **process working directories** — each process's rendered `cwd` (defaulting to
  the release path) exists.

`--release-id` and `--revision` set `{{releaseId}}`/`{{revision}}` for rendering
(defaulting the way `deploy` does: `--release-id` falls back to `--revision` or
the release path's basename, and `--revision` falls back to `--release-id`). Run
it as part of a deploy pipeline, after preparing the release and before
`rollbridge deploy`, to catch a template typo or a missing directory before
traffic is involved:

```bash
rollbridge doctor --config /etc/rollbridge/app.js --release-path /srv/app/releases/20260524
```

These checks render replica index `0` and use representative ports, so they
catch template and path problems but not values that only exist once the daemon
allocates real ports and spawns processes.

## `logs`

```
rollbridge logs [--config <path>] [--process <id>] [--json]
```

Prints the recent stdout/stderr retained per managed process — a one-shot
snapshot of each process's `outputLines`, not a live stream. `--process <id>`
limits output to one process. With `--json`, prints
`[{"id", "source", "logs": [{"at", "line", "stream"}]}]`.

## `events`

```
rollbridge events [--config <path>] [--limit <count>] [--json]
```

Prints the daemon's recent structured event history — deploys (`deploy
starting`, `traffic switched`, `deploy failed`), release stops (`release
stopped`, `release drained`), process lifecycle (`process started` — with a
`reason` of `deploy`, `crash`, `manual`, or `memory` — `process exited`,
`memory limit exceeded`, `restart limit reached`, `process restart requested`),
and failed control commands (`command failed`). Each event has a timestamp, a
message, and a structured data payload. The daemon keeps the most recent 1000 events in
memory (cleared on restart). `--limit <count>` shows only the most recent
`count`. With `--json`, prints `[{"at", "message", "data"}]`.

## `completion`

```
rollbridge completion <bash|zsh>
```

Prints a shell completion script to stdout, generated by introspecting the
command set (so it never drifts from the real commands and options). It
completes command names, each command's option flags, and falls back to file
completion after an option that takes a value (bash). Enable it for the current
session, or add the line to your shell startup file:

```bash
# bash (~/.bashrc)
source <(rollbridge completion bash)

# zsh (~/.zshrc)
source <(rollbridge completion zsh)
```

An unsupported shell exits `1` with the list of supported shells.

## Exit codes

- `0` — success.
- `1` — `validate`/`doctor` found problems, or `--config` could not be resolved.
- non-zero (with an error message) — a daemon command could not reach the daemon,
  or the daemon returned an error.
