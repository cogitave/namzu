/**
 * The provider list's plain wording at 40 to 80 columns: the subtitle and the
 * Zen row must still wrap inside the terminal.
 */

import { Box } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { Picker } from '../Picker.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

function words(screen: Screen): string {
	return screen
		.viewport()
		.map((line) => line.replace(/[│┌┐└┘─]/g, ' '))
		.join(' ')
		.replace(/\s+/g, ' ')
}

describe.each([40, 50, 54, 80])('at %i columns', (cols) => {
	it('draws the list subtitle and the Zen row in plain words, inside the terminal', async () => {
		const screen = await renderToScreen(
			<Box paddingX={1}>
				<Picker
					detected={[
						{
							entry: PROVIDER_REGISTRY.ollama,
							source: { kind: 'probe', url: 'http://localhost:11434' },
							alternatives: [],
						},
						{ entry: PROVIDER_REGISTRY.zen, source: { kind: 'public' }, alternatives: [] },
					]}
					onSubmit={vi.fn()}
					onCancel={vi.fn()}
					onCredential={vi.fn()}
				/>
			</Box>,
			{ cols, rows: 30 },
		)
		mounted = screen
		await screen.waitForRender()
		for (const line of screen.viewport()) expect([...line].length).toBeLessThanOrEqual(cols)
		// A wrapped line is never one short orphan word ("servers", "them"): check
		// the lines of the subtitle and of the Zen row, not the screen's other copy.
		const inner = screen.viewport().map((line) => line.replace(/[│╭╮╰╯─]/g, '').trim())
		for (const [start, last] of [
			['found ·', 'servers'],
			['Zen free models', 'them'],
		] as const) {
			const first = inner.findIndex((line) => line.includes(start))
			expect(first, `${start} is drawn at ${cols} columns`).toBeGreaterThanOrEqual(0)
			for (let row = first; row < inner.length && inner[row] !== ''; row++) {
				expect(inner[row], `an orphan word at ${cols} columns`).not.toMatch(/^\S{1,8}$/)
				if (inner[row]?.endsWith(last)) break
			}
		}
		const text = words(screen)
		expect(text).toContain('2 found · sign-ins, API keys and local servers')
		expect(text).toContain('Zen free models · experimental, and Zen may refuse them')
		expect(text).not.toMatch(/existing sign-ins|optional keys|gateway may refuse/)
	})
})
