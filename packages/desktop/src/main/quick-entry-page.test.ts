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

it('wears the look the main window has: dark by default, light when the window is light', () => {
	expect(quickEntryPage()).toContain('color-scheme:dark;--bg:#181818')
	expect(quickEntryPage({ appearance: 'light' })).toContain('color-scheme:light;--bg:#ffffff')
	expect(quickEntryPage()).not.toContain('prefers-color-scheme')
})

it('uses the app font, with the embedded face when one is given', () => {
	expect(quickEntryPage()).toContain('"Geist"')
	expect(quickEntryPage({ fontData: 'data:font/woff2;base64,AAAA' })).toContain(
		'src:url("data:font/woff2;base64,AAAA")',
	)
})
