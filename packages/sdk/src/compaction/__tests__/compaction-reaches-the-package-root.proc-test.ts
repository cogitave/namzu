import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * `compactNow` reachable from `@namzu/sdk`, not just from a deep path.
 *
 * The unit tests next door import `../manual.js` and would keep passing
 * with the barrel export deleted — a host writing
 * `import { compactNow } from '@namzu/sdk'` would be the one to find out.
 * That is the whole failure this task exists to fix, so it is asserted
 * against the BUILT package from a separate process rather than against
 * source through a bundler that resolves whatever it can find.
 */

const ROOT = new URL('../../../dist/index.js', import.meta.url).pathname

describe('host-callable compaction reaches the package root', () => {
	it('is importable as a value from the built entry point', () => {
		const out = execFileSync(
			process.execPath,
			[
				'-e',
				`import(${JSON.stringify(ROOT)}).then((m) => {
					process.stdout.write([typeof m.compactNow, typeof m.compactRegion].join(','))
				})`,
			],
			{ encoding: 'utf-8' },
		)

		expect(out).toBe('function,function')
	})
})
