# Nginx guide

Nginx should always proxy to the **stable Rollbridge proxy port**
(`proxy.host:proxy.port`), never directly to a release process — release ports
are allocated per deploy and change. Rollbridge forwards both HTTP and WebSocket
traffic to the active release and drains old connections across deploys.

## Server block

```nginx
# Maps the Upgrade header so WebSocket requests get "Connection: upgrade" and
# normal requests get a closed/keep-alive connection.
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  server_name app.example.com;
  # ssl_certificate / ssl_certificate_key ...

  location / {
    proxy_pass http://127.0.0.1:8182;   # Rollbridge proxy.host:proxy.port

    # WebSocket upgrade
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    # Pass the real client through to the app
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;

    # Long-lived connections (WebSocket/SSE) — see "Timeouts" below
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

The repository README shows a minimal version of this block; the additions here
matter for production.

## WebSocket headers

Rollbridge's proxy has WebSocket support enabled, so the only requirement is that
Nginx forwards the upgrade handshake:

- `proxy_http_version 1.1` — WebSocket upgrades require HTTP/1.1 (the default is 1.0).
- `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection $connection_upgrade;` — forward the upgrade. Using the `map` above is preferred over a hard-coded `Connection "upgrade"`, so non-WebSocket requests aren't forced into an upgrade.

If these are missing, WebSocket clients fail to connect (the handshake never
completes) while plain HTTP still works.

## Timeouts

Nginx's `proxy_read_timeout`/`proxy_send_timeout` default to **60s**. An idle
WebSocket (or a slow streaming response) is closed once that elapses, so
long-lived connections silently drop after a minute unless you raise them — set
them on the relevant `location` (or globally) to a value above your longest idle
period.

Related Rollbridge timeouts (configured in `rollbridge.js`, not Nginx):

- `proxy.healthTimeoutMs` gates how long a new release has to become healthy
  before a deploy aborts — it does not affect request timeouts.
- `proxy.drainTimeoutMs` is how long Rollbridge keeps an old release alive for
  in-flight connections during a deploy. Keep Nginx's `proxy_read_timeout` for
  WebSocket locations comfortably above it so the front end doesn't cut
  connections Rollbridge is still draining.

## Forwarded headers

Set `X-Forwarded-For`, `X-Forwarded-Proto`, and `Host` so the app behind
Rollbridge sees the real client and scheme. Rollbridge proxies with
`X-Forwarded-*` enabled, but it can only forward what Nginx provides — terminate
TLS at Nginx and pass `X-Forwarded-Proto $scheme` so the app knows the original
request was HTTPS.

For Server-Sent Events or other streamed responses, also disable response
buffering on that location so events flush immediately:

```nginx
location /events {
  proxy_pass http://127.0.0.1:8182;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 3600s;
}
```

## Common failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `502 Bad Gateway` | Rollbridge can't reach the active release's process (it crashed or is restarting); Rollbridge returns `Bad gateway` and Nginx relays it. | Check `rollbridge status` / `rollbridge logs --process <id>` (see [troubleshooting.md](troubleshooting.md)). The process auto-restarts on its port. |
| `503` / `No active release` | No release is active — before the first deploy, or after `rollbridge stop`. | Deploy a release (`rollbridge deploy`). |
| WebSocket drops after ~60s | `proxy_read_timeout` left at the 60s default. | Raise `proxy_read_timeout`/`proxy_send_timeout` on the WebSocket location. |
| WebSocket never connects (plain HTTP works) | Missing `proxy_http_version 1.1` and the `Upgrade`/`Connection` headers. | Add the WebSocket directives shown above. |
| `504 Gateway Timeout` | A slow response exceeded `proxy_read_timeout`. | Raise the timeout, or speed up the endpoint. |
| Connections cut mid-deploy | Nginx `proxy_read_timeout` shorter than `proxy.drainTimeoutMs`. | Raise the Nginx timeout above `proxy.drainTimeoutMs`. |
