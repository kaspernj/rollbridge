### Fixed

- Select retired-owner commit proof from the guardian-published committed owner
  snapshot rather than candidate-local process order, reserve its incumbent-owned
  registration through commit, then attach it to the committed candidate while
  retaining the replacement transaction, authority, and control-path fences.
- Fail closed when an older retained guardian cannot commit that replacement
  atomically after the incumbent control socket disappears, preserving the
  incumbent owner, retained connections, and guardian-managed release processes.
- Explicitly classify retained guardian replacement capabilities before preparing
  a transaction. Guardians with prepare/stage support but no retired-owner commit
  command use the fully attested one-time disruptive legacy upgrade bridge;
  malformed, stale, or ambiguous protocol responses continue to fail closed. The
  partial guardian's prepared transaction remains the mutation fence through
  candidate reconstruction and boundary revalidation, and failed preparation
  notifies the incumbent to resume paused release drains.
