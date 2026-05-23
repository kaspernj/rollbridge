// @ts-check

import fs from "node:fs"

/**
 * Measures the resident memory (RSS) of an entire managed process group, not just
 * the shell wrapper. Rollbridge spawns each process detached, so the spawned pid is
 * the process-group leader; every process in the tree shares that group id.
 *
 * Reads `/proc` (Linux), summing each member's `VmRSS`. Returns `undefined` when the
 * measurement is unavailable (no `/proc`, e.g. non-Linux) or no group member is found.
 * @param {number} pgid - Process-group id (the detached spawn's pid).
 * @returns {number | undefined} Total resident memory in bytes, or undefined when unmeasurable.
 */
export function measureProcessGroupRssBytes(pgid) {
  /** @type {string[]} */
  let entries

  try {
    entries = fs.readdirSync("/proc")
  } catch {
    return undefined
  }

  let total = 0
  let matched = 0

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    if (processGroupId(entry) !== pgid) continue

    const rss = residentBytes(entry)

    if (rss !== undefined) {
      total += rss
      matched += 1
    }
  }

  return matched > 0 ? total : undefined
}

/**
 * @param {string} pid - Process id.
 * @returns {number | undefined} The process-group id, or undefined when the process is gone.
 */
function processGroupId(pid) {
  let stat

  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    return undefined
  }

  // The comm field is wrapped in parens and may itself contain spaces or parens, so the
  // numeric fields are parsed from after the final ")". They are: state, ppid, pgrp, ...
  const commEnd = stat.lastIndexOf(")")

  if (commEnd < 0) return undefined

  const pgrp = Number(stat.slice(commEnd + 2).split(" ")[2])

  return Number.isInteger(pgrp) ? pgrp : undefined
}

/**
 * @param {string} pid - Process id.
 * @returns {number | undefined} Resident memory in bytes, or undefined when unavailable.
 */
function residentBytes(pid) {
  let status

  try {
    status = fs.readFileSync(`/proc/${pid}/status`, "utf8")
  } catch {
    return undefined
  }

  const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m)

  return match ? Number(match[1]) * 1024 : undefined
}
