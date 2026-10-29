import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('../__fixtures__/bounded-text-heap.mjs', import.meta.url))
const run = promisify(execFile)

it.each(['budget', 'window', 'short-window'])(
	'lets %s previews release their large source strings',
	async (mode) => {
		const { stdout } = await run(process.execPath, ['--expose-gc', fixture, mode])
		const result = JSON.parse(stdout) as {
			sourceBytes: number
			retainedChars: number
			growth: number
		}
		expect(result.sourceBytes).toBe(48 * 1024 * 1024)
		expect(result.retainedChars).toBeLessThanOrEqual(12 * 40_000)
		// A backing-string leak retains about 48 MiB. Allow 12 MiB for previews and
		// engine overhead; this measures full-GC ownership, never elapsed time.
		expect(result.growth).toBeLessThan(result.sourceBytes / 4)
	},
	// Each case starts a real Node process and generates 48 MiB of random text.
	30_000,
)
