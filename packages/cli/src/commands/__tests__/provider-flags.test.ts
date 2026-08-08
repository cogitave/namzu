import { describe, expect, it } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { applyProviderFlags } from '../run-flags.js'

const chain: Preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'primary-model' }, { id: 'openai' }, { id: 'ollama' }],
}

const noFlags = { provider: null, model: null }

describe('applyProviderFlags', () => {
	it('leaves the chain untouched when neither flag is given', () => {
		expect(applyProviderFlags(chain, noFlags)).toBe(chain)
	})

	it('--provider REPLACES the chain, so the run cannot answer from an unnamed provider', () => {
		// The decision this test exists for. Prepending and keeping the tail
		// would let a run the operator scoped to one provider be served by a
		// different one, with the flag they passed saying otherwise.
		const out = applyProviderFlags(chain, { ...noFlags, provider: 'openai' })
		expect(out.providers).toEqual([{ id: 'openai' }])
	})

	it('--provider drops the previous primary’s model rather than carrying it across', () => {
		const out = applyProviderFlags(chain, { ...noFlags, provider: 'ollama' })
		expect(out.providers[0]?.model).toBeUndefined()
	})

	it('--provider with --model models the single member that replaced the chain', () => {
		const out = applyProviderFlags(chain, { provider: 'openai', model: 'chosen' })
		expect(out.providers).toEqual([{ id: 'openai', model: 'chosen' }])
	})

	it('--model alone re-models the primary and KEEPS the fallbacks', () => {
		// A statement about the model is not a statement about which providers
		// are viable, so the chain survives it.
		const out = applyProviderFlags(chain, { ...noFlags, model: 'chosen' })
		expect(out.providers).toEqual([
			{ id: 'anthropic', model: 'chosen' },
			{ id: 'openai' },
			{ id: 'ollama' },
		])
	})

	it('preserves everything else on the preferences', () => {
		const withSubagents: Preferences = { ...chain, subagents: { active: ['one'] } }
		const out = applyProviderFlags(withSubagents, { ...noFlags, provider: 'openai' })
		expect(out.subagents?.active).toEqual(['one'])
		expect(out.version).toBe(3)
	})
})
