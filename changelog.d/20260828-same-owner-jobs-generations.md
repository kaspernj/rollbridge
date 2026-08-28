## Fixed

- Quiesce release-scoped handoff services after healthy candidate activation,
  retain them with their original workers during asynchronous drain, and report
  active/draining release references. Cross-owner recovery and atomic owner
  upgrades remain future work.
