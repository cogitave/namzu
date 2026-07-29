/**
 * The EMPTY VERIFIER REPLY.
 *
 * `buildVerifiedSummary` treats only the literal `COMPLETE` as "nothing to add".
 * Anything else is appended under a `## LLM Verification Additions` heading —
 * including the empty string, which is what a truncated turn, a refusal, or an
 * exhausted `llmVerificationMaxTokens` produces. The result is a heading with
 * nothing under it, and because the summary becomes a leading system message it
 * then rides in EVERY subsequent prompt of the run.
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

const ADDITIONS_HEADING = '## LLM Verification Additions'

function makeProvider(chunks: StreamChunk[]): LLMProvider & { calls: ChatCompletionParams[] } {
	const calls: ChatCompletionParams[] = []
	return {
		id: 'mock',
		name: 'mock',
		calls,
		chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			calls.push(params)
			return (async function* () {
				for (const c of chunks) yield c
			})()
		},
	}
}

function makeManager() {
	const config = CompactionConfigSchema.parse({ llmVerification: true })
	const manager = new WorkingStateManager(config)
	manager.setTask('write the quarterly report')
	manager.addDecision('built the report as .docx')
	return { config, manager }
}

const OLDER: Message[] = [
	createUserMessage('write the quarterly report'),
	createAssistantMessage('on it — reading the source numbers first'),
]

describe('buildVerifiedSummary — empty verifier reply', () => {
	it('does not append an empty "Additions" section when the verifier returns nothing', async () => {
		const { config, manager } = makeManager()
		const provider = makeProvider([])

		const result = await buildVerifiedSummary(manager, OLDER, provider, config)

		expect(result).not.toContain(ADDITIONS_HEADING)
	})

	it('does not append an empty "Additions" section when the turn is truncated by maxTokens', async () => {
		const { config, manager } = makeManager()
		// `length` finish reason with no content — llmVerificationMaxTokens exhausted.
		const provider = makeProvider([{ id: 'c1', delta: { content: '' }, finishReason: 'length' }])

		const result = await buildVerifiedSummary(manager, OLDER, provider, config)

		expect(result).not.toContain(ADDITIONS_HEADING)
	})

	it('does not append an "Additions" section for a whitespace-only reply', async () => {
		const { config, manager } = makeManager()
		const provider = makeProvider([{ id: 'c1', delta: { content: '   \n\n  ' } }])

		const result = await buildVerifiedSummary(manager, OLDER, provider, config)

		expect(result).not.toContain(ADDITIONS_HEADING)
	})

	it('still appends real additions', async () => {
		const { config, manager } = makeManager()
		const provider = makeProvider([
			{ id: 'c1', delta: { content: '- the user asked for EUR, not USD' } },
		])

		const result = await buildVerifiedSummary(manager, OLDER, provider, config)

		expect(result).toContain(ADDITIONS_HEADING)
		expect(result).toContain('EUR, not USD')
	})
})
