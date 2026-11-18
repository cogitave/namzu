import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The long response time box is greyed while Task complete is Off; a disabled field that looks
// like an enabled one tells the person nothing, so the style must say it.
describe('a disabled settings input', () => {
	it('is drawn dimmed', () => {
		const css = readFileSync(new URL('./settings-page.css', import.meta.url), 'utf8')
		const rule = /\.settings-config-input:disabled\s*\{([^}]*)\}/.exec(css)
		expect(rule?.[1]).toMatch(/opacity:\s*0\.5/)
	})
})
