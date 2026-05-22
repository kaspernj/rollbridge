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
 * @returns {Promise<{port: number} | {code: string}>} The bound port, or the bind error code.
 */
async function tryPort({host, port}) {
  const server = net.createServer()

  return await new Promise((resolve) => {
    server.once("error", (error) => {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "EUNKNOWN"

      resolve({code})
    })
    server.listen(port, host, () => {
      const address = server.address()
      const boundPort = address && typeof address === "object" ? address.port : port

      server.close(() => resolve({port: boundPort}))
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
    const result = await tryPort({host, port: 0})

    if (!("port" in result)) throw new Error(`Unable to allocate an ephemeral port on ${host} (${result.code})`)
    usedPorts.add(result.port)

    return result.port
  }

  let reserved = 0
  let inUse = 0
  let unavailable = 0
  /** @type {string | undefined} */
  let lastErrorCode

  for (let port = range.from; port <= range.to; port += 1) {
    if (usedPorts.has(port)) {
      reserved += 1
      continue
    }

    const result = await tryPort({host, port})

    if ("port" in result) {
      usedPorts.add(result.port)
      return result.port
    }

    if (result.code === "EADDRINUSE") {
      inUse += 1
    } else {
      unavailable += 1
      lastErrorCode = result.code
    }
  }

  const total = range.to - range.from + 1
  const details = [`${reserved} reserved by this deploy`, `${inUse} already in use`]

  if (unavailable > 0) details.push(`${unavailable} could not be bound (e.g. ${lastErrorCode})`)

  throw new Error(
    `No available ports in range ${range.from}-${range.to} (${total} port${total === 1 ? "" : "s"} on ${host}): ` +
    `${details.join(", ")}. Widen the port range, free a port, or check bind permissions.`
  )
}
