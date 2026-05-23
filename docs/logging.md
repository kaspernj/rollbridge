# Logging

The Rollbridge daemon writes one structured JSON line per operational event
(deploys, traffic switches, process starts/exits, restarts, memory events, and
failed commands):

```json
{"at":"2026-05-23T14:31:09.512Z","message":"traffic switched","data":{"previousReleaseId":"v3","releaseId":"v4"}}
```

These lines go to the daemon's **stdout**; where that ends up depends on how the
daemon was started.

## Where logs go

| How the daemon runs | Destination |
| --- | --- |
| `rollbridge daemon` (foreground) | stdout — redirect it (`rollbridge daemon … >> /var/log/rollbridge/app.log 2>&1`) or let your service manager capture it. |
| systemd (`examples/rollbridge.service`) | the journal — `journalctl -u rollbridge`. journald rotates on its own. |
| `rollbridge ensure-daemon` / `rollbridge deploy --ensure-daemon` | the **daemon log file**: `--daemon-log-path <path>`, default `/tmp/rollbridge-<application>.log`. The detached daemon's stdout and stderr are appended there. |

Point `--daemon-log-path` at a path your rotation tooling manages, for example:

```bash
rollbridge deploy --ensure-daemon \
  --config /etc/rollbridge/rollbridge.js \
  --daemon-log-path /var/log/rollbridge/app.log \
  --release-path "$release_path"
```

The daemon log file is the durable, append-only stream of the daemon's own
events. It is distinct from the two in-memory views:

- `rollbridge logs` — recent stdout/stderr of each **managed process** (your app),
  bounded per process by `outputLines`.
- `rollbridge events` — the recent structured daemon event history (the most
  recent 1000 events), the same events written to the log file.

Both are cleared when the daemon restarts; the log file persists.

## Rotation

### systemd / journald

When the daemon runs under systemd its logs are in the journal, which rotates
automatically. Bound journal disk use with `SystemMaxUse=` in
`/etc/systemd/journald.conf` (or a per-namespace drop-in). No logrotate config is
needed for the daemon itself.

### The daemon log file (logrotate)

The detached daemon keeps the log file **open for its whole lifetime** (its
stdout/stderr file descriptors point at it). A plain `rename`-based rotation
would leave the daemon writing to the old, now-renamed inode while the new file
stays empty. Use logrotate's **`copytruncate`**, which copies the file and then
truncates it in place, keeping the daemon's open descriptor valid:

```
/var/log/rollbridge/*.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
```

`copytruncate` has a small race window — log lines written between the copy and
the truncate can be lost — which is acceptable for the daemon's low-volume,
milestone-level logging. Rollbridge does not reopen its log file on a signal, so
`copytruncate` (rather than `create` + a reopen signal) is the recommended
approach for the daemon log file.

Prefer running under systemd (journald) when you can; reach for `--daemon-log-path`
+ logrotate when you run the daemon outside a service manager that captures
stdout.
