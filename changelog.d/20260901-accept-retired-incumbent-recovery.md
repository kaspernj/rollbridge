### Fixed

- Add explicit `recover-generation-transition --accept-retired-incumbent`
  recovery that clears only an exact terminal restoration fence while preserving
  incumbent web traffic and leaving both retained jobs generations untouched.
  Incompatible owner replacement now accepts the unresolved transition's exact
  retained candidate config without admitting unrelated config authority.
