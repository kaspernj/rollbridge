// @ts-check

import net from "node:net"

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 */

/**
 * Sends a command to a Rollbridge daemon.
 * @param {object} args - Options.
 * @param {Record<string, JsonValue>} args.command - Command payload.
 * @param {string} args.path - Control socket path.
 * @returns {Promise<Record<string, JsonValue>>} Response payload.
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
      let response

      try {
        response = JSON.parse(line)
      } catch (error) {
        socket.destroy()
        reject(new Error(`Invalid Rollbridge control response from ${path}`, {cause: error}))
        return
      }

      socket.end()

      if (response.status === "error") {
        reject(new Error(String(response.error || "Unknown Rollbridge error")))
      } else {
        resolve(response)
      }
    })
    socket.write(`${JSON.stringify(command)}\n`)
  })
}

/**
 * Opens one incumbent control connection that survives listener unlink during handoff.
 * @param {string} path - Control socket path.
 * @returns {Promise<ControlSession>} Connected session.
 */
export async function openControlSession(path) {
  const session = new ControlSession(path)

  await session.connect()
  return session
}

class ControlSession {
  /** @param {string} path - Control socket path. */
  constructor(path) {
    this.path = path
    this.socket = /** @type {net.Socket | undefined} */ (undefined)
    this.buffer = ""
    this.pending = /** @type {{reject: (error: Error) => void, resolve: (value: Record<string, JsonValue>) => void} | undefined} */ (undefined)
    this.eventHandlers = /** @type {((event: Record<string, JsonValue>) => void)[]} */ ([])
    this.closePromise = /** @type {Promise<void> | undefined} */ (undefined)
    this.resolveClose = /** @type {(() => void) | undefined} */ (undefined)
  }

  /** Connects before the incumbent stops accepting new control clients. */
  async connect() {
    const socket = net.createConnection(this.path)

    socket.setEncoding("utf8")
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    socket.on("data", (chunk) => this.onData(String(chunk)))
    this.closePromise = new Promise((resolve) => { this.resolveClose = () => resolve(undefined) })
    socket.once("close", () => {
      this.pending?.reject(new Error(`Rollbridge control connection ${this.path} closed before its response`))
      this.pending = undefined
      this.resolveClose?.()
    })
    this.socket = socket
  }

  /**
   * @param {Record<string, JsonValue>} command - Command payload.
   * @returns {Promise<Record<string, JsonValue>>} Response payload.
   */
  async request(command) {
    if (!this.socket || this.socket.destroyed) throw new Error(`Rollbridge control connection ${this.path} is not connected`)
    if (this.pending) throw new Error("Rollbridge control session permits one in-flight command")
    const response = new Promise((resolve, reject) => { this.pending = {reject, resolve} })

    this.socket.write(`${JSON.stringify(command)}\n`)
    return await response
  }

  /** Closes the persistent handoff connection. */
  close() {
    this.socket?.destroy()
  }

  /** Waits for the kernel to close the incumbent control connection. */
  async closed() {
    if (!this.closePromise) throw new Error(`Rollbridge control connection ${this.path} was not opened`)
    await this.closePromise
  }

  /**
   * Subscribes to authenticated incumbent handoff events.
   * @param {(event: Record<string, JsonValue>) => void} handler - Event handler.
   */
  onEvent(handler) {
    this.eventHandlers.push(handler)
  }

  /** @param {string} chunk - Protocol bytes. */
  onData(chunk) {
    this.buffer += chunk
    let newlineIndex = this.buffer.indexOf("\n")

    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)

      try {
        const response = JSON.parse(line)

        if (response.event) {
          for (const handler of this.eventHandlers) handler(response)
        } else {
          const pending = this.pending

          this.pending = undefined
          if (pending) {
            if (response.status === "error") pending.reject(new Error(String(response.error || "Unknown Rollbridge error")))
            else pending.resolve(response)
          }
        }
      } catch (error) {
        const pending = this.pending

        this.pending = undefined
        pending?.reject(new Error(`Invalid Rollbridge control response from ${this.path}`, {cause: error}))
      }
      newlineIndex = this.buffer.indexOf("\n")
    }
  }
}
