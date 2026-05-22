// @ts-check

/**
 * Waits for a process HTTP health endpoint.
 * @param {object} args - Options.
 * @param {string} args.host - Host.
 * @param {number} args.port - Port.
 * @param {import("./config.js").HealthConfig} args.health - Health config.
 * @returns {Promise<void>} Resolves when healthy.
 */
export async function waitForHealth({health, host, port}) {
  if (health.startDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, health.startDelayMs))
  }

  const deadline = Date.now() + health.timeoutMs
  const url = `http://${host}:${port}${health.path}`
  let lastError = "no attempts"

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url)

      if (response.ok) return

      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, health.intervalMs))
  }

  throw new Error(`Health check failed for ${url}: ${lastError}`)
}
