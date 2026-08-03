import { describe, expect, it } from 'vitest'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { Citation } from '../../../types/message/index.js'
import type { ChatCompletionParams } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateThreadId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Sending a document buys the provider's native handling of it — page
 * structure, OCR, and the ability to say WHICH passage an answer rests
 * on. namzu could send the document and could not receive the third, so
 * an answer about a contract arrived as prose and checking it meant
 * reading the contract again by hand.
 */

registerMock()

const PDF = {
	type: 'document' as const,
	data: 'JVBERi0xLjQK',
	mediaType: 'application/pdf',
	name: 'contract.pdf',
	citations: true,
}

const CITED: Citation = {
	citedText: 'Either party may terminate on thirty days notice.',
	documentIndex: 0,
	documentTitle: 'contract.pdf',
	location: { kind: 'page', start: 4, end: 4 },
}

function run(opts: { citations?: Citation[] } = {}) {
	const provider = new MockLLMProvider({
		turns: [
			{
				text: 'Either side can walk away with a month of warning.',
				...(opts.citations ? { citations: opts.citations } : {}),
			},
		],
	})

	const settled = drainQuery({
		provider,
		tools: new ToolRegistry(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'can we terminate early?', attachments: [PDF] }],
		workingDirectory: process.cwd(),
		runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 2 },
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		threadId: generateThreadId(),
		tenantId: generateTenantId(),
	} as never)

	return { settled, requests: provider.requests as ChatCompletionParams[] }
}

const assistantOf = (messages: readonly { role: string }[]) =>
	messages.find((m) => m.role === 'assistant') as { citations?: readonly Citation[] } | undefined

describe('a passage the model cited', () => {
	it('lands on the assistant turn, not in its text', async () => {
		const { settled } = run({ citations: [CITED] })
		const settledRun = await settled

		// The text is what a human reads; the citation is what a checker
		// follows. Splicing markers into the prose would trade one for the
		// other.
		expect(settledRun.result).not.toContain('page 4')
		expect(assistantOf(settledRun.messages)?.citations).toEqual([CITED])
	})

	it('is absent, not empty, when the model cited nothing', async () => {
		const { settled } = run()

		expect(assistantOf((await settled).messages)?.citations).toBeUndefined()
	})

	it('keeps every citation the model made, in order', async () => {
		const second: Citation = {
			citedText: 'Notice must be in writing.',
			documentIndex: 0,
			location: { kind: 'page', start: 5, end: 5 },
		}
		const { settled } = run({ citations: [CITED, second] })

		// Evidence, so it is collected verbatim: reordering or de-duplicating
		// would edit the record the reader checks against.
		expect(assistantOf((await settled).messages)?.citations).toEqual([CITED, second])
	})

	it('carries the request opt-in through to the driver', async () => {
		const { settled, requests } = run()
		await settled

		const sent = requests[0]?.messages.find((m) => m.role === 'user') as {
			attachments?: { citations?: boolean }[]
		}
		// A driver cannot ask for citations the request never enabled.
		expect(sent?.attachments?.[0]?.citations).toBe(true)
	})
})
