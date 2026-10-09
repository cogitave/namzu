import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderConnectionView } from '../shared/protocol.js'
import { ModelsSection } from './models-section.js'
import type { ProviderConnectionsControls } from './use-provider-connections.js'

const row = (over: Partial<ProviderConnectionView>): ProviderConnectionView => ({
	id: 'openai',
	label: 'OpenAI',
	state: 'not-connected',
	canSaveKey: true,
	hasSavedKey: false,
	...over,
})
const controls = (
	over: Partial<ProviderConnectionsControls> = {},
): ProviderConnectionsControls => ({
	rows: [],
	loading: false,
	supported: true,
	reload: vi.fn(),
	save: vi.fn(async () => true),
	remove: vi.fn(async () => true),
	test: vi.fn(async () => 'ok' as const),
	...over,
})
const render = (over?: Partial<ProviderConnectionsControls>) =>
	renderToStaticMarkup(createElement(ModelsSection, { connections: controls(over) }))

describe('Settings ▸ Models', () => {
	it('tells a first-timer what to do and offers Add key on each provider that takes one', () => {
		const html = render({
			rows: [
				row({ id: 'anthropic', label: 'Anthropic (Claude)', help: 'Or sign in with Claude Code.' }),
				row({ id: 'codex', label: 'OpenAI (Codex subscription)', canSaveKey: false }),
			],
		})
		expect(html).toContain('Namzu needs one connected provider')
		expect(html).toContain('aria-label="Add an API key for Anthropic (Claude)"')
		expect(html).toContain('Or sign in with Claude Code.')
		expect(html).toContain('Not connected')
		// A subscription provider offers no key box.
		expect(html).not.toContain('API key for OpenAI (Codex subscription)')
		expect(html).toContain('Keys stay on this computer')
	})

	it('shows how a connected provider is connected, with Check, Replace and Remove for a saved key', () => {
		const html = render({
			rows: [row({ state: 'connected', how: 'saved-key', hasSavedKey: true })],
		})
		expect(html).toContain('Connected with the key you saved')
		expect(html).toContain('aria-label="Check the connection to OpenAI"')
		expect(html).toContain('aria-label="Replace the API key for OpenAI"')
		expect(html).toContain('aria-label="Remove the saved API key for OpenAI"')
		expect(html).toContain('Namzu answers with the providers marked connected.')
	})

	it('never draws a key and does not offer Remove for a key from the environment', () => {
		const html = render({
			rows: [row({ state: 'connected', how: 'environment', envName: 'OPENAI_API_KEY' })],
		})
		expect(html).toContain('OPENAI_API_KEY')
		expect(html).not.toContain('Remove the saved API key')
		expect(html).not.toContain('type="password"')
	})

	it('says plainly when this build cannot connect providers, and shows a failure as an alert', () => {
		expect(render({ supported: false })).toContain('Update Namzu')
		const failed = render({ rows: [row({})], error: 'Namzu could not save the key.' })
		expect(failed).toContain('role="alert"')
		expect(failed).toContain('Namzu could not save the key.')
	})

	it('lists the free tier as free, not as a connection', () => {
		const html = render({
			rows: [row({ id: 'zen', label: 'OpenCode Zen', state: 'free', how: 'free' })],
		})
		expect(html).toContain('Free models. Needs a free Zen key.')
		expect(html).toContain('Namzu needs one connected provider')
	})
})
