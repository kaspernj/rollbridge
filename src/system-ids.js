// @ts-check

import fs from "node:fs"

/**
 * Resolves a control-socket owner (a numeric uid, a numeric string, or a user name)
 * to a numeric uid. Names are looked up in `/etc/passwd`.
 * @param {number | string} owner - User id or name.
 * @returns {number} The numeric uid.
 */
export function resolveUserId(owner) {
  return resolvePrincipalId(owner, "/etc/passwd", "user")
}

/**
 * Resolves a control-socket group (a numeric gid, a numeric string, or a group name)
 * to a numeric gid. Names are looked up in `/etc/group`.
 * @param {number | string} group - Group id or name.
 * @returns {number} The numeric gid.
 */
export function resolveGroupId(group) {
  return resolvePrincipalId(group, "/etc/group", "group")
}

/**
 * @param {number | string} value - Numeric id, numeric string, or name.
 * @param {string} file - System database file mapping names to ids.
 * @param {"user" | "group"} kind - Principal kind, for error messages.
 * @returns {number} The numeric id.
 */
function resolvePrincipalId(value, file, kind) {
  if (typeof value === "number") return value
  if (/^\d+$/.test(value)) return Number(value)

  const id = lookupByName(value, file)

  if (id === undefined) {
    throw new Error(`Unknown ${kind} "${value}". Use a numeric id, or ensure the ${kind} exists in ${file} (name resolution covers local ${kind}s only).`)
  }

  return id
}

/**
 * @param {string} name - Principal name.
 * @param {string} file - `/etc/passwd` or `/etc/group`.
 * @returns {number | undefined} The numeric id, or undefined when the name is not found.
 */
function lookupByName(name, file) {
  let contents

  try {
    contents = fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }

  for (const line of contents.split("\n")) {
    if (!line || line.startsWith("#")) continue

    const fields = line.split(":")

    if (fields[0] === name) {
      const id = Number(fields[2])

      if (Number.isInteger(id)) return id
    }
  }

  return undefined
}
