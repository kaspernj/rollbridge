// Exits non-zero shortly after starting, to exercise auto-restart behavior.
setTimeout(() => process.exit(1), 40)
