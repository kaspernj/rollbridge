// @ts-check

import fs from "node:fs"

/**
 * @typedef {{command: string, pid: number, rssBytes: number | undefined}} ProcessGroupMember
 */

/**
 * Lists the members of a managed process group with each member's resident memory.
 * Rollbridge spawns each process detached, so the spawned pid is the process-group
 * leader and every process in the tree (the shell wrapper, the app, any children)
 * shares that group id.
 *
 * Reads `/proc` (Linux); returns an empty array when unavailable (no `/proc`, e.g.
 * non-Linux) or the group has no members.
 * @param {number} pgid - Process-group id (the detached spawn's pid).
 * @returns {ProcessGroupMember[]} Group members, ordered by pid.
 */
export function processGroupMembers(pgid) {
  /** @type {string[]} */
  let entries

  try {
    entries = fs.readdirSync("/proc")
  } catch {
    return []
  }

  /** @type {ProcessGroupMember[]} */
  const members = []

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    if (processGroupId(entry) !== pgid) continue

    members.push({command: commandName(entry), pid: Number(entry), rssBytes: residentBytes(entry)})
  }

  members.sort((first, second) => first.pid - second.pid)

  return members
}

/**
 * Reports whether a process group has a member that can still run. Defunct members remain
 * visible to kill(2) until their parent reaps them, but cannot handle signals or do work.
 * @param {number} pgid - Process-group id.
 * @param {string} [procPath] - Procfs root (overridable for deterministic tests).
 * @returns {boolean | undefined} Whether a live member exists, or undefined without procfs.
 */
export function processGroupHasLiveMembers(pgid, procPath = "/proc") {
  /** @type {string[]} */
  let entries

  try {
    entries = fs.readdirSync(procPath)
  } catch {
    return undefined
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue

    const stat = processStat(entry, procPath)

    if (stat?.pgrp === pgid && stat.state !== "Z" && stat.state !== "X") return true
  }

  return false
}

/**
 * Measures the total resident memory (RSS) of a managed process group.
 * @param {number} pgid - Process-group id (the detached spawn's pid).
 * @returns {number | undefined} Total resident memory in bytes, or undefined when unmeasurable.
 */
export function measureProcessGroupRssBytes(pgid) {
  const measured = processGroupMembers(pgid).filter((member) => member.rssBytes !== undefined)

  if (measured.length === 0) return undefined

  return measured.reduce((total, member) => total + (member.rssBytes ?? 0), 0)
}

/**
 * @param {string} pid - Process id.
 * @returns {string} The process command name (`/proc/<pid>/comm`), or "" when unavailable.
 */
function commandName(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim()
  } catch {
    return ""
  }
}

/**
 * @param {string} pid - Process id.
 * @returns {number | undefined} The process-group id, or undefined when the process is gone.
 */
function processGroupId(pid) {
  return processStat(pid, "/proc")?.pgrp
}

/**
 * @param {string} pid - Process id.
 * @param {string} procPath - Procfs root.
 * @returns {{pgrp: number, state: string} | undefined} Parsed process state and group.
 */
function processStat(pid, procPath) {
  let stat

  try {
    stat = fs.readFileSync(`${procPath}/${pid}/stat`, "utf8")
  } catch {
    return undefined
  }

  // The comm field is wrapped in parens and may itself contain spaces or parens, so the
  // numeric fields are parsed from after the final ")". They are: state, ppid, pgrp, ...
  const commEnd = stat.lastIndexOf(")")

  if (commEnd < 0) return undefined

  const fields = stat.slice(commEnd + 2).split(" ")
  const pgrp = Number(fields[2])

  return Number.isInteger(pgrp) ? {pgrp, state: fields[0]} : undefined
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
