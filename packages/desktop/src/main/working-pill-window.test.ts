import { describe, expect, it } from 'vitest'
import { PILL_COLLAPSED_HEIGHT, PILL_WIDTH, pillPage } from './working-pill-page.js'

describe('the working pill page', () => {
	it('draws text with textContent and never as markup', () => {
		const page = pillPage()
		expect(page).not.toContain('innerHTML')
		expect(page).toContain("textContent='Namzu is using '+v.app")
	})

	it('allows no network and no remote script', () => {
		const page = pillPage()
		expect(page).toContain("default-src 'none'")
		expect(page).not.toMatch(/https?:\/\//)
	})

	it('has a Stop button and three answers, named for a screen reader', () => {
		const page = pillPage()
		expect(page).toContain('aria-label="Stop Namzu"')
		for (const id of ['allow', 'once', 'deny']) expect(page).toContain(`id="${id}"`)
		expect(PILL_WIDTH).toBeGreaterThan(300)
		expect(PILL_COLLAPSED_HEIGHT).toBeLessThan(80)
	})
})
