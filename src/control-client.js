// @ts-check

import net from "node:net"

/**
 * Sends a command to a Rollgate daemon.
 * @param {object} args - Options.
 * @param {Record<string, unknown>} args.command - Command payload.
 * @param {string} args.path - Control socket path.
 * @returns {Promise<Record<string, unknown>>} Response payload.
 */
export async function sendControlCommand({command, path}) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(path)
    let buffer = ""

    socket.setEncoding("utf8")
    socket.once("error", reject)
    socket.on("data", (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf("\n")

      if (newlineIndex < 0) return

      const line = buffer.slice(0, newlineIndex)
      const response = JSON.parse(line)

      socket.end()

      if (response.status === "error") {
        reject(new Error(String(response.error || "Unknown Rollgate error")))
      } else {
        resolve(response)
      }
    })
    socket.write(`${JSON.stringify(command)}\n`)
  })
}
