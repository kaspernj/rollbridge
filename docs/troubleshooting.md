# Troubleshooting

Start with these three commands — they diagnose most problems without guessing:

- `rollbridge validate` — config errors, with an example fix for each.
- `rollbridge doctor` — control socket reachability, socket-directory writability, and proxy-port availability before the daemon starts.
- `rollbridge status` / `rollbridge logs` — live release/process state, restart counts, exit codes, connection counts, and recent process output.

All of these support `--json` for scripting.

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
the retired release alive until they close or `proxy.drainTimeoutMs` elapses.
`status` shows the release's `connections.http`/`connections.websocket` and
`drainStartedAt`.

**Fix.** Draining ends automatically when those connections close, or after
`proxy.drainTimeoutMs` (then the release is stopped regardless). Lower
`proxy.drainTimeoutMs` to force-stop sooner, or make clients reconnect (for
example, have the front end close idle WebSockets on deploy). Once stopped, the
release is pruned per `releaseRetention`.
