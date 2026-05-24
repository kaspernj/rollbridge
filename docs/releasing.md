# Releasing (maintainers)

Rollbridge publishes **patch** releases from the default branch with:

```bash
npm run release:patch
```

That script (the `release-patch` package) owns the version bump, lockfile update,
default-branch commit, push, and `npm publish`. Don't run `npm version` yourself
first — let the script own the bump. Use this checklist around it.

The default branch is `master` for this repo; the checks below stay
branch-agnostic so they stay correct if that ever changes. Capture the name once
and reuse it (the commands below assume it is set):

```bash
default_branch=$(git rev-parse --abbrev-ref origin/HEAD | sed 's@^origin/@@')   # e.g. master
```

## Before releasing

- [ ] You're on the default branch and synced with it: `git switch "$default_branch"`,
      then `git fetch && git status` shows it up to date, with a **clean working tree**.
- [ ] CI is green for that commit, and `npm run all-checks` passes locally
      (typecheck, lint, and the full test suite).
- [ ] `README.md` and `docs/` reflect every user-visible change shipped since the
      last release (config fields, CLI commands/flags, status/event output,
      operational behavior).
- [ ] `TODO.md` checkboxes for the shipped work are updated.
- [ ] You can publish: `npm whoami` shows an account with publish rights to the
      `rollbridge` package, and you can push to the default branch.

## Release

```bash
npm run release:patch
```

The script bumps the patch version, updates `package-lock.json`, commits the bump
to the default branch, pushes it, and publishes the package to npm.

## After releasing

- [ ] The new version is on the registry: `npm view rollbridge version` matches
      the bumped `package.json` version.
- [ ] The version-bump commit reached the remote (not just local): `git fetch`,
      then `git log --oneline -1 "origin/$default_branch"` shows the bump — a
      failed or blocked push won't satisfy this.
- [ ] Your working tree is clean and still on the default branch.

`release:patch` only does patch releases — a minor or major version bump is a
manual decision and is not covered by this script.
