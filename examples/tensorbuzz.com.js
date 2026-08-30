// Rollbridge config for the TensorBuzz production backend.
//
// Nginx should keep proxying the backend host to 127.0.0.1:4500. Rollbridge
// binds that stable HTTP port, forwards to the active release's internal web
// port and keeps Beacon daemon-wide. The lifecycle socket path must match the
// reviewed release-local Velocious jobs-main configuration; the worker appctl
// command remains an illustrative application-specific quiescence control.

export default {
  application: "tensorbuzz",

  control: {
    path: "/tmp/rollbridge-tensorbuzz.sock"
  },

  statePath: "/var/lib/rollbridge/tensorbuzz.json",
  ownerRecovery: {reconnectGraceMs: 30000},

  proxy: {
    host: "127.0.0.1",
    port: 4500,
    healthPath: "/ping",
    healthTimeoutMs: 30000,
    drainTimeoutMs: 60000,
    forceStopTimeoutMs: 10000
  },

  processes: [
    {
      id: "beacon",
      policy: "service",
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{port}}"
      },
      command: "npx velocious beacon",
      port: 7330
    },
    {
      id: "background-jobs-main",
      policy: "service",
      deployStrategy: "handoff",
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{ports.beacon}}",
        VELOCIOUS_BACKGROUND_JOBS_PORT: "{{port}}",
        VELOCIOUS_BACKGROUND_JOBS_LIFECYCLE_SOCKET: "{{releasePath}}/tmp/background-jobs-main.sock"
      },
      command: "wait-for-it 127.0.0.1:{{ports.beacon}} --strict -- npx velocious background-jobs-main",
      lifecycle: {
        activateCommand: 'npx velocious background-jobs:activate --generation "$ROLLBRIDGE_RELEASE_ID" --socket "$VELOCIOUS_BACKGROUND_JOBS_LIFECYCLE_SOCKET"',
        quietCommand: 'npx velocious background-jobs:retire --generation "$ROLLBRIDGE_RELEASE_ID" --socket "$VELOCIOUS_BACKGROUND_JOBS_LIFECYCLE_SOCKET"'
      },
      port: {from: 7331, to: 7399}
    },
    {
      id: "background-jobs-worker",
      policy: "companion",
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{ports.beacon}}",
        VELOCIOUS_BACKGROUND_JOBS_PORT: "{{ports.background-jobs-main}}"
      },
      command: "wait-for-it 127.0.0.1:{{ports.beacon}} --strict -- wait-for-it 127.0.0.1:{{ports.background-jobs-main}} --strict -- npx velocious background-jobs-worker",
      lifecycle: {quietCommand: "appctl jobs-worker-retire --pid $ROLLBRIDGE_PID"},
      nonBlockingDrain: true,
      gracefulStopMs: "indefinite"
    },
    {
      id: "web",
      policy: "proxied",
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{ports.beacon}}",
        VELOCIOUS_BACKGROUND_JOBS_PORT: "{{ports.background-jobs-main}}"
      },
      command: "wait-for-it 127.0.0.1:{{ports.beacon}} --strict -- wait-for-it 127.0.0.1:{{ports.background-jobs-main}} --strict -- npx velocious server --host 127.0.0.1 --port {{port}}",
      port: {
        from: 14500,
        to: 14599
      },
      health: {
        path: "/ping",
        timeoutMs: 30000,
        intervalMs: 500
      }
    }
  ]
}
