// @ts-check

import fs from "node:fs"

const lifecyclePath = process.env.ROLLBRIDGE_TEST_LIFECYCLE_PATH

if (!lifecyclePath) throw new Error("ROLLBRIDGE_TEST_LIFECYCLE_PATH is required")

/** @param {string} event - Lifecycle event. */
const record = (event) => {
  fs.appendFileSync(lifecyclePath, `${JSON.stringify({event, pid: process.pid, processId: process.env.ROLLBRIDGE_PROCESS_ID})}\n`)
}

record("started")
process.on("SIGTERM", () => {
  record("stopped")
  process.exit(0)
})
setInterval(() => {}, 1000)
