import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./extension-dialogs.css', import.meta.url)), 'utf8')

describe('the extension dialogs', () => {
	it('the plain sentences in the install dialog are separate lines, not one block', () => {
		expect(css).toMatch(/\.extension-disclosure > p\s*\{[^}]*margin:\s*8px 0/)
	})
	it('keep no mark or chip for the window chrome', () => {
		expect(css).not.toContain('.extension-indicator')
		expect(css).not.toContain('.extension-own-chip')
	})
})
