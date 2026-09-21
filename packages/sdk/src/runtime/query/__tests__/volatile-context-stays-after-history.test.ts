import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import { PromptContributionRegistry } from '../../../prompt/contributions.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { Message } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { WORKING_MEMORY_HEADER } from '../iteration/phases/working-memory.js'

/**
 * Kernel observations that change from request to request ride the
 * request-only context channel, never the system run.
 *
 * A driver may hoist every system message ahead of the conversation —
 * Anthropic renders tools, then system, then messages — so a system message
 * whose text changes invalidates the cached conversation prefix, and the
 * whole history is re-read at full price. The working-memory slot changes
 * whenever a pin does; a `context` contribution changes whenever the host's
 * observation does. Both must reach the request after the history, as
 * runtime-context messages of kind `step-context`, which every driver keeps
 * there and a caching driver ends its breakpoint before.
 */

registerMock()

function isRequestOnly(message: Message): boolean {
	return (
		message.role === 'user' &&
		message.source?.type === 'runtime-context' &&
		message.source.kind === 'step-context'
	)
}

const text = (message: Message): string =>
	typeof message.content === 'string' ? message.content : ''

/** Every step-context message opens with this line; the slot follows it. */
const LABEL = 'Current step context (runtime-generated; not a new user request):\n'
const isSlot = (t: string): boolean => t.startsWith(`${LABEL}${WORKING_MEMORY_HEADER}`)

/**
 * The request-only context after the history: the trailing run of
 * `step-context` messages, looking past the trailing system guidance a step
 * may add between the history and them.
 */
function trailingContext(messages: readonly Message[]): Message[] {
	let end = messages.length
	while (end > 0) {
		const message = messages[end - 1]
		if (!message || !(isRequestOnly(message) || message.role === 'system')) break
		end--
	}
	return messages.slice(end).filter(isRequestOnly)
}

function setup() {
	const tools = new ToolRegistry()
	let n = 0
	tools.register({
		name: 'note',
		description: 'Pin a fact',
		inputSchema: z.object({ text: z.string() }),
		execute: async ({ text }) => ({
			success: true,
			output: 'noted',
			workingState: [{ key: `k${++n}`, text }],
		}),
	})
	return {
		tools,
		agentId: 'a',
		agentName: 'A',
		systemPrompt: 'You are a coding agent.',
		workingDirectory: process.cwd(),
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
		compactionConfig: CompactionConfigSchema.parse({}),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	}
}

describe('the working-memory slot in a request', () => {
	it('is request-only context after the history, not a system message', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'note', args: { text: 'FIRST_FACT' } }] },
				{ toolCalls: [{ id: 'c2', name: 'note', args: { text: 'SECOND_FACT' } }] },
				{ text: 'done' },
			],
		})
		const events: RunEvent[] = []
		const result = await drainQuery(
			{ ...setup(), provider, messages: [{ role: 'user', content: 'pin things' }] },
			(event) => {
				events.push(event)
			},
		)

		for (const request of provider.requests.slice(1)) {
			const messages = request.messages as Message[]
			const system = messages.filter((m) => m.role === 'system').map(text)
			expect(system.join('\n')).not.toContain(WORKING_MEMORY_HEADER)
			// Labelled like every other step-context message, so the model
			// does not read the slot as something the operator just said.
			const slot = trailingContext(messages).filter((m) => isSlot(text(m)))
			expect(slot).toHaveLength(1)
		}
		const second = provider.requests[2]?.messages as Message[]
		expect(trailingContext(second).map(text).join('\n')).toContain('SECOND_FACT')

		// Two requests whose pins differ share the whole system run: the
		// change lives only in the request-only tail.
		const systemOf = (i: number) =>
			(provider.requests[i]?.messages as Message[]).filter((m) => m.role === 'system').map(text)
		expect(systemOf(2)).toEqual(systemOf(1))

		// The envelope reports what the model is asked as system text, so the
		// slot is no longer part of it.
		for (const event of events) {
			if (event.type === 'request_envelope') {
				expect(event.systemPrompt).not.toContain(WORKING_MEMORY_HEADER)
			}
		}

		// The run's own history still keeps the slot where compaction
		// preserves it: in the leading system run.
		const history = (result as { messages?: Message[] }).messages ?? []
		const lead: Message[] = []
		for (const message of history) {
			if (message.role !== 'system') break
			lead.push(message)
		}
		expect(lead.map(text).some((t) => t.startsWith(WORKING_MEMORY_HEADER))).toBe(true)
		expect(history.some(isRequestOnly)).toBe(false)
	})
})

describe('a context contribution', () => {
	it('renders per iteration into request-only context after the history', async () => {
		const contributions = new PromptContributionRegistry()
		contributions.register({
			id: 'observation',
			placement: 'context',
			render: ({ iteration }) => `OBSERVED AT ${iteration}`,
		})
		contributions.register({
			id: 'rare',
			placement: 'context',
			render: ({ iteration }) => (iteration === 2 ? 'ONLY ON TWO' : null),
		})
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'note', args: { text: 'FACT' } }] },
				{ toolCalls: [{ id: 'c2', name: 'note', args: { text: 'FACT TWO' } }] },
				{ text: 'done' },
			],
		})
		const result = await drainQuery({
			...setup(),
			provider,
			promptContributions: contributions,
			messages: [{ role: 'user', content: 'go' }],
		})

		expect(provider.requests).toHaveLength(3)
		for (const [i, request] of provider.requests.entries()) {
			const messages = request.messages as Message[]
			const system = messages
				.filter((m) => m.role === 'system')
				.map(text)
				.join('\n')
			expect(system).not.toContain('OBSERVED AT')
			const tail = trailingContext(messages).map(text).join('\n')
			expect(tail).toContain(`OBSERVED AT ${i + 1}`)
			expect(tail.includes('ONLY ON TWO')).toBe(i === 1)
			// Once per request, never twice.
			expect(messages.map(text).join('\n').split('OBSERVED AT').length - 1).toBe(1)
		}

		// Request-only: never pushed onto the run's history.
		const history = (result as { messages?: Message[] }).messages ?? []
		expect(history.map(text).join('\n')).not.toContain('OBSERVED AT')
	})

	it('comes after the working-memory slot and leaves turn contributions in the system run', async () => {
		const contributions = new PromptContributionRegistry()
		contributions.register({ id: 'obs', placement: 'context', render: () => 'CONTEXT TEXT' })
		contributions.register({ id: 'turnly', placement: 'turn', render: () => 'TURN TEXT' })
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'note', args: { text: 'FACT' } }] },
				{ text: 'done' },
			],
		})
		await drainQuery({
			...setup(),
			provider,
			promptContributions: contributions,
			messages: [{ role: 'user', content: 'go' }],
		})

		const messages = provider.requests[1]?.messages as Message[]
		const tail = trailingContext(messages).map(text)
		const slotAt = tail.findIndex(isSlot)
		const contextAt = tail.findIndex((t) => t.includes('CONTEXT TEXT'))
		expect(slotAt).toBeGreaterThanOrEqual(0)
		expect(contextAt).toBeGreaterThan(slotAt)
		// `turn` keeps its documented system authority.
		expect(
			messages
				.filter((m) => m.role === 'system')
				.map(text)
				.join('\n'),
		).toContain('TURN TEXT')
	})
})
