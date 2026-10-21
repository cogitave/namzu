/**
 * How the modes read on screen: the footer names each by its words and colour,
 * the header warns about bypass and nothing else, and the picker lists every
 * mode a person can choose with one plain sentence each.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { PermissionMode } from '../../permissions/mode.js'
import { permissionPicker } from '../App.js'
import { BrandHeader } from '../BrandHeader.js'
import { StatusBar, modeGlyph } from '../StatusBar.js'
import { theme } from '../theme.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function footer(mode: PermissionMode) {
	const screen = await renderToScreen(
		<StatusBar provider="p" model="m" state="idle" permissionMode={mode} canCycleMode />,
		{ cols: 100, rows: 4 },
	)
	mounted = screen
	await screen.waitForRender()
	return { text: screen.viewport()[0] ?? '' }
}

describe('the footer', () => {
	it.each([
		['bypass', '⏵⏵ bypass permissions on (shift+tab to cycle)'],
		['classify', '⏵⏵ auto mode on (shift+tab to cycle)'],
		['accept-edits', '⏵⏵ accept edits on (shift+tab to cycle)'],
		['plan', '‖ plan mode on (shift+tab to cycle)'],
		['strict', '‖ preapproved only on (shift+tab to cycle)'],
		['auto', '⏵⏵ unattended on (shift+tab to cycle)'],
	] as const)('says %s in its own words', async (mode, words) => {
		expect((await footer(mode)).text).toContain(words)
	})

	it('draws bypass in red and auto in yellow, and not the same colour', () => {
		expect(modeGlyph('bypass').color).toBe(theme.status.error)
		expect(modeGlyph('classify').color).toBe(theme.status.warn)
		expect(modeGlyph('bypass').color).not.toBe(modeGlyph('classify').color)
	})

	it('does not call the kernel’s unattended mode bypass', async () => {
		expect((await footer('auto')).text).not.toContain('bypass')
	})
})

describe('the header', () => {
	async function header(mode: PermissionMode): Promise<string> {
		const screen = await renderToScreen(
			<BrandHeader version="1.2.3" permissionMode={mode} cwd="/work" />,
			{ cols: 120, rows: 12 },
		)
		mounted = screen
		await screen.waitForRender()
		return screen.viewport().join('\n')
	}

	it('warns about bypass without saying more than it does', async () => {
		const text = (await header('bypass')).replace(/\s+/g, ' ')

		expect(text).toContain('Bypass permissions')
		expect(text).toContain('including outside this folder')
		expect(text).toContain('Rules that deny or ask still apply')
		expect(text).not.toContain('tools run without asking')
	})

	it.each(['prompt', 'accept-edits', 'plan', 'classify', 'strict', 'auto'] as const)(
		'has no warning in %s',
		async (mode) => {
			expect(await header(mode)).not.toContain('Warning')
		},
	)
})

describe('the /permissions picker', () => {
	it('lists the five modes a person cycles through, each with a plain sentence, and More', () => {
		const picker = permissionPicker('prompt')

		expect(picker.values).toEqual(['prompt', 'accept-edits', 'plan', 'bypass', 'classify', 'more'])
		expect(picker.options.map((option) => option.label)).toEqual([
			'Ask before changes',
			'Auto-approve edits',
			'Plan (read-only)',
			'Bypass permissions',
			'Auto',
			'More options',
		])
		for (const option of picker.options) expect(option.description?.length).toBeGreaterThan(20)
	})

	it('keeps only preapproved-only and the rules under More', () => {
		const more = permissionPicker('prompt', true)

		expect(more.values).toEqual(['strict', 'rules'])
	})

	it('marks the current mode, and sends a current strict to More', () => {
		expect(permissionPicker('bypass').options.find((option) => option.current)?.label).toBe(
			'Bypass permissions',
		)
		expect(permissionPicker('classify').options.find((option) => option.current)?.label).toBe(
			'Auto',
		)
		expect(permissionPicker('strict').options.find((option) => option.current)?.label).toBe(
			'More options',
		)
	})

	it('says why a mode that is not open cannot be chosen, and leaves the others alone', () => {
		const picker = permissionPicker('prompt', false, { bypass: false, auto: false })
		const reasons = Object.fromEntries(
			picker.options.map((option) => [option.label, option.disabledReason]),
		)

		expect(reasons['Bypass permissions']).toContain('--allow-dangerously-skip-permissions')
		expect(reasons.Auto).toContain('not available')
		expect(reasons['Ask before changes']).toBeUndefined()
		expect(reasons['Auto-approve edits']).toBeUndefined()
		expect(reasons['Plan (read-only)']).toBeUndefined()
	})

	it('offers every mode when both are open', () => {
		const picker = permissionPicker('prompt', false, { bypass: true, auto: true })

		expect(picker.options.filter((option) => option.disabledReason)).toEqual([])
	})
})
