### Fixed

- Stopped releases no longer carry a stale connection count into owner
  replacement. When a drain times out the release's local connection count was
  frozen non-zero, persisted into the daemon state, and replayed into every
  successor daemon's owner-replace handoff. The successor daemon does not
  retain the stopped release, so the replay failed the candidate with
  `Incumbent listener reported unknown release <id>` and deadlocked every
  subsequent deployment. A release that reaches terminal `stopped` now
  abandons its local connection count (it owns no live proxy listener),
  `restore()` no longer re-adopts a persisted count for a stopped release,
  the serialized owner handoff skips stopped releases, and a non-zero report
  for a release the daemon does not retain is reconciled to zero with a log
  line instead of throwing, so a stale count can never wedge the node again.
