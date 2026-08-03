import { describe, expect, it, vi } from 'vitest'

import type { AdvisorDefinition } from '../../types/advisory/index.js'
import type { StreamChunk } from '../../types/provider/index.js'
import { AdvisoryExecutor } from '../executor.js'
import { ADVISORY_RESPONSE_CONTRACT, parseAdvisoryResponse } from '../parse.js'

/**
 * `AdvisoryResult.warnings` and `.decisions` had two consumers each — the
 * advisory phase folds decisions into working state and renders warnings
 * back to the executing agent, and the advisory tool renders both — and no
 * producer at all. The parser returned `{ advice }` and a comment saying
 * structure came later. Every consumer branch was dead in a real run, and
 * their tests passed because they built the result by hand.
 */

describe('an advisor answer is read back into its parts', () => {
	it('lifts warnings and decisions out of the prose', () => {
		const parsed = parseAdvisoryResponse(
			[
				'Proceed, but slowly.',
				'<warnings>',
				'- the store is not transactional',
				'- retries are not idempotent',
				'</warnings>',
				'<decisions>',
				'- keep the existing schema',
				'</decisions>',
			].join('\n'),
		)

		expect(parsed.warnings).toEqual([
			'the store is not transactional',
			'retries are not idempotent',
		])
		expect(parsed.decisions).toEqual(['keep the existing schema'])
	})

	it('leaves the blocks out of the advice, so nothing is said twice', () => {
		const parsed = parseAdvisoryResponse('Do it.\n<warnings>\n- careful\n</warnings>')

		expect(parsed.advice).toBe('Do it.')
		expect(parsed.advice).not.toContain('careful')
	})

	it('accepts whichever bullet the model reached for', () => {
		const parsed = parseAdvisoryResponse('<decisions>\n1. first\n* second\n• third\n</decisions>')

		expect(parsed.decisions).toEqual(['first', 'second', 'third'])
	})

	it('omits the fields entirely rather than reporting empty ones', () => {
		const parsed = parseAdvisoryResponse('Just advice.\n<warnings>\n\n</warnings>')

		expect(parsed.advice).toBe('Just advice.')
		expect(parsed.warnings).toBeUndefined()
		expect(parsed.decisions).toBeUndefined()
	})

	it('treats an unclosed block as prose instead of guessing where it ends', () => {
		const parsed = parseAdvisoryResponse('Careful.\n<warnings>\n- half a thought')

		expect(parsed.warnings).toBeUndefined()
		expect(parsed.advice).toContain('half a thought')
	})

	it('reads a plain answer as pure advice', () => {
		expect(parseAdvisoryResponse('  Ship it.  ')).toEqual({ advice: 'Ship it.' })
	})
})

describe('every advisor is told the convention its answer is read with', () => {
	function capturingProvider(seen: { system?: string }) {
		return {
			chatStream: vi.fn(async function* (params: {
				messages: Array<{ role: string; content: string | null }>
			}): AsyncGenerator<StreamChunk> {
				seen.system = params.messages.find((m) => m.role === 'system')?.content ?? undefined
				yield { id: 'r', delta: { content: 'ok' } } as StreamChunk
				yield {
					id: 'r',
					delta: {},
					finishReason: 'stop',
					usage: {
						promptTokens: 0,
						completionTokens: 0,
						totalTokens: 0,
						cachedTokens: 0,
						cacheWriteTokens: 0,
					},
				} as StreamChunk
			}),
		} as unknown as AdvisorDefinition['provider']
	}

	async function systemPromptFor(advisor: Partial<AdvisorDefinition>): Promise<string> {
		const seen: { system?: string } = {}
		await new AdvisoryExecutor().consult(
			{ id: 'a', name: 'A', model: 'm', provider: capturingProvider(seen), ...advisor },
			{ question: 'q' },
			{ messages: [], iteration: 1 },
		)
		return seen.system ?? ''
	}

	it('appends the contract to the default prompt', async () => {
		expect(await systemPromptFor({})).toContain(ADVISORY_RESPONSE_CONTRACT)
	})

	// The failure that hides: a host writes its own prompt, the advisor is
	// never told the convention, and its warnings are silently unparseable.
	it('appends it to a host-written prompt too, without discarding that prompt', async () => {
		const prompt = await systemPromptFor({ systemPrompt: 'You are terse.' })

		expect(prompt).toContain('You are terse.')
		expect(prompt).toContain(ADVISORY_RESPONSE_CONTRACT)
	})

	it('appends it to a persona-assembled prompt too', async () => {
		const prompt = await systemPromptFor({
			persona: {
				identity: { role: 'reviewer', description: 'Reviews plans.' },
			} as AdvisorDefinition['persona'],
		})

		expect(prompt).toContain(ADVISORY_RESPONSE_CONTRACT)
	})
})
