# Config reference

A Rollbridge config is a JavaScript module that `export default`s a config
object (or a sync/async function returning one). When `--config` is omitted,
the CLI loads `rollbridge.js` from the working directory. Run
`rollbridge validate` to check a config without starting the daemon.

```js
// rollbridge.js
export default {
  application: "ticket-server",
  control: {path: "/tmp/rollbridge-ticket-server.sock"},
  proxy: {host: "127.0.0.1", port: 8182},
  processes: [
    {id: "web", policy: "proxied", cwd: "{{releasePath}}", command: "npx velocious server --port {{port}}", port: {from: 18182, to: 18299}, health: {path: "/ping"}}
  ]
}
```

## Top-level fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `application` | string | basename of the config file's directory | Names the app; used in the default control-socket path and the `ROLLBRIDGE_APPLICATION` env var. |
| `control` | object | — | Control-socket settings (see below). |
| `proxy` | object | **required** | Proxy listener and shared defaults (see below). |
| `processes` | array | **required** | Managed processes (see below). Exactly one must be `proxied`. |
| `releaseRetention` | object | — | How many stopped releases the daemon retains (see below). |

## `control`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `control.path` | string | `/tmp/rollbridge-<application>.sock` | Unix domain socket the CLI uses to talk to the daemon. |
| `control.mode` | octal string (e.g. `"660"`) or octal number (`0o660`) | unset | `chmod` applied to the socket after it binds, to share it with a deploy group. When unset, the daemon umask applies. |
| `control.owner` | non-negative integer uid or user name | unset | `chown` owner applied to the socket after it binds. |
| `control.group` | non-negative integer gid or group name | unset | `chown` group applied to the socket after it binds, so a shared deploy group can use it. |

Names are resolved via `/etc/passwd`/`/etc/group` (local users and groups); use
numeric ids for NSS-only principals. The daemon must run as a user permitted to
`chown` the socket (root, or a member of the target group) — otherwise it fails
to start with a clear error. Combine `control.group` with `control.mode: "660"`
to let a deploy group talk to the daemon.

## `proxy`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `proxy.host` | string | `"127.0.0.1"` | Interface the stable proxy binds. |
| `proxy.port` | number | `8182` | Stable port Nginx (or another front end) points at. |
| `proxy.upstreamHost` | string | `proxy.host`, or `"127.0.0.1"` when `proxy.host` is `0.0.0.0`/`::` | Host Rollbridge uses for release health checks and proxy targets. |
| `proxy.healthPath` | string | `"/ping"` | Default health-check path for proxied processes. |
| `proxy.healthTimeoutMs` | number | `30000` | Default health-check timeout for proxied processes. |
| `proxy.drainTimeoutMs` | number | `60000` | How long to drain open connections from a retired release before stopping it. |
| `proxy.forceStopTimeoutMs` | number | `10000` | Default per-process graceful-stop timeout (`SIGTERM`, then `SIGKILL`). |

## `releaseRetention`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `releaseRetention.keep` | non-negative integer | `10` | Number of most-recent **stopped** releases the daemon keeps in memory and reports in `status`. |
| `releaseRetention.maxAgeMs` | non-negative number | `0` (disabled) | Also prune stopped releases older than this many milliseconds. |

Active and draining releases are never pruned. This governs Rollbridge's own
release records; the deploy tool still owns on-disk release directories.

## `processes[]`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | string | **required** | Unique identifier. Appears in `status`, logs, and `ROLLBRIDGE_*` env vars. |
| `policy` | `"proxied"` \| `"companion"` \| `"singleton"` \| `"service"` | `"companion"` | Lifecycle policy (see [README → Process Policies](../README.md#process-policies)). Exactly one process must be `proxied`. |
| `command` | string | **required** | Shell command to run (templated). |
| `cwd` | string | the release path | Working directory (templated). |
| `env` | object of string → string | `{}` | Extra environment variables (values templated). Merged over the injected `ROLLBRIDGE_*` vars. |
| `port` | number or `{from, to}` | unset | Port (or range) allocated per release. **Required for the `proxied` process.** A plain number `n` means the fixed port `n` (`{from: n, to: n}`). |
| `health` | object or `false` | enabled with defaults | Health check for the `proxied` process; set `false` to disable (see below). |
| `stopSignal` | signal name (e.g. `"SIGTERM"`, `"SIGINT"`, `"SIGQUIT"`) | `"SIGTERM"` | Signal sent to gracefully stop the process; after `gracefulStopMs` it is `SIGKILL`ed. Use a worker's quit signal so it finishes in-flight work before exiting. |
| `lifecycle` | object | no hooks | Command hooks run when gracefully stopping the process (see below). |
| `gracefulStopMs` | number | `proxy.forceStopTimeoutMs` | Graceful-stop window: time between `stopSignal`/`stopCommand` and `SIGKILL` for this process. |
| `restartDelayMs` | number | `1000` | Base delay before restarting this process after a crash (the backoff base; see `restart`). |
| `restart` | object | unlimited restarts, constant delay | Automatic-restart policy: cap, rolling window, and backoff (see below). |
| `memory` | object | unset (no monitoring) | Memory supervision: restart the process when its RSS exceeds a limit (see below). |
| `replicas` | positive integer | `1` | Run this many instances of the process (see below). |
| `outputLines` | positive integer | `50` | Recent stdout/stderr lines retained per process and reported by `status`/`logs`. |

### `processes[].replicas`

Run a pool of identical instances of one process — for example several
background-job workers. `replicas` greater than `1` is supported only on a
**`companion`** process **without a `port`** (the worker-pool case);
`proxied`, `singleton`, and ported processes must keep `replicas: 1`.

```js
{id: "worker", policy: "companion", command: "npx velocious background-jobs-worker", replicas: 4}
```

Each replica runs as its own managed process with id `<id>#<index>` (`worker#0`,
`worker#1`, …) — that id is what appears in `status` and what
[`rollbridge restart`](cli.md#restart) targets (use the base id `worker` to
restart every replica, or `worker#0` for one). Replicas get `replicaIndex`/
`replicaCount` template variables and `ROLLBRIDGE_REPLICA_INDEX`/`_COUNT` in their
environment, so each instance can pick a distinct shard, queue, or lock. A single
process (`replicas: 1`) keeps its plain id and is replica `0` of `1`.

### `processes[].lifecycle`

Command hooks run when Rollbridge **gracefully stops** the process — during a
deploy's drain, a `rollbridge restart`, a memory restart, or shutdown. They let a
job worker quiesce and finish in-flight work before it is terminated. Omit
`lifecycle` for the default behavior (just `stopSignal` then `SIGKILL`).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `lifecycle.quietCommand` | string | unset | Run first to tell the process to stop accepting new work. |
| `lifecycle.drainCommand` | string | unset | Run after quieting to wait until the process has drained (it blocks until done). When unset, Rollbridge instead waits up to `drainTimeoutMs` for the process to exit on its own. Requires a positive `drainTimeoutMs` (which bounds it). |
| `lifecycle.drainTimeoutMs` | non-negative number | `0` | Bounds the drain step. `0` **skips the drain step entirely** (no `drainCommand`, no wait). |
| `lifecycle.stopCommand` | string | unset | Run to stop the process instead of sending `stopSignal`, if it is still running after draining. |

The full stop sequence is: run `quietCommand` → drain (`drainCommand`, or wait
`drainTimeoutMs` for the process to exit) → if still running, run `stopCommand`
or send `stopSignal` → `SIGKILL` after `gracefulStopMs`. Each hook command is run
through a shell with the process's environment plus `ROLLBRIDGE_PID` (the
process-group leader's pid, so a hook can `kill -TSTP -$ROLLBRIDGE_PID`). Every
hook is **bounded by a timeout** (its drain timeout, or `gracefulStopMs`) and its
failure is non-fatal — the sequence proceeds and `SIGKILL` is always the final
fallback, so a slow or broken hook can't wedge a stop.

```js
{id: "worker", policy: "companion", command: "…", lifecycle: {quietCommand: "kill -TSTP -$ROLLBRIDGE_PID", drainTimeoutMs: 60000}}
```

### `processes[].restart`

Controls automatic restarts of a crashed process (a release's active processes
and daemon-wide `service`s). The base delay is the process's `restartDelayMs`;
when the policy's limit is reached the process is left `failed` and not
restarted again.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `restart.maxRestarts` | non-negative integer | unset (unlimited) | Maximum automatic restarts allowed within `windowMs` before Rollbridge stops restarting the process. `0` disables automatic restarts entirely. |
| `restart.windowMs` | non-negative number | `0` (process lifetime) | Rolling window over which `maxRestarts` is counted and after which the backoff resets. `0` counts over the process's whole lifetime. |
| `restart.backoffFactor` | number ≥ 1 | `1` (constant) | Multiplier applied to `restartDelayMs` on each successive restart in the window: `delay = restartDelayMs × backoffFactor ^ n`. `1` keeps a constant delay. |
| `restart.maxDelayMs` | non-negative number | `0` (no cap) | Upper bound on the backed-off delay. `0` means no cap. |

With the defaults a crashed process restarts indefinitely after `restartDelayMs`.
Pair `backoffFactor`/`windowMs` to back off and self-heal after a clean run, or
set `maxRestarts` to give up on a process stuck in a crash loop.

### `processes[].memory`

Monitors the resident memory (RSS) of the process and **gracefully restarts** it
(`SIGTERM`, then `SIGKILL` after `gracefulStopMs`) when it exceeds `limitBytes`.
RSS is measured across the whole managed process group (the spawned wrapper and
its children), not just the wrapper. Omit `memory` to disable monitoring. Memory
measurement uses `/proc` and is a no-op on platforms without it.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `memory.limitBytes` | positive integer | **required** | RSS limit in bytes; exceeding it restarts the process. |
| `memory.warnBytes` | non-negative integer | `0` (off) | Log a `memory warning` once when RSS first crosses this threshold (set below `limitBytes`). |
| `memory.checkIntervalMs` | positive number | `5000` | How often to measure RSS. |

```js
{id: "worker", policy: "companion", command: "…", memory: {limitBytes: 536870912, warnBytes: 402653184, checkIntervalMs: 5000}}
```

A memory restart is reported in `status` (`memoryRestarts`, `lastMemoryRestartAt`,
current `rssBytes`) and recorded in the event history (a `process started` event
with `reason: "memory"`). `status` also reports `children` — the sampled process
tree, with each group member's `pid`, `command`, and `rssBytes`.

### `processes[].health`

Only the `proxied` process is health-checked (before traffic switches to a new
release). Set `health: false` to disable it.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `health.path` | string | `proxy.healthPath` | HTTP path probed on the process's port. |
| `health.timeoutMs` | number | `proxy.healthTimeoutMs` | Total time to wait for the first healthy response. |
| `health.intervalMs` | number | `250` | Delay between probes. |
| `health.startDelayMs` | non-negative number | `0` | Wait this long after the process starts before the first probe (runs before the `timeoutMs` window). |

## Template variables

`command`, `cwd`, and `env` values support `{{...}}` placeholders, rendered when
the process starts. Referencing a placeholder with no value fails the process
start with a clear error.

| Placeholder | Value |
| --- | --- |
| `{{application}}` | `application` |
| `{{releaseId}}` | The deploy's release id. |
| `{{releasePath}}` | The deploy's `--release-path`. |
| `{{revision}}` | The deploy's `--revision` (falls back to the release id). |
| `{{processId}}` | This process's `id`. |
| `{{replicaIndex}}`, `{{replicaCount}}` | This instance's zero-based replica index and the total replica count (`0` and `1` for a single process). |
| `{{port}}` | The port allocated to this process. |
| `{{ports.<id>}}` | The port allocated to another process. |
| `{{proxy.host}}`, `{{proxy.port}}`, `{{proxy.upstreamHost}}` | The configured proxy bind host/port and upstream host. |
| `{{env.<NAME>}}` | A variable from the daemon's own environment, e.g. `{{env.HOME}}`. |

## Injected environment variables

Rollbridge sets these in every managed process's environment (the process's own
`env` is merged on top and can override them):

| Variable | Value |
| --- | --- |
| `ROLLBRIDGE_APPLICATION` | `application` |
| `ROLLBRIDGE_PROCESS_ID` | This process's `id` (the base id, not the `#index` instance id). |
| `ROLLBRIDGE_REPLICA_INDEX`, `ROLLBRIDGE_REPLICA_COUNT` | This instance's zero-based replica index and total replica count (`0` and `1` for a single process). |
| `ROLLBRIDGE_RELEASE_ID` | The release id. |
| `ROLLBRIDGE_RELEASE_PATH` | The release path. |
| `ROLLBRIDGE_REVISION` | The revision (or release id). |
| `ROLLBRIDGE_PORT` | This process's allocated port (only when it has one). |
| `ROLLBRIDGE_<ID>_PORT` | Each process's allocated port, where `<ID>` is the process id uppercased with non-alphanumerics replaced by `_` (e.g. `background-jobs-main` → `ROLLBRIDGE_BACKGROUND_JOBS_MAIN_PORT`). |

## Validation rules

`rollbridge validate` reports all of these at once with an example fix:

- Required `application` defaults are filled; `proxy` and `processes` must be present and well-typed.
- Exactly one process must be `proxied`, and the `proxied` process must define a `port`.
- Process `id`s must be unique.
- `port` must be a positive port number or an ascending `{from, to}` range.
- `control.mode` must be an octal mode between `0` and `0o777`.
- `control.owner` and `control.group` must each be a non-negative integer id or a non-empty name (resolved at daemon start).
- `outputLines` and `releaseRetention.keep` must be positive/non-negative integers; `health.startDelayMs` and `releaseRetention.maxAgeMs` must be non-negative numbers.
- `restart.maxRestarts` must be a non-negative integer (omit it for unlimited restarts); `restart.backoffFactor` must be a number ≥ 1; `restart.windowMs` and `restart.maxDelayMs` must be non-negative numbers.
- When `memory` is set, `memory.limitBytes` must be a positive integer, `memory.warnBytes` a non-negative integer, and `memory.checkIntervalMs` a positive number.
- `replicas` must be a positive integer; `replicas > 1` is allowed only on a `companion` process without a `port`. Process ids must not contain `#` (reserved for replica instance ids).
- `lifecycle.quietCommand`/`drainCommand`/`stopCommand` must be strings when set, and `lifecycle.drainTimeoutMs` a non-negative number; `lifecycle.drainCommand` requires a positive `lifecycle.drainTimeoutMs`.
