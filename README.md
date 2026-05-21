# Switchyard

Switchyard is a Node.js process supervisor and local traffic switcher for zero-downtime deploys.

Nginx points at one stable Switchyard proxy port. Deploy tooling asks Switchyard to start a new release, health-check it, switch new traffic to it, and drain old HTTP/WebSocket connections before stopping the previous release.

## Install

```bash
npm install @kaspernj/switchyard
```

For local development in this repository:

```bash
npm install
npm test
```

## Config

```yaml
application: ticket-server

control:
  path: /tmp/switchyard-ticket-server.sock

proxy:
  host: 127.0.0.1
  port: 8182
  healthPath: /ping
  healthTimeoutMs: 30000
  drainTimeoutMs: 60000
  forceStopTimeoutMs: 10000

processes:
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

  - id: beacon
    policy: companion
    cwd: "{{releasePath}}"
    command: "env VELOCIOUS_BEACON_PORT={{port}} npx velocious beacon"
    port:
      from: 17330
      to: 17399

  - id: background-jobs-main
    policy: singleton
    cwd: "{{releasePath}}"
    command: "npx velocious background-jobs-main"
```

## Process Policies

- `proxied`: the web/API process. Switchyard forwards HTTP and WebSocket traffic to the active release and tracks connections for draining.
- `companion`: a release-scoped support process. It starts with the release and stops after that release drains.
- `singleton`: a one-at-a-time support process. Switchyard stops the old singleton before starting the new one, so duplicate-unsafe schedulers or job dispatchers do not overlap.

## Commands

Start the daemon:

```bash
switchyard daemon --config switchyard.yml
```

Deploy a prepared release:

```bash
switchyard deploy --config switchyard.yml --release-path /home/dev/ticket-server/releases/20260521073000/ticket-server --revision abc123
```

Inspect state:

```bash
switchyard status --config switchyard.yml
```

Stop the active release:

```bash
switchyard stop --config switchyard.yml
```

Shut down the daemon and managed processes:

```bash
switchyard shutdown --config switchyard.yml
```

## Nginx

Nginx should proxy to Switchyard, not directly to Velocious:

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

Run migrations before `switchyard deploy`, and keep migrations backwards-compatible while old and new web releases overlap. For Velocious background jobs, keep `background-jobs-main` as `singleton` until Velocious has atomic job claiming.
