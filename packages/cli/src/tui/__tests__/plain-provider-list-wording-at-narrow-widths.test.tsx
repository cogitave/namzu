/**
 * The provider list's plain wording at 50 and 80 columns: the subtitle and the
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

describe.each([50, 80])('at %i columns', (cols) => {
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
		const text = words(screen)
		expect(text).toContain('2 found · sign-ins, API keys and local servers')
		expect(text).toContain('Zen free models · experimental, Zen may refuse them')
		expect(text).not.toMatch(/existing sign-ins|optional keys|gateway may refuse/)
	})
})
