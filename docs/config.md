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

## `proxy`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `proxy.host` | string | `"127.0.0.1"` | Interface the stable proxy binds, and the host used to reach release processes. |
| `proxy.port` | number | `8182` | Stable port Nginx (or another front end) points at. |
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
| `gracefulStopMs` | number | `proxy.forceStopTimeoutMs` | `SIGTERM`→`SIGKILL` window for this process. |
| `restartDelayMs` | number | `1000` | Delay before restarting this process after a crash. |
| `outputLines` | positive integer | `50` | Recent stdout/stderr lines retained per process and reported by `status`/`logs`. |

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
| `{{port}}` | The port allocated to this process. |
| `{{ports.<id>}}` | The port allocated to another process. |
| `{{proxy.host}}`, `{{proxy.port}}` | The configured proxy host/port. |
| `{{env.<NAME>}}` | A variable from the daemon's own environment, e.g. `{{env.HOME}}`. |

## Injected environment variables

Rollbridge sets these in every managed process's environment (the process's own
`env` is merged on top and can override them):

| Variable | Value |
| --- | --- |
| `ROLLBRIDGE_APPLICATION` | `application` |
| `ROLLBRIDGE_PROCESS_ID` | This process's `id`. |
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
- `outputLines` and `releaseRetention.keep` must be positive/non-negative integers; `health.startDelayMs` and `releaseRetention.maxAgeMs` must be non-negative numbers.
