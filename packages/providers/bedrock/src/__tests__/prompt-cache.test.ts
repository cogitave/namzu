import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { BedrockProvider } from '../client.js'

/**
 * The driver read the cache hit/write counters off the response and never
 * asked for caching, so both were permanently zero — every turn re-sent
 * and re-paid for the entire static prefix.
 *
 * A breakpoint on this wire is a content BLOCK inserted into the request,
 * so the only honest assertion is on the request the driver actually
 * builds. Everything here drives the real `chatStream` against a fake
 * transport and inspects what went out.
 */

interface SentInput {
	system?: Record<string, unknown>[]
	messages?: { role: string; content: Record<string, unknown>[] }[]
	toolConfig?: { tools?: Record<string, unknown>[] }
}

function harness() {
	const sent: SentInput[] = []
	const provider = new BedrockProvider({ region: 'us-east-1' })
	// The client dials on construction and there is no injection seam; the
	// field is swapped so the real request-assembly path still runs.
	;(provider as unknown as { client: { send: unknown } }).client = {
		async send(command: { input: SentInput }) {
			sent.push(command.input)
			return {
				$metadata: { requestId: 'req-1' },
				stream: (async function* () {
					yield { messageStop: { stopReason: 'end_turn' } }
				})(),
			}
		},
	}
	return { provider, sent }
}

async function drain(provider: BedrockProvider, params: Partial<ChatCompletionParams>) {
	for await (const _ of provider.chatStream({
		model: 'test-model',
		messages: [{ role: 'user', content: 'hi' }],
		...params,
	} as ChatCompletionParams)) {
		// drain
	}
}

const TOOLS: ChatCompletionParams['tools'] = [
	{
		type: 'function',
		function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
	},
]

const CONVERSATION: ChatCompletionParams['messages'] = [
	{ role: 'system', content: 'static instructions', cacheHint: 'cache' },
	{ role: 'system', content: 'changes every run', cacheHint: 'ephemeral' },
	{ role: 'user', content: 'do the thing' },
]

const isCachePoint = (b: Record<string, unknown>) => b.cachePoint !== undefined

describe('asking for the cache', () => {
	it('places no breakpoint at all when the caller did not ask', async () => {
		const { provider, sent } = harness()
		await drain(provider, { messages: CONVERSATION, tools: TOOLS })

		const serialized = JSON.stringify(sent[0])
		expect(serialized).not.toContain('cachePoint')
	})

	it('breaks after the tool schemas, which render first and are worth the most', async () => {
		const { provider, sent } = harness()
		await drain(provider, {
			messages: CONVERSATION,
			tools: TOOLS,
			cacheControl: { type: 'ephemeral' },
		})

		const tools = sent[0]?.toolConfig?.tools ?? []
		expect(tools.filter(isCachePoint)).toHaveLength(1)
		// After the schemas, not before: everything ahead of the breakpoint
		// is what gets cached.
		expect(isCachePoint(tools[tools.length - 1] as Record<string, unknown>)).toBe(true)
	})

	it('breaks after the static system text, not after the dynamic tail', async () => {
		const { provider, sent } = harness()
		await drain(provider, {
			messages: CONVERSATION,
			tools: TOOLS,
			cacheControl: { type: 'ephemeral' },
		})

		const system = sent[0]?.system ?? []
		const at = system.findIndex(isCachePoint)
		expect(at).toBe(1)
		expect((system[0] as { text?: string }).text).toBe('static instructions')
		// Caching the per-run text would invalidate the entry every turn and
		// bill a cache WRITE each time for nothing.
		expect((system[2] as { text?: string }).text).toBe('changes every run')
	})

	it('breaks at the end of the conversation so the next turn reads the history cached', async () => {
		const { provider, sent } = harness()
		await drain(provider, {
			messages: CONVERSATION,
			tools: TOOLS,
			cacheControl: { type: 'ephemeral' },
		})

		const messages = sent[0]?.messages ?? []
		const last = messages[messages.length - 1]
		expect(isCachePoint(last?.content[last.content.length - 1] as Record<string, unknown>)).toBe(
			true,
		)
	})

	it('leaves the system blocks alone when none of them is static', async () => {
		const { provider, sent } = harness()
		await drain(provider, {
			messages: [
				{ role: 'system', content: 'all dynamic', cacheHint: 'ephemeral' },
				{ role: 'user', content: 'go' },
			],
			cacheControl: { type: 'ephemeral' },
		})

		// Nothing here is worth caching, and a breakpoint over changing text
		// costs a write every turn and never reads back.
		expect((sent[0]?.system ?? []).filter(isCachePoint)).toHaveLength(0)
	})

	it('drops an empty system message rather than sending a blank block', async () => {
		const { provider, sent } = harness()
		await drain(provider, {
			messages: [
				{ role: 'system', content: '' },
				{ role: 'system', content: 'real', cacheHint: 'cache' },
				{ role: 'user', content: 'go' },
			],
			cacheControl: { type: 'ephemeral' },
		})

		const system = sent[0]?.system ?? []
		expect(system.filter((b) => !isCachePoint(b))).toHaveLength(1)
		expect(system.findIndex(isCachePoint)).toBe(1)
	})

	it('never puts a breakpoint on a message with no content', async () => {
		const { provider, sent } = harness()
		await drain(provider, {
			messages: [{ role: 'user', content: 'go' }],
			cacheControl: { type: 'ephemeral' },
		})

		for (const message of sent[0]?.messages ?? []) {
			expect(message.content.length).toBeGreaterThan(0)
		}
	})

	it('uses at most three breakpoints, the number the wire allows', async () => {
		const { provider, sent } = harness()
		await drain(provider, {
			messages: CONVERSATION,
			tools: TOOLS,
			cacheControl: { type: 'ephemeral' },
		})

		const total = JSON.stringify(sent[0]).split('"cachePoint"').length - 1
		expect(total).toBeLessThanOrEqual(4)
		expect(total).toBe(3)
	})
})
