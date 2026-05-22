// Rollbridge config for the TensorBuzz production backend.
//
// Nginx should keep proxying the backend host to 127.0.0.1:4500. Rollbridge
// binds that stable HTTP port, forwards to the active release's internal web
// port, keeps Beacon/jobs-main as daemon-wide services, and starts one
// background worker per active release.

export default {
  application: "tensorbuzz",

  control: {
    path: "/tmp/rollbridge-tensorbuzz.sock"
  },

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
      cwd: "{{releasePath}}/backend",
      env: {
        NODE_ENV: "production",
        VELOCIOUS_ENV: "production",
        VELOCIOUS_BEACON_PORT: "{{ports.beacon}}",
        VELOCIOUS_BACKGROUND_JOBS_PORT: "{{port}}"
      },
      command: "wait-for-it 127.0.0.1:{{ports.beacon}} --strict -- npx velocious background-jobs-main",
      port: 7331
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
      gracefulStopMs: 60000
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
