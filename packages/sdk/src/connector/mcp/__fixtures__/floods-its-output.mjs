// A peer that writes more than one protocol frame's worth of output before it
// terminates a line, so a client that keeps the unterminated tail is fed for
// as long as this runs. Afterwards it terminates the line, sends one
// well-formed frame and stays alive, so teardown has a child of its own to
// reap. `argv[2]` is the stdout flood in bytes, `argv[3]` the stderr flood.
import { once } from 'node:events'

const stdoutBytes = Number(process.argv[2] ?? 0)
const stderrBytes = Number(process.argv[3] ?? 0)
const CHUNK_CHARS = 64 * 1024

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

async function fill(stream, total) {
	const chunk = 'x'.repeat(Math.min(CHUNK_CHARS, total) || 1)
	let written = 0
	while (written < total) {
		const slice = chunk.slice(0, Math.min(chunk.length, total - written))
		written += slice.length
		if (!stream.write(slice)) await once(stream, 'drain')
	}
}

await fill(process.stdout, stdoutBytes)
process.stdout.write('\n')
process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/flooded' })}\n`)
await fill(process.stderr, stderrBytes)

setInterval(() => {}, 1_000)
// A safety timer so a deliberately broken mutation cannot orphan this.
setTimeout(() => process.exit(70), 30_000).unref()
