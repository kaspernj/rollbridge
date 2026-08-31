// @ts-check

import fs from "node:fs"
import net from "node:net"
import {spawn} from "node:child_process"

const authorityText = process.env.GUARDIAN_AUTHORITY
const claimDelayMs = Number(process.env.GUARDIAN_CLAIM_DELAY_MS || 0)
const descendantPath = process.env.GUARDIAN_DESCENDANT_PATH
const exitAfterClaim = process.env.GUARDIAN_EXIT_AFTER_CLAIM === "1"
const markerPath = process.env.GUARDIAN_MARKER_PATH
const replacementCommittedPath = process.env.GUARDIAN_REPLACEMENT_COMMITTED_PATH
const replacementPreparedPath = process.env.GUARDIAN_REPLACEMENT_PREPARED_PATH
const skipReady = process.env.GUARDIAN_SKIP_READY === "1"
const socketPath = process.env.GUARDIAN_SOCKET_PATH
const startedLogPath = process.env.GUARDIAN_STARTED_LOG_PATH
const startedPath = process.env.GUARDIAN_STARTED_PATH
const token = process.env.GUARDIAN_TOKEN

if (!authorityText || !markerPath || !socketPath || !token || !Number.isInteger(claimDelayMs) || claimDelayMs < 0) {
  throw new Error("Guardian recovery owner fixture requires authority, marker, socket, token, and a valid claim delay")
}

let buffer = ""
/** @type {string | undefined} */
let replacementId
let replacementCommitted = false

if (startedPath) fs.writeFileSync(startedPath, `${process.pid}\n`)
if (startedLogPath) fs.appendFileSync(startedLogPath, `${JSON.stringify({at: Date.now(), pid: process.pid})}\n`)
if (descendantPath) {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"})

  if (!descendant.pid) throw new Error("Guardian recovery owner fixture descendant did not start")
  fs.writeFileSync(descendantPath, `${descendant.pid}\n`)
  descendant.unref()
}
const timer = setTimeout(() => {
  const socket = net.createConnection(socketPath)

  socket.setEncoding("utf8")
  socket.once("connect", () => {
    socket.write(`${JSON.stringify({authority: JSON.parse(authorityText), command: "claim-owner", graceMs: 0, id: 1, ownerPid: process.pid, token})}\n`)
  })
  socket.on("data", (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")

    while (newline >= 0) {
      const response = JSON.parse(buffer.slice(0, newline))

      buffer = buffer.slice(newline + 1)
      if (response.error) throw new Error(String(response.error))
      if (response.id === 1) {
        fs.writeFileSync(markerPath, `${process.pid}\n`)
        if (exitAfterClaim) process.exit(47)
        if (!skipReady) socket.write(`${JSON.stringify({command: "owner-ready", id: 2, ownerPid: process.pid, token})}\n`)
      }
      if (response.event === "replacement-prepared") {
        replacementId = response.replacementId
        if (replacementPreparedPath) fs.writeFileSync(replacementPreparedPath, `${replacementId}\n`)
      }
      if (response.id === 3) {
        replacementCommitted = true
        if (replacementCommittedPath) fs.writeFileSync(replacementCommittedPath, `${replacementId}\n`)
      }
      if (response.id === 4) socket.write(`${JSON.stringify({command: "finalize-owner-replacement", id: 5, replacementId, token})}\n`)
      if (response.id === 5) socket.destroy()
      newline = buffer.indexOf("\n")
    }
  })
  process.once("SIGUSR1", () => {
    if (!replacementCommitted) {
      socket.destroy()
      return
    }
    socket.write(`${JSON.stringify({command: "complete-owner-listener-retirement", id: 4, replacementId, token})}\n`)
  })
  process.once("SIGUSR2", () => {
    if (!replacementId) throw new Error("Guardian recovery owner fixture has no prepared replacement")
    socket.write(`${JSON.stringify({command: "commit-owner-replacement", id: 3, replacementId, token})}\n`)
  })
}, claimDelayMs)

timer.unref()
setInterval(() => {}, 1000)
