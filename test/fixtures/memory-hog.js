// Allocates and fills memory above a configured size, then stays alive, to exercise
// memory supervision. ROLLBRIDGE_HOG_BYTES controls how much resident memory to hold.

const targetBytes = Number(process.env.ROLLBRIDGE_HOG_BYTES || 200 * 1024 * 1024)
const chunkBytes = 16 * 1024 * 1024
const buffers = []
let allocated = 0

while (allocated < targetBytes) {
  const size = Math.min(chunkBytes, targetBytes - allocated)

  // Fill so the pages are resident (counted in RSS), not lazily reserved.
  buffers.push(Buffer.alloc(size, 1))
  allocated += size
}

// Keep the buffers referenced and the process alive.
globalThis.__rollbridgeHog = buffers
setInterval(() => {}, 1000)
