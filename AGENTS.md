# Rollbridge contributor guidance

Rollbridge is the process supervisor and local traffic switcher. Keep deployment
tool concerns outside this repository: Rampway owns activation transactions,
deploy locks, release-retention metadata, and on-disk cleanup; Rollbridge owns
process lifecycle, retained generations, ports, and recovery state.

## Background-jobs lifecycle invariant

- One runtime generation is one release-scoped `background-jobs-main` plus its
  worker pool. Start the complete candidate generation before activation.
- After activation, retire the old generation as one unit. Its main stops
  schedules, new dispatch, and new ordinary worker handoffs; its workers stop
  accepting handoffs. The old main remains running with those workers and owns
  their connections, lease fencing, report acceptance and acknowledgement, and
  durable store transitions. The worker/reporting side durably retries terminal
  reports, tracks outstanding report promises, enforces per-job execution
  timeouts, and owns and reaps child runners. Main and workers remain one release
  generation until every accepted handoff settles.
- Returned or retried work may be dispatched by the new active generation. A
  retired main never dispatches it again. Old workers never reconnect or hand
  over to the new main during a normal deploy.
- Jobs generations may overlap for hours on release-scoped endpoints. Beacon may
  remain shared on `7330`; jobs-main must use a per-release port range.
- Deploy success is candidate activation and health. Deploy completion must not
  wait for retired jobs generations, workers, jobs, HTTP/WebSocket connections,
  or other retained services. HTTP and jobs drains are independent; an HTTP
  drain finishing or timing out must not stop a live jobs generation.
- Persist and recover retired-generation ownership across later deploys and
  supervisor/host recovery. Multiple generations may drain concurrently. Report
  release references so the deployment tool can keep them pinned until no
  retained process uses them.
- Runtime-owner replacement transfers or preserves this durable supervision and
  returns once the replacement is healthy. It is never a synchronous full
  shutdown. Per-job timeouts remain valid, but a normal worker-shutdown timeout
  is not the deploy solution; legitimate multi-hour drains are valid.

Documentation must distinguish required architecture from behavior not yet
implemented. Do not claim production compliance when source/config still uses a
fixed jobs-main, worker adoption by a new main, destructive orphan recovery, or
synchronous cleanup.

Current same-authority behavior quiesces configured handoff services after
candidate activation, retains concurrent generations, reports live release
references, and can opt into `ownerRecovery` so a durable process guardian
preserves and reconstructs active/draining generations after daemon process
exit. With `ownerRecovery` and the same `statePath` transaction anchor,
`ensure-daemon` also replaces incompatible config, control-socket, package, and
runtime owners through a guardian-fenced candidate-first handoff while retaining
active and draining generations. The first authenticated upgrade from a genuine
pre-replacement guardian/daemon is a documented disruptive compatibility bridge:
it preserves exact supervised processes and state, but may close proxy/control
connections. Every protocol-capable replacement after that bridge is atomic.
`--takeover-owner` remains a destructive
external-supervisor migration path, not that atomic handoff.

## Validation and publication

The project is ESM JavaScript with JSDoc type checking. Package scripts are the
source of truth: `npm run typecheck`, `npm run lint`, `npm test`, and the combined
`npm run all-checks`. Run focused checks for the files changed; documentation-only
work requires at least `git diff --check` plus any existing repository-owned
Markdown/link check, without installing dependencies.

Work on a feature branch and open a normal pull request against `master`; never
push feature work directly to `master`. Releases are maintainer-only and use
`npm run release:patch` from an up-to-date clean default branch after
`npm run all-checks`; do not edit package versions or publish during ordinary PR
work. See `docs/releasing.md` for the complete release checklist.
