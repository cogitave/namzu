import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { detailsTriggerLabel } from './conversation-details-popover.js'

it('puts the background work count in the accessible name', () => {
	expect(detailsTriggerLabel({ state: 'checking' })).toBe('Conversation details')
	expect(detailsTriggerLabel({ state: 'known', running: 0, needsAttention: false })).toBe(
		'Conversation details',
	)
	expect(detailsTriggerLabel({ state: 'known', running: 1, needsAttention: false })).toBe(
		'Conversation details, 1 process running',
	)
	expect(detailsTriggerLabel({ state: 'known', running: 2, needsAttention: true })).toBe(
		'Conversation details, 2 processes running, background work needs attention',
	)
	expect(detailsTriggerLabel({ state: 'known', running: 0, needsAttention: true })).toBe(
		'Conversation details, background work needs attention',
	)
})

// The added and removed colours sit on the popover surface in both themes.
function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	}) as [number, number, number]
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
	return (hi + 0.05) / (lo + 0.05)
}
it('keeps added and removed counts at AA contrast on the popover', () => {
	const css = readFileSync(new URL('./conversation-details-popover.css', import.meta.url), 'utf8')
	const theme = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
	const added = /--details-added: (#[0-9a-f]{6});/.exec(css)?.[1]
	const addedDark =
		/\.dark \.conversation-details-popup \{\s*--details-added: (#[0-9a-f]{6});/.exec(css)?.[1]
	const dark = theme.slice(theme.indexOf('\n.dark {'))
	const popoverDark = /--popover: (#[0-9a-f]{6});/.exec(dark)?.[1]
	const removedLight = /--error-foreground: (#[0-9a-f]{6});/.exec(theme)?.[1]
	const removedDark = /--error-foreground: (#[0-9a-f]{6});/.exec(dark)?.[1]
	if (!added || !addedDark || !popoverDark || !removedLight || !removedDark)
		throw new Error('missing token')
	expect(ratio(added, '#ffffff')).toBeGreaterThanOrEqual(4.5)
	expect(ratio(removedLight, '#ffffff')).toBeGreaterThanOrEqual(4.5)
	expect(ratio(addedDark, popoverDark)).toBeGreaterThanOrEqual(4.5)
	expect(ratio(removedDark, popoverDark)).toBeGreaterThanOrEqual(4.5)
})
