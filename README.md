# Rollbridge

Rollbridge is a Node.js process supervisor and local traffic switcher for zero-downtime deploys.

Nginx points at one stable Rollbridge proxy port. Deploy tooling asks Rollbridge to start a new release, health-check it, switch new traffic to it, and drain old HTTP/WebSocket connections before stopping the previous release.

## Install

```bash
npm install rollbridge
```

For local development in this repository:

```bash
npm install
npm run all-checks
```

## Config

A Rollbridge config is a JavaScript module that `export default`s a config
object. It can also export a function (sync or async) that returns the object,
which is handy for computing values from the environment. Write it in your
project's module system — `export default` for ESM (`"type": "module"`) or
`module.exports` for CommonJS.

```js
// rollbridge.js
export default {
  application: "ticket-server",

  control: {
    path: "/tmp/rollbridge-ticket-server.sock"
  },

  proxy: {
    host: "127.0.0.1",
    port: 8182,
    upstreamHost: "127.0.0.1",
    healthPath: "/ping",
    healthTimeoutMs: 30000,
    drainTimeoutMs: 60000,
    forceStopTimeoutMs: 10000
  },

  processes: [
    {
      id: "beacon",
      policy: "companion",
      cwd: "{{releasePath}}",
      command: "env VELOCIOUS_BEACON_PORT={{port}} npx velocious beacon",
      port: {from: 17330, to: 17399}
    },
    {
      id: "background-jobs-worker",
      policy: "companion",
      cwd: "{{releasePath}}",
      command: "npx velocious background-jobs-worker",
      outputLines: 200
    },
    {
      id: "background-jobs-main",
      policy: "service",
      cwd: "{{releasePath}}",
      command: "npx velocious background-jobs-main"
    },
    {
      id: "web",
      policy: "proxied",
      cwd: "{{releasePath}}",
      command: "npx velocious server --host 127.0.0.1 --port {{port}}",
      port: {from: 18182, to: 18299},
      health: {path: "/ping", timeoutMs: 30000}
    }
  ]
}
```

Each process retains its most recent stdout/stderr lines and reports them in
`status`. Set `outputLines` (a positive integer, default 50) per process to keep
more or fewer lines for chatty or quiet processes.

Set `control.mode` to an octal permission string (for example `"660"`) to
chmod the control socket after it binds. This restricts which users can send
control commands — useful when several deploy users share a group. When unset,
the socket keeps the default permissions from the daemon's umask.

Set the proxied process's `health.startDelayMs` (default `0`) to wait that long
after the process starts before the first health probe — like a readiness
probe's initial delay, useful for apps with a known boot time. The delay runs
before the `health.timeoutMs` window begins.

Set `releaseRetention` to bound how many stopped (drained) releases the daemon
keeps in memory and reports in `status`. `keep` (default `10`) retains the most
recent stopped releases; `maxAgeMs` (default `0`, disabled) also prunes stopped
releases older than that many milliseconds. The active and draining releases are
never pruned. This is Rollbridge's own release records — your deploy tool still
owns cleaning up on-disk release directories.

```js
releaseRetention: {keep: 5, maxAgeMs: 86400000}
```

A function export receives no arguments and lets you build the config at load
time:

```js
// rollbridge.js
export default () => ({
  application: process.env.APP_NAME || "ticket-server",
  control: {path: `/tmp/rollbridge-${process.env.APP_NAME || "ticket-server"}.sock`},
  proxy: {host: "127.0.0.1", port: 8182},
  processes: [
    {id: "web", policy: "proxied", cwd: "{{releasePath}}", command: "npx velocious server --port {{port}}", port: {from: 18182, to: 18299}}
  ]
})
```

### Template variables

A process `command`, `cwd`, and `env` values support `{{...}}` placeholders
rendered when the process starts:

- `{{releasePath}}`, `{{releaseId}}`, `{{revision}}`, `{{application}}`, `{{processId}}`
- `{{port}}` — the port allocated to this process; `{{ports.<id>}}` — another process's allocated port
- `{{proxy.host}}`, `{{proxy.port}}`, `{{proxy.upstreamHost}}`
- `{{env.<NAME>}}` — a variable from the daemon's own environment, e.g. `{{env.HOME}}`

Referencing a placeholder with no value (including an unset `{{env.<NAME>}}`)
fails the process start with a clear error, so typos surface immediately.

Production-ready examples live in `examples/`, including
`examples/tensorbuzz.com.js` for the current TensorBuzz backend deployment.

See [`docs/velocious.md`](docs/velocious.md) for a Velocious deployment guide —
how Beacon, background-jobs-main, background-jobs-worker, and the web process map
to Rollbridge policies, with startup ordering and deploy behavior.

See [`docs/config.md`](docs/config.md) for the full config reference — every
field, its default, validation rules, template variables, and the environment
variables Rollbridge injects.

## Process Policies

Every process declares a `policy` that controls its lifecycle. Pick one per
process:

| You need… | Use |
| --- | --- |
| The process that receives external HTTP/WebSocket traffic | `proxied` |
| A per-release helper tied to the release lifecycle | `companion` |
| Exactly one instance, never overlapping across deploys | `singleton` |
| A long-lived shared broker that survives deploys | `service` |

### `proxied`

The web/API process — exactly one per config. Rollbridge forwards HTTP and
WebSocket traffic to the active release's proxied process and tracks open
connections so they can be drained on the next deploy. It must define a `port`
range, is health-checked before traffic switches to a new release, and is
auto-restarted while its release is active.

```js
{
  id: "web",
  policy: "proxied",
  cwd: "{{releasePath}}",
  command: "npx velocious server --host 127.0.0.1 --port {{port}}",
  port: {from: 18182, to: 18299},
  health: {path: "/ping", timeoutMs: 30000}
}
```

### `companion`

A release-scoped helper (for example a background worker bound to one release).
It starts **before** the proxied process in the same release, so release-local
dependencies are ready before the health check, and it is auto-restarted while
its release is active. Each release gets its own companions; a release's
companions stop when that release is drained and retired after a newer release
takes over.

```js
{
  id: "background-jobs-worker",
  policy: "companion",
  cwd: "{{releasePath}}",
  command: "npx velocious background-jobs-worker",
  gracefulStopMs: 60000
}
```

### `singleton`

A one-at-a-time helper for duplicate-unsafe schedulers or job dispatchers. After
a new release becomes active, Rollbridge stops the old singleton and then starts
the new one, so two copies never run at once. Use it when running the old and
new copies simultaneously during a deploy would be unsafe.

```js
{
  id: "scheduler",
  policy: "singleton",
  cwd: "{{releasePath}}",
  command: "npx velocious scheduler"
}
```

### `service`

A daemon-wide broker that should outlive individual releases — for example
Velocious Beacon or `background-jobs-main`. Rollbridge starts it once (before
release processes that depend on it), keeps it running across deploys, and gives
it a stable port that does not change between releases. After each successful
deploy its restart template is refreshed to the latest release, so if it crashes
it restarts from the newest good release. It keeps restarting until the daemon
shuts down.

```js
{
  id: "background-jobs-main",
  policy: "service",
  cwd: "{{releasePath}}",
  command: "npx velocious background-jobs-main",
  port: 7331
}
```

### Deploy ordering

On `rollbridge deploy`, Rollbridge:

1. starts any `service` that is not already running;
2. starts the new release's `companion`s, then its `proxied` process, and
   health-checks the proxied process;
3. switches new traffic to the new release;
4. refreshes each `service`'s restart template to the new release;
5. replaces `singleton`s (stops the old one, then starts the new one);
6. drains the previous release's connections, then stops its `proxied` and
   `companion` processes.

If the new release fails to start or health-check, the previous release stays
active and any service started during this deploy is rolled back.

## Commands

`--config` is optional for every command. When omitted, Rollbridge looks for
`rollbridge.js` in the current directory. The examples below pass `--config`
explicitly, but `rollbridge validate` (or any command) works with no flag when a
`rollbridge.js` is present.

For machine-readable output, `deploy`, `status`, `stop`, `shutdown`, and
`ensure-daemon` already print JSON, and `validate`, `doctor`, and `logs` accept
a `--json` flag that switches their output to JSON (with the same exit codes),
so deploy tooling can parse results.

See [`docs/cli.md`](docs/cli.md) for the full per-command reference (every
option, default, output shape, and exit code).

Validate a config without starting the daemon:

```bash
rollbridge validate --config rollbridge.js
```

`validate` reports every config error at once with an example fix and exits
non-zero when issues are found, so deploy tooling can gate on it. It checks
required fields and types, duplicate process IDs, port ranges, that exactly one
process is `proxied`, and that the proxied process defines a port range. Example
output for a misconfigured file:

```text
Found 2 configuration issues in rollbridge.js:

1. Config must define exactly one proxied process; found 0
   Fix: Mark exactly one process with policy: proxied so Rollbridge knows where to forward traffic.

2. Duplicate process id: web
   Fix: Give each process a unique id; "web" is used more than once.
```

Check the environment before starting the daemon:

```bash
rollbridge doctor --config rollbridge.js
```

`doctor` validates the config and then probes the runtime environment, exiting
non-zero if any check fails (so deploy tooling can gate on it):

```text
✓ config: valid: 4 processes, proxy on 127.0.0.1:8182
✓ control socket: no daemon running; /tmp/rollbridge-ticket-server.sock is free to bind
✓ control socket directory: /tmp is writable
✓ proxy port: 127.0.0.1:8182 is available

All checks passed.
```

A free control socket, a writable socket directory, and a bindable proxy port
pass. Because `rollbridge daemon` cannot bind a socket or port that is already
taken, doctor fails the relevant check when a Rollbridge daemon (or any other
process) is already listening on the control socket or holding the proxy port —
so a green `doctor` means a fresh daemon can actually start.

Start the daemon:

```bash
rollbridge daemon --config rollbridge.js
```

Start the daemon only when it is not already running:

```bash
rollbridge ensure-daemon --config rollbridge.js --daemon-log-path log/rollbridge.log --daemon-pid-path tmp/pids/rollbridge.pid
```

Deploy a prepared release:

```bash
rollbridge deploy --config rollbridge.js --release-path /home/dev/ticket-server/releases/20260521073000/ticket-server --revision abc123
```

Deploy and start the daemon first when needed:

```bash
rollbridge deploy --ensure-daemon --config rollbridge.js --release-path /home/dev/ticket-server/releases/20260521073000/ticket-server --revision abc123
```

Inspect state:

```bash
rollbridge status --config rollbridge.js
```

`status` reports each managed process's `state`, `pid`, recent `logs`, last
`exitCode`/`exitSignal`, and — per process — its automatic-restart count
(`restarts`), last start time (`startedAt`), and current `uptimeMs` while
running.

Print the recent captured stdout/stderr per process (a one-shot snapshot of the
retained `outputLines`, not a live stream):

```bash
rollbridge logs --config rollbridge.js
rollbridge logs --config rollbridge.js --process web
```

Stop the active release:

```bash
rollbridge stop --config rollbridge.js
```

Shut down the daemon and managed processes:

```bash
rollbridge shutdown --config rollbridge.js
```

## Nginx

Nginx should proxy to Rollbridge, not directly to Velocious:

```nginx
location / {
  proxy_pass http://127.0.0.1:8182;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

See [`docs/nginx.md`](docs/nginx.md) for the full guide — WebSocket upgrade
headers, timeouts for long-lived connections, forwarded headers, and common
failure modes (502/503, dropped WebSockets).

## Running under systemd

Run the long-lived daemon as a systemd service so it starts on boot and is
restarted if it crashes. A ready-to-edit unit lives at
`examples/rollbridge.service`:

```bash
sudo cp examples/rollbridge.service /etc/systemd/system/rollbridge.service
# edit User/Group, WorkingDirectory, the ExecStart path, and --config
sudo systemctl daemon-reload
sudo systemctl enable --now rollbridge
sudo systemctl status rollbridge
```

The unit runs `rollbridge daemon --config <stable-config>` in the foreground,
so its output goes to the journal (`journalctl -u rollbridge`). Key directives:

- `KillMode=mixed` / `KillSignal=SIGTERM`: Rollbridge stops its own managed
  child process groups on `SIGTERM`, so systemd signals only the daemon and
  lets it shut down gracefully before escalating to `SIGKILL`.
- `TimeoutStopSec`: give the daemon time to stop its managed processes; size it
  above the largest process `gracefulStopMs` (the daemon `SIGKILL`s stragglers
  after that). Note that `systemctl stop`/reboot stops processes but does **not**
  drain HTTP/WebSocket connections — connection draining happens only during
  `rollbridge deploy` release transitions.

The daemon is long-lived and survives deploys. **Deploy with
`rollbridge deploy` (or `rollbridge deploy --ensure-daemon`), not
`systemctl restart`** — pointing `--config` at a stable, daemon-wide file while
release paths are passed per deploy. Use `command -v rollbridge` to find the
absolute CLI path for `ExecStart`.

## Deployment Notes

Run migrations before `rollbridge deploy`, and keep migrations backwards-compatible while old and new web releases overlap. For stable local brokers such as Velocious Beacon or `background-jobs-main`, use `service` when the process should survive deploys and restart from the latest successful release if it crashes.

See [`docs/deploy-recipes.md`](docs/deploy-recipes.md) for ready-to-use shell, CI, and Capistrano recipes that drive Rollbridge through its CLI, and [`docs/troubleshooting.md`](docs/troubleshooting.md) for diagnosing health-check failures, port conflicts, stale sockets, crash loops, and stuck draining releases.

## Releasing

Maintainers can publish a patch release from the latest default branch:

```bash
npm run release:patch
```

## License

Rollbridge is released under the [MIT License](LICENSE).
