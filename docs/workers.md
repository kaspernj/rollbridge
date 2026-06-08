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
  progress is not cut off by the `SIGKILL` fallback. Use `"indefinite"` only for
  workers that are safe to leave draining until they exit on their own.

```js
{
  id: "worker",
  policy: "companion",
  command: "npx velocious background-jobs-worker",
  replicas: 4,
  stopSignal: "SIGTERM",
  gracefulStopMs: "indefinite"
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
gets only the `gracefulStopMs` window to finish, unless `gracefulStopMs` is
`"indefinite"`. Keep jobs **idempotent and safe to retry** so a job interrupted
at a finite `SIGKILL` fallback can run again.

## Command-based lifecycle hooks

For workers that quiesce or drain via a command rather than a single signal, set
a `lifecycle` block. When Rollbridge gracefully stops the worker it runs
`quietCommand` (stop accepting new work), then drains (`drainCommand`, or waits up
to `drainTimeoutMs` for the worker to exit), then `stopCommand` or `stopSignal`,
then `SIGKILL` after `gracefulStopMs`. Each hook gets `ROLLBRIDGE_PID` and is
bounded by a timeout, so a slow hook can't wedge a deploy.

```js
{
  id: "worker",
  policy: "companion",
  command: "npx velocious background-jobs-worker",
  replicas: 4,
  lifecycle: {quietCommand: "kill -TSTP -$ROLLBRIDGE_PID", drainTimeoutMs: 60000}
}
```

See [`docs/config.md`](config.md#processeslifecycle) for the hook reference.

## Non-blocking drain

By default a retired release's workers are stopped only after the proxied
process's connections have drained. Set `nonBlockingDrain: true` on a worker
companion whose work is independent of the web process (a job worker on a shared
queue) to start its graceful stop **immediately** when the release is retired —
in parallel with the connection drain. The new release's workers handle new work
while the old workers finish their in-flight jobs:

```js
{id: "worker", policy: "companion", command: "…", nonBlockingDrain: true, gracefulStopMs: "indefinite"}
```

See [`docs/config.md`](config.md) for `stopSignal`, `replicas`, and
`gracefulStopMs`, and [`docs/velocious.md`](velocious.md) for a full Velocious
deployment (Beacon, jobs-main, workers, web) example.
