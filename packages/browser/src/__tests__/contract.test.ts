import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLAYWRIGHT_CORE_VERSION } from '../snapshot.js'

/**
 * The ref snapshot rests on one undocumented Playwright selector
 * (`aria-ref=`), verified against one version. An upgrade must come through
 * here: this fails until PLAYWRIGHT_CORE_VERSION is changed, which is the
 * moment to re-run the E2E contract test (`NAMZU_BROWSER_E2E=1`) and check the
 * browser build matches the cached one.
 */
describe('playwright-core pin', () => {
	it('is the version snapshot.ts was verified against', () => {
		const require = createRequire(import.meta.url)
		const entry = require.resolve('playwright-core')
		const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as {
			version: string
		}
		expect(manifest.version).toBe(PLAYWRIGHT_CORE_VERSION)
	})

	it('is pinned exactly in package.json', () => {
		const manifest = JSON.parse(
			readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
		) as { dependencies: Record<string, string> }
		expect(manifest.dependencies['playwright-core']).toBe(PLAYWRIGHT_CORE_VERSION)
	})
})
