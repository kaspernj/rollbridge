### Fixed

- Select retired-owner commit proof from the guardian-published committed owner
  snapshot rather than candidate-local process order, reserve its incumbent-owned
  registration through commit, then attach it to the committed candidate while
  retaining the replacement transaction, authority, and control-path fences.
- Fail closed when an older retained guardian cannot commit that replacement
  atomically after the incumbent control socket disappears, preserving the
  incumbent owner, retained connections, and guardian-managed release processes.
- Retire the committed incumbent listener after a control-socket-absent handoff
  only after relaying source-identified live connection counts through successive
  owner replacements. Existing WebSocket connections can finish draining without
  one retired listener clearing another listener's counts, and socket-path cleanup
  remains fenced by the listener identity that was actually bound.
- Keep incumbent authority while it yields a fixed proxy, commit only after the
  candidate receives complete listener state and binds successfully, and resume
  the incumbent if that bind fails. Pending retirement survives candidate recovery,
  concurrent replacements remain fenced, and crashed local sources publish zero
  tombstones while stopped zero-count releases remain omitted.
- Explicitly classify retained guardian replacement capabilities before preparing
  a transaction. Guardians with prepare/stage support but no retired-owner commit
  command use the fully attested one-time disruptive legacy upgrade bridge;
  malformed, stale, or ambiguous protocol responses continue to fail closed. The
  partial guardian's prepared transaction remains the mutation fence through
  candidate reconstruction and boundary revalidation, and failed preparation
  notifies the incumbent to resume paused release drains. The bridge coordinator
  publishes its own authenticated recovery identity before the candidate proceeds.
