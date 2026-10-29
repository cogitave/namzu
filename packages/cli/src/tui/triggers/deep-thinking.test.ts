import { describe, expect, it } from 'vitest'

import { resolveComposerTriggers } from '../../config/composer-triggers.js'
import { triggerEffort } from './context-text.js'
import { type TriggerContext, detectTriggers } from './detect.js'
import { compileRegistry } from './registry.js'

const context: TriggerContext = {
	permissionMode: 'prompt',
	sessionHypermode: false,
	effortMenu: true,
	agentTool: true,
	skillCreator: true,
	scheduleTool: true,
}
const registry = (arming: 'arm' | 'suggest' | 'off') =>
	compileRegistry(undefined, { arming: { 'max-effort': arming } })

const state = (text: string) =>
	detectTriggers(text, registry('arm'), context).hits.find((hit) => hit.id === 'max-effort')
		?.state ?? 'none'

describe('deep-thinking keyword', () => {
	it('keeps the default off; a keyword alone cannot change effort', () => {
		expect(resolveComposerTriggers(undefined).arming['max-effort']).toBe('off')
		expect(detectTriggers('ultrathink fix the parser', compileRegistry(), context).hits).toEqual([])
	})

	it.each([
		['ultrathink fix the parser', 'armed'],
		['fix the parser, ULTRATHINK', 'armed'],
		['what is ultrathink?', 'suggested'],
		['the ultrathink keyword', 'suggested'],
		['explain `ultrathink`', 'none'],
		['"ultrathink" fix the parser', 'none'],
		['/ultrathink fix the parser', 'none'],
		['ultrathinking fixes', 'none'],
	])('with opt-in arming, %s is %s', (text, expected) => {
		expect(state(text)).toBe(expected)
	})

	it('suggests when configured to suggest, and requires an explicit arm', () => {
		const text = 'ultrathink fix the parser'
		const hit = detectTriggers(text, registry('suggest'), context).hits[0]
		expect(hit?.state).toBe('suggested')
		const armed = detectTriggers(text, registry('suggest'), context, {
			overrides: new Map([[hit?.key ?? '', 'armed']]),
		})
		expect(armed.hits[0]?.state).toBe('armed')
		expect(
			triggerEffort(
				armed.hits.map((entry) => entry.id),
				['low', 'high'],
			),
		).toBe('high')
	})

	it('does not arm pasted or recalled text even with opt-in arming', () => {
		expect(
			detectTriggers('ultrathink fix the parser', registry('arm'), context, {
				nonTyped: [[0, 10]],
			}).hits[0]?.state,
		).toBe('suggested')
	})

	it('uses only a published effort level and has no fabricated fallback', () => {
		expect(triggerEffort(['max-effort'], ['low', 'medium'])).toBe('medium')
		expect(triggerEffort(['max-effort'], ['high', 'max'])).toBe('max')
		expect(triggerEffort(['max-effort'], [])).toBeUndefined()
		expect(triggerEffort(['max-effort'], undefined)).toBeUndefined()
		expect(triggerEffort([], ['low', 'high'])).toBeUndefined()
		expect(
			detectTriggers('ultrathink fix the parser', registry('arm'), {
				...context,
				effortMenu: false,
			}).hits[0],
		).toMatchObject({
			state: 'unavailable',
			reason: 'unavailable: this model publishes no effort levels',
		})
	})
})
