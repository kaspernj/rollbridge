# Background-job generation deployment

This is the required Rollbridge lifecycle for a background-jobs runtime. A
generation is release-scoped and contains its own `background-jobs-main` plus
its worker pool. It is not just a set of workers attached to one persistent
coordinator.

## Process topology

Configure jobs-main as a handoff `service` on a multi-port range and the workers
as same-release `companion`s. Beacon may remain a shared persistent service on a
fixed port such as `7330`.

```js
{
  id: "background-jobs-main",
  policy: "service",
  deployStrategy: "handoff",
  command: "npx velocious background-jobs-main",
  port: {from: 7331, to: 7399}
},
{
  id: "background-jobs-worker",
  policy: "companion",
  env: {VELOCIOUS_BACKGROUND_JOBS_PORT: "{{ports.background-jobs-main}}"},
  command: "npx velocious background-jobs-worker",
  replicas: 4,
  nonBlockingDrain: true,
  gracefulStopMs: "indefinite"
}
```

Each worker receives its generation's jobs-main port. Old workers keep that port
for their entire lifetime; normal deploy draining never hands them to, or lets
them reconnect to, the new jobs-main. `replicas` scales the pool as
`background-jobs-worker#0`, `#1`, and so on.

## Deploy and retirement sequence

1. Before activation, Rollbridge starts the candidate release's jobs-main and
   complete worker pool, then starts and health-checks the candidate web process.
2. Activation switches new web traffic and makes the candidate jobs generation
   active.
3. The previous jobs generation retires as one unit. Its jobs-main stops schedule
   ownership, new queue dispatch, and new ordinary worker handoffs. Its workers
   stop accepting handoffs.
4. The old jobs-main stays running with its old workers. It continues owning
   their connections and heartbeats, lease fencing, terminal-report acceptance
   and acknowledgement, and durable store transitions. The old worker/reporting
   side durably retries terminal reports, tracks outstanding report promises,
   enforces per-job execution timeouts, and owns and reaps child runners.
5. Work returned or retried to the shared queue becomes eligible for the new
   active generation. The retired main never dispatches it again.
6. The old main and workers remain one release generation until every accepted
   handoff settles. Only then, after every old worker drains and exits, may the
   old jobs-main exit. Rollbridge then reaps the generation and reports that its
   release reference ended so Rampway can release the retention pin.

Old and new generations may overlap for hours, each running its own release code
and jobs-main endpoint. Multiple retired generations may drain concurrently.

## Deploy completion is independent

The deploy succeeds when the candidate release is activated and healthy. The
command and deploy lock do not wait for old jobs generations, workers, jobs,
HTTP/WebSocket connections, or other retained services to finish. The required
supervisor contract durably retains generations after the command returns and
across later deploys and supervisor/host recovery. Every referenced release
directory must be reported to Rampway and stays pinned against cleanup until the
last retained process exits. Current Rollbridge provides asynchronous draining
only for the lifetime of the current daemon; see the current-behavior notes in
[`docs/config.md`](config.md#processesdeploystrategy) and
[`docs/cli.md`](cli.md#deploy).

HTTP/WebSocket drain and jobs drain are independent. Set `nonBlockingDrain: true`
so workers stop accepting new handoffs when retirement starts rather than after
the connection drain. Closing or timing out HTTP connections must never kill a
still-draining jobs-main or worker pool.

## Timeouts and failures

`stopSignal`, `lifecycle`, and `gracefulStopMs` remain useful process-stop tools,
and the jobs framework should enforce per-job timeouts for genuinely hung work.
They are not the primary deployment solution. A legitimate multi-hour job makes
a multi-hour generation drain valid; do not turn a normal worker-shutdown timeout
into the deploy deadline.

If a worker connection is actually lost, its old jobs-main applies lease fencing
and the durable store transitions that make work eligible to return or retry.
Returned work may then run in the active generation. Normal retirement does not
simulate a disconnect and does not make a new jobs-main adopt the old worker's
handoffs.

See [`docs/velocious.md`](velocious.md) for the complete topology and
[`docs/config.md`](config.md#processesdeploystrategy) for handoff-service fields.
