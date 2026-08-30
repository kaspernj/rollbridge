### Added

- Add an opt-in, durable `lifecycle.activateCommand` for one release-scoped
  handoff service. Rollbridge now supports strict old-retire acknowledgement,
  candidate-activate acknowledgement, and synchronous active/proxy commit with
  exact transition recovery and resume. Exact release definitions remain private
  to guardian recovery, post-commit singleton work is resumable, unresolved
  control mutations are fenced, and an active coordinator restores its role after
  restart. Hook-free configs keep their existing deploy behavior.
