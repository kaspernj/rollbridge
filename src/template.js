// @ts-check

/**
 * @typedef {Record<string, unknown>} TemplateContext
 */

/**
 * Resolves a dotted template key against the context.
 * @param {string} key - Dotted key from a template expression.
 * @param {TemplateContext} context - Template context.
 * @returns {unknown} Resolved value.
 */
export function resolveTemplateValue(key, context) {
  const parts = key.split(".")
  let current = /** @type {unknown} */ (context)

  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined
    }

    current = /** @type {Record<string, unknown>} */ (current)[part]
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
 * Renders all string values in a plain JSON-like object.
 * @param {unknown} value - Value to render.
 * @param {TemplateContext} context - Template context.
 * @returns {unknown} Rendered value.
 */
export function renderObject(value, context) {
  if (typeof value === "string") {
    return renderTemplate(value, context)
  }

  if (Array.isArray(value)) {
    return value.map((entry) => renderObject(entry, context))
  }

  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const rendered = {}

    for (const [key, entry] of Object.entries(value)) {
      rendered[key] = renderObject(entry, context)
    }

    return rendered
  }

  return value
}
