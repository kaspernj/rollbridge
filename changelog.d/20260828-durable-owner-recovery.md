### Added

- Add opt-in `ownerRecovery` with a durable authenticated process guardian so an
  exact same-authority daemon replacement reconstructs active and draining
  generations, ports, lifecycle supervision, and release references after an
  unexpected daemon exit. Concurrent replacements are fenced and mismatched or
  partial recovery state fails closed.
