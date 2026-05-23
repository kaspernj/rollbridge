// @ts-check

/**
 * @typedef {import("./json.js").JsonValue} JsonValue
 * @typedef {{at: string, data: Record<string, JsonValue>, message: string}} DaemonEvent
 */

/**
 * A bounded, in-memory history of structured daemon events (deploys, traffic
 * switches, stops, crashes, restarts, and failed commands). The newest events
 * are kept; the oldest are dropped once the limit is exceeded.
 */
export default class EventLog {
  /**
   * @param {number} limit - Maximum number of events to retain.
   */
  constructor(limit) {
    this.limit = limit
    this.events = /** @type {DaemonEvent[]} */ ([])
  }

  /**
   * Appends an event, dropping the oldest events beyond the limit.
   * @param {string} message - Event type/message.
   * @param {Record<string, JsonValue>} data - Structured event payload.
   * @returns {void}
   */
  record(message, data) {
    this.events.push({at: new Date().toISOString(), data, message})

    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit)
    }
  }

  /**
   * @param {number} [limit] - Maximum number of most-recent events to return; all when omitted or invalid.
   * @returns {DaemonEvent[]} The most recent events, oldest first.
   */
  recent(limit) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || limit >= this.events.length) {
      return [...this.events]
    }

    return this.events.slice(this.events.length - limit)
  }
}
