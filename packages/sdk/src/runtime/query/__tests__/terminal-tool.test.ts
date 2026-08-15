import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { MockTurn } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Every delegation path is blocking and returns the worker's final text as
 * the dispatching call's result — after which the loop went round again,
 * costing one more model call at the parent's FULL context size whose only
 * job was to restate what the worker already said. The relay is also
 * lossy: the parent paraphrases through its own compacted view, so what
 * the caller receives is not what the worker produced.
 */

registerMock()

const WORKER_ANSWER = 'the specialist says: ship it on Tuesday'

function tool(name: string, terminal: boolean) {
	return defineTool({
		name,
		description: `${name} tool`,
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		terminal,
		execute: async () => ({ success: true, output: WORKER_ANSWER }),
	})
}

const call = (id: string, name: string) => ({ id, name, args: {} })

async function run(opts: {
	terminal: boolean
	turns: MockTurn[]
	failing?: boolean
	extraTool?: boolean
}) {
	const tools = new ToolRegistry()
	tools.register(
		opts.failing
			? defineTool({
					name: 'delegate',
					description: 'delegate tool',
					inputSchema: z.object({}),
					category: 'custom',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: true,
					terminal: opts.terminal,
					execute: async () => ({ success: false, output: '', error: 'the worker died' }),
				})
			: tool('delegate', opts.terminal),
	)
	if (opts.extraTool) tools.register(tool('take_note', false))

	const provider = new MockLLMProvider({ turns: opts.turns })
	const result = await drainQuery({
		provider,
		tools,
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'route this' }],
		workingDirectory: process.cwd(),
		runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 6 },
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	})

	return { result, turns: provider.requests.length }
}

const delegateThenSummarize: MockTurn[] = [
	{ toolCalls: [call('c1', 'delegate')], finishReason: 'tool_calls' },
	{ text: 'the specialist suggested something about Tuesday' },
]

describe('a tool whose output is the answer', () => {
	it('costs a relay turn when not declared terminal', async () => {
		// The premise. Two model calls: one to delegate, one whose entire
		// job is to restate what came back.
		const { result, turns } = await run({ terminal: false, turns: delegateThenSummarize })

		expect(turns).toBe(2)
		expect(result.result).not.toBe(WORKER_ANSWER)
	})

	it('settles the run with the tool output when declared terminal', async () => {
		const { result, turns } = await run({ terminal: true, turns: delegateThenSummarize })

		// One model call, and the caller receives the worker's words rather
		// than the parent's paraphrase of them.
		expect(turns).toBe(1)
		expect(result.result).toBe(WORKER_ANSWER)
		expect(result.stopReason).toBe('end_turn')
	})

	it('keeps looping when the terminal call shared its turn', async () => {
		// The model asked for other work in the same turn and meant to see
		// those results; ending the run would discard answers it requested.
		const { result, turns } = await run({
			terminal: true,
			extraTool: true,
			turns: [
				{
					toolCalls: [call('c1', 'delegate'), call('c2', 'take_note')],
					finishReason: 'tool_calls',
				},
				{ text: 'both came back' },
			],
		})

		expect(turns).toBe(2)
		expect(result.result).toBe('both came back')
	})

	it('returns a failed terminal call to the model instead of settling on it', async () => {
		// An error is not an answer, and the model is the one that should
		// read it.
		const { result, turns } = await run({
			terminal: true,
			failing: true,
			turns: [
				{ toolCalls: [call('c1', 'delegate')], finishReason: 'tool_calls' },
				{ text: 'the delegate failed, here is what I can do instead' },
			],
		})

		expect(turns).toBe(2)
		expect(result.result).toBe('the delegate failed, here is what I can do instead')
	})
})
