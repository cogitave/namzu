import { expect, it } from 'vitest'
import { quickEntryPage, quickEntryUrl } from './quick-entry-page.js'

it('is one line to type in, submitted by Enter and closed by Escape, with no outside address', () => {
	const page = quickEntryPage()
	expect(page).toContain('<input id="line"')
	expect(page).toContain("event.key==='Escape'")
	expect(page).toContain("event.key==='Enter'")
	expect(page).toContain('window.quickEntry.submit')
	expect(page).not.toMatch(/https?:\/\//)
	expect(decodeURIComponent(quickEntryUrl().split(',')[1] ?? '')).toBe(page)
})
