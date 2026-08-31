### Added

- Add an opt-in, durable `lifecycle.activateCommand` for one release-scoped
  handoff service. Rollbridge now supports strict old-retire acknowledgement,
  candidate-activate acknowledgement, and synchronous active/proxy commit with
  exact transition recovery and resume. Exact release definitions remain private
  to guardian recovery, post-commit singleton work is resumable, unresolved
  control and terminal owner mutations are fenced, recovery uses a complete
  monotonic journal and publishes listener/PID readiness before replaying long
  hooks, signals shut down cleanly after replay, and an active coordinator
  restores its role after restart. Public recovery state advances only after its
  private guardian authority, persistent service definitions retain their exact
  release across recovery, manual restart reaches the active handoff coordinator,
  unresolved transitions retain both release definitions and reject
  config-authority-changing owner replacements, and live activation-mode changes
   require a daemon restart. Hook-free configs keep their existing deploy behavior.

### Fixed

- Serialize active-role restoration with retirement, reject empty lifecycle
  commands, bound guardian process-log forwarding for stalled clients, and keep
  a claimed recovery owner alive until replacement listener retirement. Journal
  hook-free post-switch retirement and singleton work for exact crash recovery.
