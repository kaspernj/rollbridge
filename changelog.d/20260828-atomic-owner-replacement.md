### Added

- Atomically replace incompatible config, control-socket, package, and runtime
  owners through `ensure-daemon` when durable `ownerRecovery` is configured.
  The guardian fences candidates, transfers exact active and draining release
  supervision only after candidate readiness, and converges after an ambiguous
  commit response or a crash at the committed-state boundary.
- Bridge the first authenticated pre-replacement guardian/daemon upgrade while
  preserving exact supervised process PIDs and release state. This one-time
  compatibility transition is explicitly disruptive: existing proxy/control
  connections may close and status records `legacy-first-upgrade`. Subsequent
  protocol-capable owner replacements remain atomic, including on Node 20.
- Fence post-prepare owner-state mutations with a guardian revision check and
  carry incumbent listener connection counts until the old HTTP/WebSocket
  sockets drain, so later deploys cannot stop a still-connected process early.
- Reserve every live generation's allocated endpoints before its processes bind
  and until that generation truly stops, and reconstruct those reservations on
  owner recovery so overlapping jobs generations cannot reuse an endpoint.
- Keep an exact newly spawned daemon candidate referenced until its status and
  PID authority are verified. `ensure-daemon` now reports an exact early child
  exit instead of leaving its top-level operation unsettled or waiting for a
  generic readiness timeout; the healthy daemon is detached only afterward.
