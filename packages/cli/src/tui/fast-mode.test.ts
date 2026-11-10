import { describe, expect, it } from 'vitest'

import { fitStatusLine } from './StatusBar.js'
import { fastModeBlocker } from './fast-mode.js'

const BEFORE = Date.UTC(2026, 10, 29)
const AFTER = Date.UTC(2026, 10, 30)

describe('what /fast and --fast ask of the model', () => {
	it('accepts a model the vendor documents it on', async () => {
		expect(await fastModeBlocker('anthropic', 'claude-opus-5-5', BEFORE)).toBeUndefined()
		expect(await fastModeBlocker('anthropic', 'claude-fable-5-2', BEFORE)).toBeUndefined()
	})

	it('refuses another provider, and says to pick an Anthropic model', async () => {
		expect(await fastModeBlocker('openai', 'gpt-x', BEFORE)).toContain('Anthropic models only')
		expect(await fastModeBlocker(undefined, 'claude-opus-5-5', BEFORE)).toContain('Anthropic')
	})

	it('refuses a custom or compatible endpoint, naming the host', async () => {
		const reason = await fastModeBlocker('anthropic', 'claude-opus-5-5', BEFORE, 'gw.example.com')
		expect(reason).toContain('gw.example.com')
		expect(reason).toContain('own endpoint')
		expect(await fastModeBlocker('anthropic', 'claude-opus-5-5', BEFORE, null)).toBeUndefined()
	})

	it('refuses an Anthropic model without it, naming where it exists', async () => {
		expect(await fastModeBlocker('anthropic', 'claude-sonnet-5-5', BEFORE)).toContain('Opus 5.5')
		expect(await fastModeBlocker('anthropic', null, BEFORE)).toContain('needs a model')
	})

	it('stops offering opus 4.8 on its removal date and names the replacement', async () => {
		expect(await fastModeBlocker('anthropic', 'claude-opus-4-8', BEFORE)).toBeUndefined()
		expect(await fastModeBlocker('anthropic', 'claude-opus-4-8', AFTER)).toContain(
			'claude-opus-5-5',
		)
	})
})

describe('the footer', () => {
	const base = {
		columns: 80,
		provider: null,
		model: 'claude-opus-5-5',
		effort: 'high',
		interrupt: null,
		modeLabel: '',
	}

	it('shows fast only when it is on', () => {
		expect(fitStatusLine({ ...base, fast: true }).fast).toBe('fast')
		expect(fitStatusLine({ ...base, fast: false }).fast).toBeNull()
		expect(fitStatusLine(base).fast).toBeNull()
	})

	it('goes before the effort label on a narrow line', () => {
		const roomy = fitStatusLine({ ...base, columns: 40, fast: true })
		expect(roomy.effort).toBe('effort high')
		const tight = fitStatusLine({ ...base, columns: 15, model: null, fast: true })
		expect(tight.fast === null && tight.effort !== null).toBe(true)
	})
})
