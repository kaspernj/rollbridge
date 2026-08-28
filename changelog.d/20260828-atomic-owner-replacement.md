### Added

- Atomically replace incompatible config, control-socket, package, and runtime
  owners through `ensure-daemon` when durable `ownerRecovery` is configured.
  The guardian fences candidates, transfers exact active and draining release
  supervision only after candidate readiness, and converges after an ambiguous
  commit response or a crash at the committed-state boundary.
