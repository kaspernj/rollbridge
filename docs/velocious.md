# Velocious deployment guide

A Velocious backend typically runs four kinds of process: **Beacon** (the
message broker other processes connect to), **background-jobs-main** (the job
coordinator), **background-jobs-worker** (runs the jobs), and the **web/API**
server. This guide maps each to a Rollbridge process policy, shows a complete
`rollbridge.js`, and explains startup ordering and what happens on a deploy.

A production version of this config lives at
[`examples/tensorbuzz.com.js`](../examples/tensorbuzz.com.js).

## Process mapping

| Velocious process | Policy | Why |
| --- | --- | --- |
| `beacon` | `service` | A shared broker the other processes connect to. It should survive deploys and keep a **stable port**, so workers and the web process always reach the same Beacon. |
| `background-jobs-main` | `service` (or `singleton`) | The job coordinator. Run it as a `service` when it should outlive releases on a stable port; run it as a `singleton` when it must run the latest release's code after every deploy (see [Choosing the jobs-main policy](#choosing-the-jobs-main-policy)). |
| `background-jobs-worker` | `companion` | Release-scoped: one set of workers per active release, started before the web process and running that release's code. |
| `web` | `proxied` | Receives external HTTP/WebSocket traffic, is health-checked before traffic switches, and is drained on the next deploy. Exactly one process is `proxied`. |

See [README → Process Policies](../README.md#process-policies) for the full
semantics of each policy and [`docs/config.md`](config.md) for every field.

## Example `rollbridge.js`

```js
// rollbridge.js
export default {
  application: "tensorbuzz",
  control: {path: "/tmp/rollbridge-tensorbuzz.sock"},

  proxy: {
    host: "127.0.0.1",
    port: 4500,          // the stable port Nginx points at
    healthPath: "/ping",
    healthTimeoutMs: 30000,
    drainTimeoutMs: 60000,
    forceStopTimeoutMs: 10000
  },

  processes: [
    // Shared broker — one daemon-wide instance on a stable port.
    {
      id: "beacon",
      policy: "service",
      cwd: "{{releasePath}}/backend",
      env: {NODE_ENV: "production", VELOCIOUS_BEACON_PORT: "{{port}}"},
      command: "npx velocious beacon",
      port: 7330
    },

    // Job coordinator — waits for Beacon, stable port other jobs processes use.
    {
      id: "background-jobs-main",
      policy: "service",
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{ports.beacon}}",
        VELOCIOUS_BACKGROUND_JOBS_PORT: "{{port}}"
      },
      command: "wait-for-it 127.0.0.1:{{ports.beacon}} --strict -- npx velocious background-jobs-main",
      port: 7331
    },

    // Workers — one set per release; raise gracefulStopMs to let in-flight
    // jobs finish during a deploy.
    {
      id: "background-jobs-worker",
      policy: "companion",
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{ports.beacon}}",
        VELOCIOUS_BACKGROUND_JOBS_PORT: "{{ports.background-jobs-main}}"
      },
      command: "wait-for-it 127.0.0.1:{{ports.beacon}} --strict -- wait-for-it 127.0.0.1:{{ports.background-jobs-main}} --strict -- npx velocious background-jobs-worker",
      gracefulStopMs: 60000
    },

    // Web/API — the one proxied process.
    {
      id: "web",
      policy: "proxied",
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{ports.beacon}}",
        VELOCIOUS_BACKGROUND_JOBS_PORT: "{{ports.background-jobs-main}}"
      },
      command: "wait-for-it 127.0.0.1:{{ports.beacon}} --strict -- wait-for-it 127.0.0.1:{{ports.background-jobs-main}} --strict -- npx velocious server --host 127.0.0.1 --port {{port}}",
      port: {from: 14500, to: 14599},
      health: {path: "/ping", timeoutMs: 30000, intervalMs: 500}
    }
  ]
}
```

## Wiring processes together

Beacon and `background-jobs-main` get **fixed** ports (`7330`, `7331`) because
they are `service`s — a stable port lets every release's workers and web process
find them. The proxied `web` process gets a **range** (`{from: 14500, to:
14599}`); Rollbridge allocates a free port per release so the old and new web
releases can run side by side during the drain.

Cross-reference ports with `{{ports.<id>}}` and pass them to Velocious through
`env`. Rollbridge also injects `ROLLBRIDGE_<ID>_PORT` for every process (e.g.
`ROLLBRIDGE_BACKGROUND_JOBS_MAIN_PORT`), so you can read ports from the
environment instead of templating if you prefer — see
[`docs/config.md`](config.md#injected-environment-variables).

### Startup ordering

Only the `proxied` process is health-checked, so dependent processes must wait
for their dependencies themselves. Two mechanisms combine:

1. **Policy ordering.** On each deploy Rollbridge starts `service`s first, then
   the release's `companion`s, then the `proxied` process (see
   [README → Deploy ordering](../README.md#deploy-ordering)).
2. **Readiness gating.** `wait-for-it 127.0.0.1:{{ports.beacon}} --strict -- …`
   blocks the command until Beacon's port accepts connections, so
   `background-jobs-main`, the worker, and `web` don't start talking to Beacon
   before it is listening. `wait-for-it` is a small standalone script (install it
   on the host); any equivalent port-wait works.

## Deploying

Drive deploys through the Rollbridge CLI — Rollbridge ships no deploy-tool
plugins (see [`docs/deploy-recipes.md`](deploy-recipes.md) for shell/CI/Capistrano
recipes). The minimal step after a release directory is prepared:

```bash
release_path=/srv/tensorbuzz/releases/20260523120000  # prepared by your pipeline

# Run backwards-compatible migrations BEFORE switching traffic: the old and new
# web releases overlap during the drain.
(cd "$release_path/backend" && npx velocious db:migrate)

rollbridge deploy \
  --ensure-daemon \
  --config /etc/rollbridge/rollbridge.js \
  --release-path "$release_path" \
  --revision "$(git -C "$release_path/backend" rev-parse HEAD)"
```

`rollbridge deploy` starts the new release's worker and web process,
health-checks `web` on its `{{port}}`/`/ping`, switches traffic, then drains and
stops the previous release. It exits non-zero (leaving the previous release
active) if the new release fails to start or health-check, so a failed deploy
never promotes a broken release.

## Background jobs across a deploy

The worker is a `companion`, so each release runs its own workers:

- On deploy, the **new** release's workers start (running the new code) before
  traffic switches; the **old** release's workers are stopped when that release
  is drained and retired — the worker's `stopSignal`, then `SIGKILL` after
  `gracefulStopMs`.
- Set `stopSignal` to the signal your worker drains on and `gracefulStopMs` to at
  least your longest in-flight job, so a job gets time to finish before the
  forced kill. Set `replicas` to run a pool of workers.

See [`docs/workers.md`](workers.md) for the full safe background-job deployment
pattern (companion + `replicas` + `stopSignal`/`lifecycle` hooks +
`gracefulStopMs`), the old/new worker overlap, and what's still on the roadmap (a
non-blocking drain mode).

### Choosing the jobs-main policy

`background-jobs-main` is duplicate-unsafe (you never want two coordinators), so
it is either a `service` or a `singleton` — never a `companion`:

- **`service`** — keeps running across deploys on its stable port. Workers from
  every release talk to the same coordinator, so there's no coordination gap on
  deploy. The trade-off: a `service` keeps running the **release it was started
  from** and only adopts the latest release's template if it crashes and
  restarts (or the daemon restarts). If `background-jobs-main` itself needs the
  newest code immediately after every deploy, this is the wrong policy.
- **`singleton`** — Rollbridge stops the old instance and then starts the new
  one on each deploy, so it always runs the latest release's code and two copies
  never overlap. The trade-off: a brief coordination gap while it restarts.

Beacon is a broker rather than code that changes per release, so `service` is
almost always right for it.

## Verifying

After a deploy, `rollbridge status` should show `beacon` and
`background-jobs-main` as long-lived `service`s with unchanged ports across
deploys, one `background-jobs-worker` for the active release, and the `web`
process `proxied` with its connection counts. Use
[`rollbridge logs --process <id>`](cli.md) to read recent output from any
process, and [`docs/troubleshooting.md`](troubleshooting.md) for health-check,
port, and draining problems.

For the front end, point Nginx at the stable `proxy.port` (here `4500`), never at
a release's web port — see [`docs/nginx.md`](nginx.md).
