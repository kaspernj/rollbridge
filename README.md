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
- `{{proxy.host}}`, `{{proxy.port}}`
- `{{env.<NAME>}}` — a variable from the daemon's own environment, e.g. `{{env.HOME}}`

Referencing a placeholder with no value (including an unset `{{env.<NAME>}}`)
fails the process start with a clear error, so typos surface immediately.

Production-ready examples live in `examples/`, including
`examples/tensorbuzz.com.js` for the current TensorBuzz backend deployment.

## Process Policies

- `proxied`: the web/API process. Rollbridge forwards HTTP and WebSocket traffic to the active release and tracks connections for draining.
- `companion`: a release-scoped support process. It starts with the release and stops after that release drains.
- `singleton`: a one-at-a-time support process. Rollbridge stops the old singleton before starting the new one, so duplicate-unsafe schedulers or job dispatchers do not overlap.
- `service`: a daemon-wide support process. Rollbridge starts it before release processes need it, leaves it running across deploys, and updates its restart template after a successful deploy.

## Commands

`--config` is optional for every command. When omitted, Rollbridge looks for
`rollbridge.js` in the current directory. The examples below pass `--config`
explicitly, but `rollbridge validate` (or any command) works with no flag when a
`rollbridge.js` is present.

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

## Deployment Notes

Run migrations before `rollbridge deploy`, and keep migrations backwards-compatible while old and new web releases overlap. For stable local brokers such as Velocious Beacon or `background-jobs-main`, use `service` when the process should survive deploys and restart from the latest successful release if it crashes.

## Releasing

Maintainers can publish a patch release from the latest default branch:

```bash
npm run release:patch
```
