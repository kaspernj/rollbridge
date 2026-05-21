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

```yaml
application: ticket-server

control:
  path: /tmp/rollbridge-ticket-server.sock

proxy:
  host: 127.0.0.1
  port: 8182
  healthPath: /ping
  healthTimeoutMs: 30000
  drainTimeoutMs: 60000
  forceStopTimeoutMs: 10000

processes:
  - id: beacon
    policy: companion
    cwd: "{{releasePath}}"
    command: "env VELOCIOUS_BEACON_PORT={{port}} npx velocious beacon"
    port:
      from: 17330
      to: 17399

  - id: background-jobs-worker
    policy: companion
    cwd: "{{releasePath}}"
    command: "npx velocious background-jobs-worker"

  - id: background-jobs-main
    policy: singleton
    cwd: "{{releasePath}}"
    command: "npx velocious background-jobs-main"

  - id: web
    policy: proxied
    cwd: "{{releasePath}}"
    command: "npx velocious server --host 127.0.0.1 --port {{port}}"
    port:
      from: 18182
      to: 18299
    health:
      path: /ping
      timeoutMs: 30000
```

Production-ready examples live in `examples/`, including
`examples/tensorbuzz.com.yml` for the current TensorBuzz backend deployment.

## Process Policies

- `proxied`: the web/API process. Rollbridge forwards HTTP and WebSocket traffic to the active release and tracks connections for draining.
- `companion`: a release-scoped support process. It starts with the release and stops after that release drains.
- `singleton`: a one-at-a-time support process. Rollbridge stops the old singleton before starting the new one, so duplicate-unsafe schedulers or job dispatchers do not overlap.

## Commands

Validate a config without starting the daemon:

```bash
rollbridge validate --config rollbridge.yml
```

`validate` reports every config error at once with an example fix and exits
non-zero when issues are found, so deploy tooling can gate on it. It checks
required fields and types, duplicate process IDs, port ranges, that exactly one
process is `proxied`, and that the proxied process defines a port range. Example
output for a misconfigured file:

```text
Found 2 configuration issues in rollbridge.yml:

1. Config must define exactly one proxied process; found 0
   Fix: Mark exactly one process with policy: proxied so Rollbridge knows where to forward traffic.

2. Duplicate process id: web
   Fix: Give each process a unique id; "web" is used more than once.
```

Start the daemon:

```bash
rollbridge daemon --config rollbridge.yml
```

Deploy a prepared release:

```bash
rollbridge deploy --config rollbridge.yml --release-path /home/dev/ticket-server/releases/20260521073000/ticket-server --revision abc123
```

Inspect state:

```bash
rollbridge status --config rollbridge.yml
```

Stop the active release:

```bash
rollbridge stop --config rollbridge.yml
```

Shut down the daemon and managed processes:

```bash
rollbridge shutdown --config rollbridge.yml
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

Run migrations before `rollbridge deploy`, and keep migrations backwards-compatible while old and new web releases overlap. For Velocious background jobs, keep `background-jobs-main` as `singleton` until Velocious has atomic job claiming.

## Releasing

Maintainers can publish a patch release from the latest default branch:

```bash
npm run release:patch
```
