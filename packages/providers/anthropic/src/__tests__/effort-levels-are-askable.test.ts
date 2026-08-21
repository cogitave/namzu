import { describe, expect, it } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * A caller building an effort control has to offer the levels a model actually
 * accepts, and only those, because effort is REFUSED rather than clamped: a
 * level a model does not have makes the vendor reject the request, so a picker
 * offering the wrong one produces a run that fails at the start.
 *
 * The driver already knew the answer and kept it to itself. Every option open
 * to a caller without it was bad: offer all five and break some models, offer
 * the intersection and hide the levels that are most of the reason to build the
 * control, or copy the table — which looks fine and is worst, because the
 * ceiling has moved twice and a copy goes stale SILENTLY, surfacing as a vendor
 * rejection rather than a failing build.
 */

const provider = (): AnthropicProvider =>
	new AnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5' })

describe('a caller can ask which levels a model takes', () => {
	it('publishes the canonical model-specific menu without changing the legacy answer', () => {
		const p = provider()

		expect(p.reasoningEffortLevelsFor('claude-opus-5')).toEqual(p.effortLevelsFor('claude-opus-5'))
	})

	it('answers per model rather than per provider', () => {
		// Three eras, three different answers. If this ever collapses to one
		// set, the method has been reduced to a constant and the question it
		// exists to answer has stopped being asked.
		const p = provider()
		const modern = p.effortLevelsFor('claude-opus-5')
		const midRange = p.effortLevelsFor('claude-sonnet-4-6')
		const legacy = p.effortLevelsFor('claude-opus-4-5')

		expect(modern).toContain('xhigh')
		expect(midRange).not.toContain('xhigh')
		expect(midRange).toContain('max')
		expect(legacy).not.toContain('max')

		const distinct = new Set([modern, midRange, legacy].map((s) => [...s].sort().join(',')))
		expect(distinct.size, 'the three eras must not answer alike').toBe(3)
	})

	it('reports an empty set rather than nothing for a model with no levels', () => {
		// A real answer, and different from the method being absent. Absent
		// means the driver has no effort concept at all; empty means it does
		// and this model has none.
		expect(provider().effortLevelsFor('claude-haiku-4-5')).toEqual([])
	})
})

describe('the answer depends on the thinking configuration you will send', () => {
	it('narrows for the family that caps effort while thinking is off', () => {
		// The trap this signature exists to remove. A caller reading a single
		// `effort` array, rendering a picker, and then also sending
		// `thinking: disabled` produces a combination the vendor rejects — on
		// exactly one family, which is why it survives casual testing.
		const p = provider()
		const withThinking = p.effortLevelsFor('claude-opus-5', {
			type: 'adaptive',
		})
		const withoutThinking = p.effortLevelsFor('claude-opus-5', {
			type: 'disabled',
		})

		expect(withThinking).toContain('max')
		expect(withoutThinking).not.toContain('max')
		expect(withoutThinking).not.toContain('xhigh')
		expect(withoutThinking).toContain('high')
	})

	it('does not narrow for a sibling that accepts the full set either way', () => {
		// Measured, not inferred: the cap belongs to one family, and a version
		// comparison of "5 and later" would have caught this model too and
		// hidden levels the wire honours.
		const p = provider()
		expect(p.effortLevelsFor('claude-sonnet-5', { type: 'disabled' })).toContain('max')
	})
})

describe('the resolver is reachable for the fuller picture', () => {
	it('is exported from the package entry, not only its own module', async () => {
		// The whole report was that the answer existed and could not be
		// reached. A caller that also needs to know whether thinking can be
		// switched off at all reads the capability directly.
		const entry = await import('../index.js')

		expect(typeof entry.resolveThinkingCapability).toBe('function')
		const capability = entry.resolveThinkingCapability('claude-opus-5')
		expect(capability.effort.length).toBeGreaterThan(0)
		expect(typeof capability.canDisable).toBe('boolean')
	})
})
