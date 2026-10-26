import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { PromptContributionRegistry } from '../../../prompt/contributions.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { ProjectId } from '../../../types/session/ids.js'
import { PromptCache, type PromptCacheInput } from '../prompt-cache.js'
import { PromptBuilder } from '../prompt.js'

const emptyTools = () => new ToolManager({ toolsets: [], messages: () => [] })

function inputWith(dynamicText: string): PromptCacheInput {
	const contributions = new PromptContributionRegistry()
	contributions.register({ id: 'rules', placement: 'static', render: () => 'STATIC RULES' })
	contributions.register({ id: 'facts', placement: 'dynamic', render: () => dynamicText })
	return { systemPrompt: 'be brief', tools: emptyTools(), contributions }
}

describe('the whole prompt and the segments a request sends', () => {
	it('build() is the static segment then the dynamic one, joined by the separator', () => {
		const builder = new PromptBuilder(inputWith('DYNAMIC FACTS'))
		const { static: staticText, dynamic } = builder.buildSegmented('full', '/work')

		expect(builder.build('full', '/work')).toBe(`${staticText}\n\n---\n\n${dynamic}`)
	})

	it('puts a static contribution before a dynamic one, in both forms', () => {
		const whole = new PromptBuilder(inputWith('DYNAMIC FACTS')).build('full', '/work')

		expect(whole.indexOf('STATIC RULES')).toBeGreaterThanOrEqual(0)
		expect(whole.indexOf('STATIC RULES')).toBeLessThan(whole.indexOf('DYNAMIC FACTS'))
	})

	it('is just the static segment when nothing is dynamic', () => {
		const builder = new PromptBuilder({ systemPrompt: 'be brief', tools: emptyTools() })

		expect(builder.build('minimal')).toBe(builder.buildSegmented('minimal').static)
	})

	it('hashes what is sent: changing dynamic text moves the whole-prompt hash', () => {
		const cache = new PromptCache({ projectId: 'p' as ProjectId, agentId: 'a' })
		cache.getSystemPrompt(inputWith('ONE'))
		const first = cache.configHash

		cache.getSystemPrompt(inputWith('TWO'))

		expect(cache.configHash).not.toBe(first)
	})

	it('computes the hash over the same text the segments send, in the order they are sent', () => {
		const input = inputWith('DYNAMIC FACTS')
		const cache = new PromptCache({ projectId: 'p' as ProjectId, agentId: 'a' })
		const prompt = cache.getSystemPrompt(input)
		const { static: staticText, dynamic } = new PromptBuilder(input).buildSegmented()

		expect(prompt).toBe(`${staticText}\n\n---\n\n${dynamic}`)
		const hashOf = (text: string) =>
			createHash('sha256')
				.update(
					JSON.stringify([
						'a',
						text,
						[
							['rules', 'static'],
							['facts', 'dynamic'],
						],
					]),
				)
				.digest('hex')
				.slice(0, 16)
		expect(cache.configHash).toBe(hashOf(`${staticText}\n\n---\n\n${dynamic}`))
		// The same words with the two segments swapped are a different request.
		expect(cache.configHash).not.toBe(hashOf(`${dynamic}\n\n---\n\n${staticText}`))
	})

	it('keeps the static segment byte-identical across two turns that differ only in dynamic text', () => {
		const cache = new PromptCache({ projectId: 'p' as ProjectId, agentId: 'a' })
		const one = cache.getSystemPromptSegmented(inputWith('TURN ONE'), 'full', '/work')
		const two = cache.getSystemPromptSegmented(inputWith('TURN TWO'), 'full', '/work')

		expect(two.static).toBe(one.static)
		expect(two.dynamic).not.toBe(one.dynamic)
	})
})
