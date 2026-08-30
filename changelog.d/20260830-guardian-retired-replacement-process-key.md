### Fixed

- Carry an exact recovered guardian process key when a ready replacement commits
  after the incumbent control listener has already retired, while retaining the
  replacement transaction, authority, and registered-process fences.
- Complete that staged handoff through an older retained guardian only after
  attesting and retiring its exact daemon owner, without signaling guardian-owned
  release processes.
