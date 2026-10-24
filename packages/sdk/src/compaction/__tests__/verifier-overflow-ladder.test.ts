/**
 * The summariser's own overflow, handled by a round ladder: send less (the older half of the excerpt, behind a placeholder,
 * at most three times), then work from everything already extracted.
 */

import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../types/message/index.js'
import type { ChatCompletionParams } from '../../types/provider/chat.js'
import type { LLMProvider } from '../../types/provider/interface.js'
import type { StreamChunk } from '../../types/provider/stream.js'
import { WorkingStateManager } from '../manager.js'
import { buildVerifiedSummary } from '../verifier.js'

const PLACEHOLDER = '[earlier conversation truncated for compaction retry]'

function provider(
	limitChars: number,
	wording = 'prompt is too long',
): LLMProvider & { sizes: number[]; prompts: string[] } {
	const sizes: number[] = []
	const prompts: string[] = []
	return {
		id: 'mock',
		name: 'mock',
		sizes,
		prompts,
		chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			const text = params.messages
				.map((m) => (typeof m.content === 'string' ? m.content : ''))
				.join('')
			sizes.push(text.length)
			prompts.push(text)
			return (async function* () {
				if (text.length > limitChars) throw Object.assign(new Error(wording), { status: 400 })
				yield { id: 'r', delta: { content: 'COMPLETE' }, finishReason: 'stop' }
			})()
		},
	}
}

function setup() {
	const config = CompactionConfigSchema.parse({ llmVerification: true, convoTextBudget: 8_000 })
	const manager = new WorkingStateManager(config)
	manager.setTask('write the quarterly report')
	const older: Message[] = [
		createUserMessage(`start ${'u'.repeat(4_000)}`),
		createAssistantMessage(`reply ${'a'.repeat(4_000)}`),
	]
	return { config, manager, older }
}

describe('a verifier request that overflows', () => {
	it('is retried with the older half of the excerpt dropped behind a placeholder', async () => {
		const { config, manager, older } = setup()
		const llm = provider(4_800)
		await buildVerifiedSummary(manager, older, llm, config, undefined, 'm')

		expect(llm.sizes.length).toBeGreaterThan(1)
		expect(llm.sizes.at(-1)).toBeLessThanOrEqual(4_800)
		expect(llm.prompts[0]).not.toContain(PLACEHOLDER)
		expect(llm.prompts.at(-1)).toContain(PLACEHOLDER)
	})

	it('falls back to the extracted state after three truncations', async () => {
		const { config, manager, older } = setup()
		const llm = provider(10)
		const out = await buildVerifiedSummary(manager, older, llm, config, undefined, 'm')

		// The first request and three truncated ones.
		expect(llm.sizes).toHaveLength(4)
		expect(out).toContain('write the quarterly report')
		expect(out).not.toContain('LLM Verification Additions')
	})

	it('does not retry a failure that is not an overflow', async () => {
		const { config, manager, older } = setup()
		const llm = provider(10, 'upstream exploded')
		await expect(buildVerifiedSummary(manager, older, llm, config, undefined, 'm')).rejects.toThrow(
			'upstream exploded',
		)
		expect(llm.sizes).toHaveLength(1)
	})
})
