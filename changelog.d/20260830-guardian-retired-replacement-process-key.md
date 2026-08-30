### Fixed

- Select retired-owner commit proof from the guardian-published committed owner
  snapshot rather than candidate-local process order, reserve its incumbent-owned
  registration through commit, then attach it to the committed candidate while
  retaining the replacement transaction, authority, and control-path fences.
- Fail closed when an older retained guardian cannot commit that replacement
  atomically after the incumbent control socket disappears, preserving the
  incumbent owner, retained connections, and guardian-managed release processes.
