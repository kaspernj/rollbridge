// Exits cleanly on SIGINT but ignores SIGTERM, so a test can verify that a custom
// stopSignal is used (a SIGTERM-only stop would have to fall through to SIGKILL).

process.on("SIGTERM", () => {})
process.on("SIGINT", () => process.exit(0))
setInterval(() => {}, 1000)
