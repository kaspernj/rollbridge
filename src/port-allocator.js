// @ts-check

import net from "node:net"

/**
 * @typedef {{from: number, to: number}} PortRange
 */

/**
 * Tests whether a port can be bound.
 * @param {object} args - Options.
 * @param {string} args.host - Bind host.
 * @param {number} args.port - Candidate port.
 * @returns {Promise<number | null>} Available port, or null.
 */
async function tryPort({host, port}) {
  const server = net.createServer()

  return await new Promise((resolve) => {
    server.once("error", () => {
      resolve(null)
    })
    server.listen(port, host, () => {
      const address = server.address()
      const boundPort = address && typeof address === "object" ? address.port : port

      server.close(() => resolve(boundPort))
    })
  })
}

/**
 * Finds an available port in a range.
 * @param {object} args - Options.
 * @param {string} args.host - Bind host.
 * @param {PortRange | undefined} args.range - Candidate range.
 * @param {Set<number>} args.usedPorts - Ports already allocated by this deploy.
 * @returns {Promise<number>} Available port.
 */
export async function findAvailablePort({host, range, usedPorts}) {
  if (!range || range.from === 0 || range.to === 0) {
    const port = await tryPort({host, port: 0})

    if (!port) throw new Error("Unable to allocate an ephemeral port")
    usedPorts.add(port)

    return port
  }

  for (let port = range.from; port <= range.to; port += 1) {
    if (usedPorts.has(port)) continue

    const availablePort = await tryPort({host, port})

    if (availablePort) {
      usedPorts.add(availablePort)
      return availablePort
    }
  }

  throw new Error(`No available ports in range ${range.from}-${range.to}`)
}
