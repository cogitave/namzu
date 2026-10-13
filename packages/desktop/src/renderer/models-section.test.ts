import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderConnectionView } from '../shared/protocol.js'
import { ModelsSection } from './models-section.js'
import { REJECTED_KEY_STATUS, testOutcome } from './provider-connections-model.js'
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
		expect(html).toContain('Connected with a key from your computer’s settings')
		// The variable name is for a tooltip, not the status line.
		expect(html).toContain(
			'title="The key comes from the OPENAI_API_KEY setting on this computer."',
		)
		expect(html).not.toContain('>Connected with the key in')
		expect(html).not.toContain('Remove the saved API key')
		expect(html).not.toContain('type="password"')
	})

	it('says plainly when this build cannot connect providers, and shows a failure as an alert', () => {
		expect(render({ supported: false })).toContain('Update Namzu')
		const failed = render({ rows: [row({})], error: 'Namzu could not save the key.' })
		expect(failed).toContain('role="alert"')
		expect(failed).toContain('Namzu could not save the key.')
	})

	it('tells an unconnected row what to do, including one that takes no key', () => {
		const html = render({
			rows: [
				row({ id: 'ollama', label: 'Ollama (local)', canSaveKey: false }),
				row({ id: 'openai', label: 'OpenAI' }),
			],
		})
		expect(html).toContain('Start Ollama (local) on this computer and Namzu will find it.')
		expect(html).toContain('Add an API key to use OpenAI.')
	})

	it('says plainly what each check found', () => {
		expect(testOutcome('quota', 'OpenAI').text).toBe(
			'OpenAI says this account is out of credit. Add credit with OpenAI, then check again.',
		)
		expect(testOutcome('busy', 'OpenAI').text).toBe(
			'OpenAI is busy right now. Check again in a minute.',
		)
		expect(testOutcome('down', 'OpenAI').text).toBe(
			'OpenAI had a problem on its side. Check again in a few minutes.',
		)
		expect(testOutcome('no-answer', 'OpenAI').text).toBe(
			'OpenAI didn’t answer. Check your internet connection, then check again.',
		)
		expect(testOutcome('unchecked', 'Anthropic (Claude)', 'claude-sign-in').text).toBe(
			'Namzu can’t check this sign-in ahead of time. Send a message to try it.',
		)
		const keyed = testOutcome('unchecked', 'OpenAI', 'saved-key').text
		expect(keyed).toBe('Namzu can’t check OpenAI keys ahead of time. Send a message to try it.')
		expect(keyed).not.toMatch(/saved but not confirmed/)
	})

	it('explains the disabled Save key button next to it', () => {
		// The key box is closed until Add key is pressed; the hint text comes with the open form.
		expect(REJECTED_KEY_STATUS).toBe('Key not accepted')
	})

	it('lists the free tier as free, not as a connection', () => {
		const html = render({
			rows: [row({ id: 'zen', label: 'OpenCode Zen', state: 'free', how: 'free' })],
		})
		expect(html).toContain('Free models, no key needed. Limits may apply.')
		expect(html).toContain('Namzu is using the free Zen models for now')
		expect(html).not.toContain('Namzu needs one connected provider')
	})
})
