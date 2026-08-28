# Velocious deployment guide

A Velocious backend normally runs Beacon, `background-jobs-main`, a
`background-jobs-worker` pool, and the web/API server. For deploy lifecycle
purposes, jobs-main and its workers are one release-scoped **jobs generation**.
This topology is required; a single persistent fixed-port jobs-main is not a
safe coordinator for workers that may drain across releases.

This page states the architecture contract. It does not by itself assert that a
particular Rollbridge release or consumer production config implements durable
retired-generation recovery; verify source and config before claiming compliance.

## Process mapping

| Velocious process | Rollbridge policy | Lifecycle |
| --- | --- | --- |
| `beacon` | persistent `service` | Shared broker; it may remain daemon-wide on fixed port `7330`. |
| `background-jobs-main` | `service` with `deployStrategy: "handoff"` | One endpoint per release; owns worker connections, lease fencing, report acceptance/acknowledgement, and durable store transitions. |
| `background-jobs-worker` | `companion` with `nonBlockingDrain: true` | Release-scoped pool; executes accepted work, owns child runners and execution timeouts, and durably retries terminal reports while tracking their promises. |
| `web` | `proxied` | Health-gated active HTTP/WebSocket target with a per-release port. |

## Example `rollbridge.js`

```js
export default {
  application: "tensorbuzz",
  control: {path: "/tmp/rollbridge-tensorbuzz.sock"},
  statePath: "/var/lib/rollbridge/tensorbuzz.json",
  ownerRecovery: {reconnectGraceMs: 30000},

  proxy: {
    host: "127.0.0.1",
    port: 4500,
    healthPath: "/ping",
    healthTimeoutMs: 30000,
    drainTimeoutMs: 60000,
    forceStopTimeoutMs: 10000
  },

  processes: [
    {
      id: "beacon",
      policy: "service",
      cwd: "{{releasePath}}/backend",
      env: {NODE_ENV: "production", VELOCIOUS_BEACON_PORT: "{{port}}"},
      command: "npx velocious beacon",
      port: 7330
    },
    {
      id: "background-jobs-main",
      policy: "service",
      deployStrategy: "handoff",
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{ports.beacon}}",
        VELOCIOUS_BACKGROUND_JOBS_PORT: "{{port}}"
      },
      command: "wait-for-it 127.0.0.1:{{ports.beacon}} --strict -- npx velocious background-jobs-main",
      lifecycle: {quietCommand: "appctl jobs-main-retire --pid $ROLLBRIDGE_PID"},
      port: {from: 7331, to: 7399}
    },
    {
      id: "background-jobs-worker",
      policy: "companion",
      nonBlockingDrain: true,
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{ports.beacon}}",
        VELOCIOUS_BACKGROUND_JOBS_PORT: "{{ports.background-jobs-main}}"
      },
      command: "wait-for-it 127.0.0.1:{{ports.background-jobs-main}} --strict -- npx velocious background-jobs-worker",
      replicas: 4,
      gracefulStopMs: "indefinite"
    },
    {
      id: "web",
      policy: "proxied",
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{ports.beacon}}",
        VELOCIOUS_BACKGROUND_JOBS_PORT: "{{ports.background-jobs-main}}"
      },
      command: "wait-for-it 127.0.0.1:{{ports.background-jobs-main}} --strict -- npx velocious server --host 127.0.0.1 --port {{port}}",
      port: {from: 14500, to: 14599},
      health: {path: "/ping", timeoutMs: 30000, intervalMs: 500}
    }
  ]
}
```

`appctl` is a placeholder for a reviewed Velocious/application integration that
quiesces jobs-main admission without terminating its worker/report endpoint.

Beacon keeps its fixed port because it is intentionally shared. Jobs-main uses a
range because every release gets its own coordinator. Same-release
`{{ports.background-jobs-main}}` expansion ensures that old workers retain the
old endpoint while candidate workers use the candidate endpoint.

## Deploy and activation

Run backwards-compatible migrations before activation, then invoke
`rollbridge deploy` with the prepared release. Rollbridge starts the candidate
jobs-main, its complete worker pool, and the web process before health gating and
activation. A candidate startup or health failure leaves the previous release
active.

After successful activation, the deploy returns without waiting for any retired
generation or HTTP/WebSocket connection to finish. The old and new release code
may therefore overlap for hours. Keep schema, queue payloads, and external side
effects compatible across that window.

## Retired jobs-generation contract

Retire jobs-main and its workers as one unit:

- jobs-main relinquishes recurring schedule ownership and stops dispatching
  queued work or making new worker handoffs;
- workers stop advertising or accepting new handoffs;
- jobs-main remains running on the old endpoint and owns worker connections and
  heartbeats, lease fencing, terminal-report acceptance and acknowledgement, and
  durable store transitions for its accepted handoffs;
- the old worker/reporting side durably retries terminal reports, tracks
  outstanding report promises, enforces per-job execution timeouts, and owns and
  reaps child runners;
- a job returned or retried to the shared queue becomes eligible for the new
  active generation, and the retired main never dispatches it again;
- old workers never reconnect to or transfer their handoffs to the new jobs-main;
- old main and workers remain one release generation until all accepted work
  settles; jobs-main exits only after that and after all workers drain and exit,
  after which Rollbridge may reap the generation.

HTTP/WebSocket and jobs drains are independent. `proxy.drainTimeoutMs` bounds the
connection drain only; reaching it must not stop a still-draining jobs generation.
`nonBlockingDrain: true` starts worker quiescence at retirement rather than after
the HTTP drain.

The process supervisor must retain multiple old generations concurrently,
persist their ownership across later deploys and supervisor/host recovery, and
report every referenced release directory so Rampway can pin it against cleanup.
A runtime owner/version handoff preserves or transfers that supervision and
returns after the replacement is healthy; it is not a full synchronous shutdown.

Rollbridge implements post-activation quiescence, concurrent endpoints,
asynchronous generation drain, and `status.releaseReferences`. With
`ownerRecovery`, a same-authority replacement reconnects to the guardian rather
than adopting arbitrary PIDs. Atomic incompatible owner/config/socket/package
upgrades through `--takeover-owner` remain a required follow-up.

## Timeouts

Velocious per-job timeouts remain responsible for genuinely hung work. Rollbridge
stop signals, lifecycle hooks, and graceful-stop bounds remain emergency/process
controls. Do not use a short normal worker-shutdown timeout to make deployment
complete: deployment is already complete after healthy activation, and a
legitimate hours-long job makes an hours-long generation drain valid.

## Verification

After a deploy, status must be able to show the active generation and every
retired generation still draining, including each jobs-main endpoint, worker
pool, release path, and retention reference. Beacon may keep `7330`; active and
retired jobs-main instances must use different ports. Confirm that the deploy
command has returned even while retained generations remain and that an HTTP
drain timeout does not terminate them.

See [`docs/workers.md`](workers.md) for the focused lifecycle,
[`docs/config.md`](config.md) for configuration fields, and
[`docs/tensorbuzz-runbook.md`](tensorbuzz-runbook.md) for the consumer runbook.
