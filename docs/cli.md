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
rollbridge daemon [--config <path>]
```

Runs the supervisor in the foreground: binds the stable proxy port and the
control socket and stays running. On `SIGINT`/`SIGTERM` it stops its managed
processes, closes the servers, removes the control socket, and exits `0`.
Structured JSON log lines are written to stdout. Run it under a process manager
such as systemd (see `examples/rollbridge.service`).

## `ensure-daemon`

```
rollbridge ensure-daemon [--config <path>]
                         [--daemon-log-path <path>]
                         [--daemon-pid-path <path>]
                         [--daemon-start-timeout-ms <ms>]
```

Starts the daemon as a detached process **only if** the control socket is not
already accepting commands, waits until it responds, then prints the daemon
status JSON. Idempotent — safe to call before every deploy.

- `--daemon-log-path <path>` — file the detached daemon's stdout/stderr is
  appended to. Default: `/tmp/rollbridge-<application>.log`. See
  [`logging.md`](logging.md) for the log format and rotation guidance.
- `--daemon-pid-path <path>` — file the detached daemon's PID is written to.
  Default: `/tmp/rollbridge-<application>.pid`.
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
                  [--daemon-start-timeout-ms <ms>]
```

Starts the prepared release, health-checks the proxied process, switches new
traffic to it, then drains and stops the previous release. Prints
`{"status": "success", "activeReleaseId": "...", "previousReleaseId": "..."}`.
If the new release fails to start or health-check, the previous release stays
active and the command errors.

- `--release-path <path>` (**required**) — path to the prepared release
  directory; available to process templates as `{{releasePath}}`.
- `--release-id <id>` — identifier for the release. Defaults to `--revision`,
  or a timestamp when neither is given.
- `--revision <sha>` — VCS revision; available as `{{revision}}`.
- `--ensure-daemon` — start the daemon first if it isn't running (honors the
  same `--daemon-*` options as `ensure-daemon`).

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
Beacon), which briefly disrupts every process that depends on it.

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
`{"status": "success", "message": "shutdown"}`.

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
