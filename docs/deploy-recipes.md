# Deploy-tool recipes

Rollbridge is deploy-tool agnostic: it ships no plugins or tasks for any deploy
tool. Whatever you use — a shell script, CI, or Capistrano — drives Rollbridge
by **calling its CLI** (see [`cli.md`](cli.md)). The daemon is long-lived;
deploys just hand it a prepared release path.

The deploy contract is the same everywhere:

1. Prepare the release directory (checkout, install dependencies, build assets).
2. Run **backwards-compatible** migrations *before* switching traffic (the old
   and new web releases overlap during the drain).
3. Run `rollbridge deploy` — it starts the new release, health-checks the
   proxied process, switches traffic, then drains and stops the old release.
   It exits non-zero (leaving the previous release active) if the new release
   fails to start or health-check, so your script should stop on a failed
   deploy.

Point `--config` at a stable, daemon-wide config file; release paths are passed
per deploy. `rollbridge deploy --ensure-daemon` starts the daemon first if it
isn't already running, so the recipes below work whether or not the daemon is
already managed by systemd.

## Shell script

```bash
#!/usr/bin/env bash
set -euo pipefail

app_dir=/srv/ticket-server
config=/etc/rollbridge/rollbridge.js
revision="$(git rev-parse HEAD)"
release_path="$app_dir/releases/$(date -u +%Y%m%d%H%M%S)-$revision"

# 1. Prepare the release.
git clone --depth 1 "$app_dir/repo" "$release_path"
(cd "$release_path" && npm ci && npm run build)

# 2. Run backwards-compatible migrations before switching traffic.
(cd "$release_path" && npx velocious db:migrate)

# 3. Switch traffic (and start the daemon if needed). A non-zero exit here means
#    the new release failed health checks and the previous one is still active;
#    `set -e` aborts the script so the bad release is not promoted.
rollbridge deploy \
  --ensure-daemon \
  --config "$config" \
  --release-path "$release_path" \
  --revision "$revision"
```

## CI

In CI, build/test the release, then run the same `rollbridge deploy` over SSH
on the target host (CI rarely runs the long-lived daemon itself):

```bash
# after the build/test job has produced a release at $RELEASE_PATH on the host
ssh deploy@app.example.com \
  "rollbridge deploy --ensure-daemon \
     --config /etc/rollbridge/rollbridge.js \
     --release-path '$RELEASE_PATH' \
     --revision '$GIT_SHA'"
```

`rollbridge deploy` exits non-zero on a failed health check, which fails the CI
step — no extra gating needed. Use `rollbridge validate --json` / `rollbridge
doctor --json` earlier in the pipeline if you want to fail fast before building.

## Capistrano

Rollbridge ships **no Capistrano plugin or tasks** — you only run its CLI as a
shell command from your own `deploy.rb`. Capistrano already uploads the release
to `release_path`, so the deploy step is a single `execute` of the CLI:

```ruby
# config/deploy.rb — just a shell command; no Rollbridge-specific Capistrano code.
after "deploy:publishing", "rollbridge:deploy"

namespace :rollbridge do
  task :deploy do
    on roles(:app) do
      within release_path do
        execute :npx, "velocious", "db:migrate"
      end
      execute "rollbridge", "deploy",
        "--ensure-daemon",
        "--config", "/etc/rollbridge/rollbridge.js",
        "--release-path", release_path,
        "--revision", fetch(:current_revision)
    end
  end
end
```

`execute` runs the command over SSH and raises if it exits non-zero, so a failed
Rollbridge health check fails the Capistrano deploy. Keep Capistrano's own
`linked_dirs`/`keep_releases` for on-disk release directories; Rollbridge only
manages the running processes and its own in-memory release records (see
`releaseRetention`).
