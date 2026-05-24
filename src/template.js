// @ts-check

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {Record<string, JsonValue>} TemplateContext
 */

/**
 * Resolves a dotted template key against the context.
 * @param {string} key - Dotted key from a template expression.
 * @param {TemplateContext} context - Template context.
 * @returns {JsonValue} Resolved value.
 */
export function resolveTemplateValue(key, context) {
  const parts = key.split(".")
  let current = /** @type {JsonValue} */ (context)

  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined
    }

    current = /** @type {Record<string, JsonValue>} */ (current)[part]
  }

  return current
}

/**
 * Renders `{{key}}` placeholders in a string.
 * @param {string} value - Template string.
 * @param {TemplateContext} context - Template context.
 * @returns {string} Rendered string.
 */
export function renderTemplate(value, context) {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
    const resolved = resolveTemplateValue(key, context)

    if (resolved === undefined || resolved === null) {
      throw new Error(`Missing template value for ${match}`)
    }

    return String(resolved)
  })
}

/**
 * Builds the template context for rendering one process's command, cwd, and env. It is the
 * single source of truth for the render context so callers stay in sync — the daemon uses it at
 * deploy time, and `doctor` uses it (with representative ports) to pre-flight a release.
 * @param {object} args - Context inputs.
 * @param {string} args.application - Application name.
 * @param {Record<string, number>} args.ports - Allocated (or representative) ports by process id.
 * @param {string} args.processId - The process this context renders.
 * @param {{host: string, port: number, upstreamHost: string}} args.proxy - Proxy address.
 * @param {string} args.releaseId - Release id.
 * @param {string} args.releasePath - Release directory.
 * @param {number} args.replicaCount - Total replicas configured for this process.
 * @param {number} args.replicaIndex - This replica's index.
 * @param {string} args.revision - Release revision.
 * @returns {TemplateContext} The render context.
 */
export function processTemplateContext({application, ports, processId, proxy, releaseId, releasePath, replicaCount, replicaIndex, revision}) {
  return {
    application,
    env: {...process.env},
    port: ports[processId],
    ports,
    processId,
    proxy: {host: proxy.host, port: proxy.port, upstreamHost: proxy.upstreamHost},
    releaseId,
    releasePath,
    replicaCount,
    replicaIndex,
    revision
  }
}

/**
 * Renders all string values in a plain JSON-like object.
 * @param {JsonValue} value - Value to render.
 * @param {TemplateContext} context - Template context.
 * @returns {JsonValue} Rendered value.
 */
export function renderObject(value, context) {
  if (typeof value === "string") {
    return renderTemplate(value, context)
  }

  if (Array.isArray(value)) {
    return value.map((entry) => renderObject(entry, context))
  }

  if (value && typeof value === "object") {
    /** @type {Record<string, JsonValue>} */
    const rendered = {}

    for (const [key, entry] of Object.entries(value)) {
      rendered[key] = renderObject(entry, context)
    }

    return rendered
  }

  return value
}
