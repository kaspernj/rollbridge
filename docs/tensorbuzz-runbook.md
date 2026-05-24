# TensorBuzz production runbook

Operating the TensorBuzz backend under Rollbridge. The production config lives at
[`examples/tensorbuzz.com.js`](../examples/tensorbuzz.com.js); this runbook
assumes it is deployed to a stable path (`/etc/rollbridge/tensorbuzz.com.js`
below) and the daemon runs as a systemd service (see
[Running under systemd](../README.md#running-under-systemd)). For the general
Velocious topology and the worker recipe, see [`docs/velocious.md`](velocious.md).

## Ports

| Port | Process | Notes |
| --- | --- | --- |
| `4500` | Rollbridge proxy | The stable public port. **Nginx proxies the backend host to `127.0.0.1:4500`** — never to a release's web port. |
| `7330` | `beacon` (`service`) | Fixed; the shared broker every release connects to. |
| `7331` | `background-jobs-main` (`service`) | Fixed; the job coordinator. |
| `14500`–`14599` | `web` (`proxied`) | One port per release, allocated per deploy; Rollbridge forwards `4500` here. |
| (none) | `background-jobs-worker` (`companion`) | A per-release worker; no listening port. |

Control socket: `/tmp/rollbridge-tensorbuzz.sock`.

## Process topology

- **`beacon`** and **`background-jobs-main`** are `service`s: one daemon-wide
  instance each, on their fixed ports, surviving deploys.
- **`background-jobs-worker`** is a `companion`: a fresh worker per release,
  running that release's code, with `gracefulStopMs: 60000` so an in-flight job
  finishes before `SIGKILL`.
- **`web`** is the one `proxied` process, health-checked at `/ping` before
  traffic switches.

Each process waits for its dependencies with `wait-for-it` (`beacon` →
`background-jobs-main` → `worker`/`web`), so nothing starts talking to Beacon or
the job coordinator before they listen.

## External services

Rollbridge manages **only the four processes above**. Everything else the
Velocious app depends on — the database and any other backing services — is
**provisioned and operated outside Rollbridge**: Rollbridge does not start, stop,
health-check, or know about them. Configure those connections through the app's
own environment/config. When such a dependency is down, the `web` process's
`/ping` health check is what gates a deploy (a release that can't reach its
database won't pass health and won't go live).

## Deploying

Drive deploys through the CLI (see [`docs/deploy-recipes.md`](deploy-recipes.md)).
Run **backwards-compatible** migrations before switching traffic, because the old
and new releases overlap during the drain:

```bash
release_path=/srv/tensorbuzz/releases/<timestamp>     # prepared by your pipeline
(cd "$release_path/backend" && npx velocious db:migrate)

rollbridge deploy \
  --ensure-daemon \
  --config /etc/rollbridge/tensorbuzz.com.js \
  --release-path "$release_path" \
  --revision "$(git -C "$release_path/backend" rev-parse HEAD)"
```

### Deploy ordering

On `rollbridge deploy`, Rollbridge:

1. starts any missing `service` (`beacon`, `background-jobs-main`);
2. starts the new release's `background-jobs-worker`, then its `web` process, and
   health-checks `web` on its `{{port}}`/`/ping`;
3. switches new traffic to the new `web`;
4. refreshes the services' restart templates to the new release;
5. drains the previous release's connections, then stops its `web` and worker.

If the new release fails to start or health-check, **the previous release stays
active** and the command exits non-zero — so a failed deploy never takes the site
down.

## Rollback

```bash
rollbridge rollback --config /etc/rollbridge/tensorbuzz.com.js
# or a specific retained release:
rollbridge rollback --config /etc/rollbridge/tensorbuzz.com.js --release-id <id>
```

Rollback re-runs the deploy flow on a retained release, health-checks it, and
switches traffic back. Constraints:

- **Migrations are not reverted.** Rollback only manages processes; if a release
  bumped the schema, rolling code back requires that the old code still works
  against the new schema — keep migrations backwards-compatible (the same rule as
  deploys).
- The target release's on-disk directory must still exist (don't prune it from
  disk before you might roll back to it).
- Only releases Rollbridge still retains (`releaseRetention`) can be targeted.

## Day-to-day operations

```bash
C=/etc/rollbridge/tensorbuzz.com.js

rollbridge status  --config "$C"                 # active release, ports, per-process state
rollbridge logs    --config "$C" --process web   # recent stdout/stderr of a process
rollbridge events  --config "$C"                 # deploys, switches, crashes, restarts
rollbridge doctor  --config "$C"                 # pre-flight: socket, proxy port, state
rollbridge restart --config "$C" --process background-jobs-worker   # bounce the worker
```

Restarting `beacon` or `background-jobs-main` bounces a shared broker and briefly
disrupts everything that depends on it; prefer `deploy`/`rollback` for code
changes. See [`docs/troubleshooting.md`](troubleshooting.md) for health-check
failures, port conflicts, stale sockets, crash loops, and stuck draining
releases.

## Crash recovery

Set [`statePath`](config.md#statepath) in the config to have the daemon persist
its state. After a daemon crash or reboot, `rollbridge doctor` reports any
**orphaned** processes still alive from the previous daemon. To clean them up
before restarting the daemon, run `rollbridge recover` (a dry run that lists
them), then `rollbridge recover --force` to stop them:

```bash
rollbridge recover --config /etc/rollbridge/tensorbuzz.com.js          # list leftovers
rollbridge recover --config /etc/rollbridge/tensorbuzz.com.js --force  # stop them
```

A machine reboot kills every process, so there are usually no orphans afterward —
the daemon just starts fresh.
