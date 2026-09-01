### Fixed

- Add explicit `recover-generation-transition --accept-retired-incumbent`
  recovery that stops the exact failed candidate and durably fences degraded
  incumbent web authority across owner recovery without reactivating either jobs
  generation. A fresh deployment replaces the fence through normal cutover.
  Incompatible owner replacement now accepts the unresolved transition's exact
  retained candidate config without admitting unrelated config authority.
