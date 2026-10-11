/**
 * The setup screen and the provider list, in plain words, at 50 and 80 columns.
 *
 * The sentences were rewritten for people, and a longer sentence is only a
 * gain if it still wraps inside the terminal instead of running off it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderSetup } from '../ProviderSetup.js'
import { type Screen, renderToScreen } from './support/screen.js'

vi.mock('../../integrations/providers/discover.js', () => ({
	discoverProviders: vi.fn(async () => []),
}))
vi.mock('../../integrations/providers/setup.js', () => ({
	probeHarnesses: vi.fn(async () => [
		{
			harness: { id: 'claude', label: 'Claude Code', npmPackage: '@anthropic-ai/claude-code' },
			installed: true,
			version: '2.1.295',
			access: 'Not signed in for Namzu · run namzu login claude',
		},
		{
			harness: { id: 'opencode', label: 'OpenCode', npmPackage: 'opencode-ai' },
			installed: false,
			version: '',
			access: 'Zen free models · experimental, Zen may refuse them',
		},
	]),
	installHarness: vi.fn(async () => ({ code: 0, output: 'installed' })),
}))

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

/** The screen as one run of words: borders and wrapping removed. */
function words(screen: Screen): string {
	return screen
		.viewport()
		.map((line) => line.replace(/[│┌┐└┘─]/g, ' '))
		.join(' ')
		.replace(/\s+/g, ' ')
}

describe.each([50, 80])('at %i columns', (cols) => {
	it('draws the setup screen in plain words, inside the terminal', async () => {
		const screen = await renderToScreen(
			<ProviderSetup cwd="/tmp" onClose={() => {}} onConnect={() => {}} />,
			{ cols, rows: 30 },
		)
		mounted = screen
		await vi.waitFor(async () => {
			await screen.waitForRender()
			expect(words(screen)).toContain('Not installed')
		})
		for (const line of screen.viewport()) expect([...line].length).toBeLessThanOrEqual(cols)
		const text = words(screen)
		expect(text).toContain(
			'Namzu talks to providers itself. Codex, Claude Code and OpenCode are optional; Namzu can reuse their sign-ins.',
		)
		expect(text).toContain('Not signed in for Namzu · run namzu login claude')
		expect(text).toContain('Zen free models · experimental, Zen may refuse them')
		expect(text).toContain('Choose a provider. Installing it and signing in are separate steps.')
		expect(text).not.toMatch(/credential owners|gateway|OpenCode installation recommended/)
	})
})
