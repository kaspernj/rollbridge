# TensorBuzz Rollbridge runbook

This runbook defines the required TensorBuzz backend topology. The example at
[`examples/tensorbuzz.com.js`](../examples/tensorbuzz.com.js) is illustrative;
verify the deployed consumer config and Rollbridge implementation before
asserting production compliance.

## Ports and generations

| Port | Process | Contract |
| --- | --- | --- |
| `4500` | Rollbridge proxy | Stable public upstream for Nginx. |
| `7330` | Beacon | Shared persistent service; fixed port is allowed. |
| `7331`–`7399` | `background-jobs-main` | One allocated endpoint per release generation; never one fixed persistent coordinator. |
| `14500`–`14599` | web | One proxied endpoint per release. |
| none | workers | Same-release companions connected only to their generation's jobs-main. |

Each jobs generation contains one jobs-main and its complete worker pool, all
running the same release code. Several old generations may continue draining
while a newer generation is active.

## Required deploy order

1. Prepare the candidate release and run backwards-compatible migrations.
2. Start the candidate jobs-main on a new port, then its worker pool and web
   process. Health-check web before activation.
3. Activate the candidate release and switch new traffic.
4. Retire the previous jobs-main and workers as one generation. Jobs-main stops
   schedule ownership, new dispatch, and new handoffs; workers stop accepting
   handoffs.
5. Return deploy success and release the deploy lock. Do not wait for old jobs,
   workers, jobs-main, HTTP/WebSocket connections, or other retained services.

The retired jobs-main remains running on its old endpoint with its old workers.
It supervises the handoffs it already made: connections and heartbeats,
completion/failure acknowledgements, report retries, job timeouts, child reaping,
and durable transitions. Returned or retried work becomes eligible for the new
active generation and is never redispatched by the retired main. Old workers do
not reconnect to or transfer their handoffs to the new main.

Only after every owned handoff settles and every old worker exits may jobs-main
exit and Rollbridge reap the generation. The referenced release directory stays
pinned against Rampway cleanup until that point.

## Independent drains

Set the worker companion to `nonBlockingDrain: true` so it quiesces when its
generation retires. HTTP/WebSocket connection drain continues independently.
Finishing or timing out the HTTP drain must never stop a still-draining jobs
generation. A legitimate multi-hour job and generation drain are valid.

Per-job timeouts remain the backstop for genuinely hung jobs. Do not use a short
worker-shutdown or supervisor timeout as the primary deploy solution; deployment
has already completed after candidate activation and health.

## Runtime-owner and recovery requirements

Rollbridge durably supervises every retired generation after the deploy command
returns, across later deploys and supervisor/host recovery. Runtime-owner or
version handoff must preserve or transfer that supervision and return once the
replacement is healthy. It must not perform full synchronous shutdown, kill
retained generations, or make the new jobs-main adopt old workers.

Recovery must reconstruct retained generation ownership, endpoints, release
paths, and process references. Do not treat them as generic orphans to force-stop
merely because a supervisor restarted. Cleanup becomes eligible only after the
last retained process exits.

## Operator checks

Use `rollbridge status`, logs, and events to confirm:

- the active jobs generation uses the active release and a unique jobs-main port;
- every retired generation retains its own jobs-main, workers, endpoint, and
  pinned release path;
- the deploy command has returned while long drains continue;
- no retired jobs-main is dispatching new ordinary queued work;
- HTTP drain completion or timeout did not stop a jobs generation; and
- completed generations are reaped and Rampway is told their release references
  ended so it can release the pins.

Do not restart Beacon or a jobs-main casually. Never use `shutdown`, forced
orphan recovery, or process signals as a substitute for the normal retained-
generation lifecycle. See [`docs/velocious.md`](velocious.md) and
[`docs/workers.md`](workers.md) for the architecture details.
