# Reject registering a release on another release's directory, and stop reporting dead release records

A host could end up tracking several release ids on one release directory. The extra records then
reported `releasePath` values that disagree with the layout deploying tools derive from the active
release (`dirname(activeReleasePath)/<releaseId>`), so the tool rejected the runtime's release
references and refused to publish. The same happened when the deploying tool deleted an old release
directory: the record stayed tracked until the retention count aged it out, reporting a path that no
longer existed.

- `deploy` now refuses to register a release on the directory of another tracked release (the
  directory name is that release's id). Directories whose name is not a tracked release id stay
  shareable, so blue/green deployments on one application directory are unaffected.
- Retiring a release now drops records that can never serve a rollback again: their directory is
  gone, or they sit on another tracked release's directory. The drop is logged as
  `dropping unusable retired release`.

Verified with `test/release-retention.test.js` (9 passed) plus `npm run typecheck` and
`npm run lint`.
