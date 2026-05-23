# Background-job worker deployment

This guide covers deploying background-job workers (or any non-HTTP worker pool)
with Rollbridge so that in-flight jobs finish across a deploy. It uses features
that exist today; the command-based lifecycle hooks mentioned at the end are
still on the roadmap.

## Run workers as a `companion`

Give each worker the `companion` policy. Companions are **release-scoped**: every
release starts its own workers running that release's code, and a release's
workers are stopped only when that release is retired (drained) after a newer
release takes over. They start **before** the `proxied` web process, so they're
ready before traffic switches.

```js
{
  id: "worker",
  policy: "companion",
  cwd: "{{releasePath}}",
  command: "npx velocious background-jobs-worker"
}
```

## Scale the pool with `replicas`

Set `replicas` to run several identical workers (a port-less companion only).
Each instance runs as `worker#0`, `worker#1`, … and gets
`ROLLBRIDGE_REPLICA_INDEX` / `ROLLBRIDGE_REPLICA_COUNT` (and `{{replicaIndex}}` /
`{{replicaCount}}`), so an instance can claim a distinct shard, queue, or lock:

```js
{id: "worker", policy: "companion", command: "npx velocious background-jobs-worker", replicas: 4}
```

Restart the pool with `rollbridge restart --process worker` (all replicas) or a
single instance with `rollbridge restart --process worker#0`.

## Finish in-flight jobs on stop (`stopSignal` + `gracefulStopMs`)

When Rollbridge stops a worker — during a deploy's drain, a `rollbridge restart`,
or shutdown — it sends the worker's **`stopSignal`** (default `SIGTERM`), waits up
to **`gracefulStopMs`**, then `SIGKILL`s it if it hasn't exited. That window is
the worker's chance to finish its current job and exit cleanly.

- Set `stopSignal` to the signal your worker quiets/drains on. Many job runners
  finish the current job and exit on `SIGTERM` (the default); some use `SIGINT`
  or `SIGQUIT`. Use the one your worker treats as "drain and exit".
- Set `gracefulStopMs` to at least your longest job's duration, so a job in
  progress is not cut off by the `SIGKILL` fallback.

```js
{
  id: "worker",
  policy: "companion",
  command: "npx velocious background-jobs-worker",
  replicas: 4,
  stopSignal: "SIGTERM",
  gracefulStopMs: 60000
}
```

## What happens across a deploy

1. The new release's workers start (running the **new** code) before traffic
   switches to the new web process.
2. Both old and new workers run while the previous release drains, so **both
   code versions consume the shared queue at once.** Keep job code
   backwards-compatible across a deploy — the same rule as database migrations.
3. When the previous release is retired (its HTTP/WebSocket connections close or
   `proxy.drainTimeoutMs` elapses), its workers are stopped: `stopSignal`, then
   `SIGKILL` after `gracefulStopMs`.

Because old workers are retired on the release's **connection** drain (not on
their own job queue draining), a job still running when the release is retired
gets only the `gracefulStopMs` window to finish. Keep jobs **idempotent and
safe to retry** so a job interrupted at the `SIGKILL` fallback can run again.

## Roadmap: command-based lifecycle hooks

Today the safe-stop mechanism is signal-based (`stopSignal` + `gracefulStopMs`).
Command-based lifecycle hooks (a `quietCommand` to stop accepting work, a
`drainCommand` / `drainTimeoutMs` to wait for the queue to drain, and a
`stopCommand`), plus a **non-blocking drain** mode that starts new workers while
old ones finish, are on the [roadmap](../TODO.md#major-features) and not yet
implemented.

See [`docs/config.md`](config.md) for `stopSignal`, `replicas`, and
`gracefulStopMs`, and [`docs/velocious.md`](velocious.md) for a full Velocious
deployment (Beacon, jobs-main, workers, web) example.
