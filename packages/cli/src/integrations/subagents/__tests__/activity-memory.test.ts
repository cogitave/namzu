import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

it('retains preview storage without the large tool results behind it', async () => {
	const activity = new URL('../activity.ts', import.meta.url)
	const fixture = new URL('../__fixtures__/activity-memory.mjs', import.meta.url)
	const { stdout } = await execFileAsync(process.execPath, [
		'--expose-gc',
		'--import',
		'tsx',
		fileURLToPath(fixture),
		activity.href,
	])
	const result = JSON.parse(stdout) as {
		heapGrowth: number
		resultCount: number
		resultCodeUnits: number
		rowCount: number
		retainedCodeUnits: number
	}
	expect(result.rowCount).toBe(80)
	expect(result.retainedCodeUnits).toBeLessThanOrEqual(80 * 2 * 2_048)
	// The old sliced previews retained all 80 MB. Leave ample room for V8
	// bookkeeping while requiring the monitor to release most payload storage.
	expect(result.heapGrowth).toBeLessThan((result.resultCount * result.resultCodeUnits) / 4)
	// A real child process loads the runtime and performs explicit garbage collection.
}, 30_000)
