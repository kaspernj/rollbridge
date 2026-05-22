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
  appended to. Default: `/tmp/rollbridge-<application>.log`.
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

## `status`

```
rollbridge status [--config <path>]
```

Prints the daemon status JSON: the active release id, the proxy address, and —
per release, service, and singleton process — its `state`, `pid`, automatic
`restarts`, `startedAt`, `uptimeMs`, last `exitCode`/`exitSignal`, and recent
`logs`.

## `stop`

```
rollbridge stop [--config <path>] [--release-id <id>]
```

Stops the active release (or the release named by `--release-id`) and prints the
updated status JSON. With no active release, the proxy answers `503` until the
next deploy.

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
rollbridge doctor [--config <path>] [--json]
```

Validates the config, then probes the environment: whether a daemon already
holds the control socket, whether the control socket's directory is writable,
and whether the proxy port can be bound. Exits `1` when any check fails (so a
green `doctor` means a fresh daemon can start). With `--json`, prints
`{"checks": [{"name", "ok", "detail"}], "ok"}`.

## `logs`

```
rollbridge logs [--config <path>] [--process <id>] [--json]
```

Prints the recent stdout/stderr retained per managed process — a one-shot
snapshot of each process's `outputLines`, not a live stream. `--process <id>`
limits output to one process. With `--json`, prints
`[{"id", "source", "logs": [{"at", "line", "stream"}]}]`.

## Exit codes

- `0` — success.
- `1` — `validate`/`doctor` found problems, or `--config` could not be resolved.
- non-zero (with an error message) — a daemon command could not reach the daemon,
  or the daemon returned an error.
