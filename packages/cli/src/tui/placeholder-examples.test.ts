import { describe, expect, it } from 'vitest'

import { examplePlaceholder } from './placeholder-examples.js'

describe('first prompt examples', () => {
	it('names the file when one is known', () => {
		const shown = new Set(
			[0, 0.25, 0.5, 0.75, 0.99].map((seed) => examplePlaceholder('src/app.ts', seed)),
		)
		expect([...shown].some((line) => line.includes('src/app.ts'))).toBe(true)
		for (const line of shown) expect(line).toMatch(/^Try ".+"$/)
	})

	it('falls back to examples without a file', () => {
		for (const seed of [0, 0.3, 0.6, 0.99]) {
			const line = examplePlaceholder(undefined, seed)
			expect(line).toMatch(/^Try ".+"$/)
			expect(line).not.toContain('undefined')
			expect(line).not.toContain('<')
		}
	})
})
