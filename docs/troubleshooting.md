# Troubleshooting

## Legacy or mismatched daemon runtime

**Symptom.** `deploy --ensure-daemon` or `ensure-daemon` reports that the
running daemon has a legacy or mismatched runtime and confirms that the deploy
was not sent.

**Cause.** A daemon already owns the stable proxy/control socket, but Rollbridge
cannot authenticate and attest an allowed owner transition.

**Fix.** With `ownerRecovery`, a genuine pre-owner-replacement Rollbridge daemon
and guardian can cross the documented one-time disruptive bridge automatically.
Its existing proxy/control connections may close; successful status reports
`ownerTransition.mode: "legacy-first-upgrade"`. Keep the incumbent config
identity unchanged for that first invocation, then apply config/socket changes
through the now-atomic replacement protocol. Do not treat arbitrary `Unknown
command`, authentication, transport, malformed-response, or identity errors as
legacy evidence: those intentionally fail closed and require repairing the
reported authority or local socket/state problem. Without `ownerRecovery`, plan
an explicit supervised restart during a safe handoff. If durable runtime
preparation itself fails, check permissions for
`--daemon-runtime-path` (default
`/tmp/rollbridge-<user-id>-<application-hash>-runtime`) before retrying. The directory
must be private to the invoking user.

If startup instead reports `Rollbridge daemon candidate <pid> exited before
readiness`, the ensuring CLI observed that exact child exit before it could
attest status. The diagnostic includes the exit code or signal and spawned
arguments. Inspect the configured `--daemon-log-path` for that PID's startup
failure; this is distinct from a control-socket readiness timeout.

Start with these three commands — they diagnose most problems without guessing:

- `rollbridge validate` — config errors, with an example fix for each.
- `rollbridge doctor` — control socket reachability, socket-directory writability, and proxy-port availability before the daemon starts.
- `rollbridge status` / `rollbridge logs` — live release/process state, restart counts, exit codes, connection counts, and recent process output.

For scripting, `validate`, `doctor`, and `logs` accept a `--json` flag, and
`status` already prints JSON — so every command's output is easy to parse.

## Health-check failures

**Symptom.** `rollbridge deploy` exits non-zero with:

```
Health check failed for http://127.0.0.1:18182/ping: HTTP 503
```

(the reason is `HTTP <status>` or a connection error such as `ECONNREFUSED`). The
new release never went live; the previous release stays active.

**Diagnose.** The new release's `proxied` process didn't return a healthy
response in time. Check its output with `rollbridge logs --process <id>` and its
state/`exitCode` with `rollbridge status`. Common causes: the app doesn't listen
on the templated `{{port}}`, the `health.path` returns a non-2xx status, or the
app boots slower than `health.timeoutMs`.

**Fix.** Make the proxied command bind `{{port}}` and serve `health.path` with a
2xx status. For slow boots, raise `health.timeoutMs` or set `health.startDelayMs`
so probing begins after the app is up.

## Port conflicts / exhausted ranges

**Symptom.** A deploy fails with:

```
No available ports in range 18182-18299 (118 ports on 127.0.0.1): 0 reserved by this deploy, 118 already in use. Widen the port range, free a port, or check bind permissions.
```

**Diagnose.** The counts tell you which case it is:

- **reserved by this deploy** high → the range is too small for the processes that share it.
- **already in use** → another process (or an old release that has not finished draining) holds the ports.
- **could not be bound (e.g. EACCES)** → permission problem, e.g. a privileged (`<1024`) port.

`rollbridge doctor` reports whether the configured `proxy.port` is bindable.

**Fix.** Widen the process's `port` range, free the conflicting port (`ss -ltnp`
or `lsof -i :<port>` to find the holder), or avoid privileged ports / grant the
needed capability.

## Stale or busy control socket

**Symptom.** `rollbridge daemon` (or `ensure-daemon`) errors with one of:

```
A Rollbridge daemon for application "ticket-server" is already running on /tmp/rollbridge-ticket-server.sock (active release: v3). Run "rollbridge status" to inspect it or "rollbridge shutdown" to stop it, or set a different control.path.
The control socket /tmp/rollbridge-ticket-server.sock is already in use by another process. Stop that process or set a different control.path.
```

**Diagnose.** Run `rollbridge status` (does a daemon answer?) and `rollbridge
doctor` (control-socket check). A leftover socket *file* with no live daemon
behind it is removed automatically the next time the daemon starts — no action
needed.

**Fix.** If a Rollbridge daemon is already running, use it, or
`rollbridge shutdown` before starting another. If a non-Rollbridge process owns
the path, stop it or point `control.path` somewhere else.

## Crash loops

**Symptom.** `rollbridge status` shows a process with a climbing `restarts`
count and a `state` that flips between `running` and `failed`, with repeated
`process started` / `process exited` log lines.

**Diagnose.** `rollbridge logs --process <id>` shows the crash output;
`rollbridge status` shows `exitCode`, `exitSignal`, `restarts`, and `uptimeMs`
(a tiny `uptimeMs` that keeps resetting is a fast crash loop). Crashed
active-release and `service` processes auto-restart after `restartDelayMs`.

**Fix.** Correct the command, environment, or dependency that makes the process
exit; raise `restartDelayMs` to slow a tight loop. Note that a release which
fails its health check never receives traffic, so a crash-looping proxied
process in a *failed* deploy does not take the site down — the previous release
stays active.

## Stuck draining releases

**Symptom.** Long after a deploy, `rollbridge status` still shows an old release
in `state: "draining"` with non-zero `connections` (often `websocket`).

**Diagnose.** Long-lived connections (WebSockets, SSE, streaming responses) keep
the retired proxied web process alive until they close or
`proxy.drainTimeoutMs` elapses. `status` shows the release's
`connections.http`/`connections.websocket` and `drainStartedAt`. A retained jobs
generation has an independent lifecycle and may remain after the web drain ends.

**Fix.** The connection drain ends automatically when those connections close,
or after `proxy.drainTimeoutMs`. Rollbridge then stops the retired proxied web
process and other connection-dependent processes, including ordinary companions
with `nonBlockingDrain: false`. Lower the timeout only to shorten
HTTP/WebSocket retention, or make clients reconnect (for example, have the front
end close idle WebSockets on deploy). In the documented compliant jobs topology,
jobs companions use `nonBlockingDrain: true`, so timeout expiry affects only the
web side and must not stop a still-draining jobs generation.

`status.releaseReferences` reports active and draining releases, plus a stopped
release that still owns a persistent service definition, pending singleton, or
unresolved generation transition, until all runtime ownership ends; Rampway
still owns enforcement against on-disk cleanup. With `ownerRecovery`, references
reconstruct across same-authority daemon process replacement and transfer across
an incompatible `ensure-daemon` owner handoff. They do not transfer through the
separate destructive `--takeover-owner` path. If
`retirementError` is set,
inspect the quiet-hook events. Rollbridge deliberately leaves that generation
alive rather than signaling arbitrary PIDs or continuing its stop sequence.
