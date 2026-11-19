import { describe, expect, it } from 'vitest'
import type { ProviderConnectionView } from '../shared/protocol.js'
import {
	connectedCount,
	connectionStatus,
	keyProblem,
	savedKeyIgnoredNote,
	testOutcome,
} from './provider-connections-model.js'

const row = (over: Partial<ProviderConnectionView>): ProviderConnectionView => ({
	id: 'openai',
	label: 'OpenAI',
	state: 'connected',
	canSaveKey: true,
	hasSavedKey: false,
	...over,
})

describe('connectionStatus', () => {
	it.each([
		[{ state: 'not-connected' as const }, 'Not connected'],
		[
			{ state: 'free' as const, how: 'free' as const },
			'Free models, experimental. Zen may refuse them.',
		],
		[
			{ how: 'environment' as const, envName: 'OPENAI_API_KEY' },
			'Connected with a key from your computer’s settings',
		],
		[{ how: 'saved-key' as const }, 'Connected with the key you saved'],
		[{ how: 'claude-sign-in' as const }, 'Connected with your Claude sign-in'],
		[{ how: 'codex-sign-in' as const }, 'Connected with your ChatGPT or Codex sign-in'],
		[{ how: 'local' as const }, 'Running on this computer'],
	])('words %j', (over, text) => {
		expect(connectionStatus(row(over))).toBe(text)
	})
})

describe('testOutcome', () => {
	it('answers in plain words and never claims a check that did not happen', () => {
		expect(testOutcome('ok', 'OpenAI')).toEqual({ text: 'OpenAI accepted the key.', tone: 'good' })
		expect(testOutcome('rejected', 'OpenAI').tone).toBe('bad')
		expect(testOutcome('rejected', 'OpenAI').text).not.toMatch(/401|HTTP/)
		expect(testOutcome('missing', 'OpenAI').tone).toBe('bad')
		const unchecked = testOutcome('unchecked', 'OpenAI')
		expect(unchecked.tone).toBe('quiet')
		expect(unchecked.text).toContain('Send a message to try it')
	})
})

describe('keyProblem', () => {
	it('catches an empty, spaced or oversized paste and accepts a plain key', () => {
		expect(keyProblem('')).toContain('Paste')
		expect(keyProblem('  ')).toContain('Paste')
		expect(keyProblem('sk-abc def')).toContain('no spaces')
		expect(keyProblem('x'.repeat(5000))).toContain('too long')
		expect(keyProblem('  sk-abc123  ')).toBeUndefined()
	})
})

it('counts only connected providers', () => {
	expect(connectedCount([row({}), row({ state: 'free' }), row({ state: 'not-connected' })])).toBe(1)
})

describe('savedKeyIgnoredNote', () => {
	it('says the environment key is used when a saved one exists too, and names no key', () => {
		const note = savedKeyIgnoredNote(
			row({ how: 'environment', envName: 'OPENAI_API_KEY', hasSavedKey: true }),
		)
		expect(note).toContain('OPENAI_API_KEY')
		expect(note).toContain('is used')
		expect(note).toContain('saved here is not used')
	})
	it('says nothing without both, or when something else supplies the key', () => {
		expect(savedKeyIgnoredNote(row({ how: 'environment', hasSavedKey: false }))).toBeUndefined()
		expect(savedKeyIgnoredNote(row({ how: 'saved-key', hasSavedKey: true }))).toBeUndefined()
	})
})
