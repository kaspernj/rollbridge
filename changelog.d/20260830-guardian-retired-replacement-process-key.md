### Fixed

- Carry an exact recovered guardian process key when a ready replacement commits
  after the incumbent control listener has already retired, while retaining the
  replacement transaction, authority, and registered-process fences.
- Fail closed when an older retained guardian cannot commit that replacement
  atomically after the incumbent control socket disappears, preserving the
  incumbent owner, retained connections, and guardian-managed release processes.
