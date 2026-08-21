import { describe, expect, it } from 'vitest'

import { z } from 'zod'

import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { PluginHookContext, PluginHookEvent } from '../../../types/plugin/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Both model-call hooks fired directly beside the request and the reply and
 * were handed neither — only a run id and an iteration number. An extension
 * could observe THAT a call happened and nothing about what it was, so a
 * prompt audit, a redaction pass, or a per-tenant token ledger had no way to
 * do its job from a hook.
 */

registerMock()

type Seen = { event: PluginHookEvent; ctx: Omit<PluginHookContext, 'pluginId' | 'event'> }

function recordingManager(seen: Seen[]): PluginLifecycleManager {
	return {
		executeHooks: async (event: PluginHookEvent, ctx: Seen['ctx']) => {
			seen.push({ event, ctx })
			return []
		},
	} as unknown as PluginLifecycleManager
}

async function runWithHooks(seen: Seen[], toolNames: readonly string[] = []) {
	const tools = new ToolRegistry()
	for (const name of toolNames) {
		tools.register({
			name,
			description: `${name} tool`,
			inputSchema: z.object({}),
			execute: () => Promise.resolve({ success: true, output: 'ok' }),
		})
	}

	return drainQuery({
		provider: new MockLLMProvider({
			turns: [
				{ text: 'the answer', usage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 } },
			],
		}),
		tools,
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'what is the answer' }],
		workingDirectory: process.cwd(),
		runConfig: {
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 30_000,
			maxIterations: 2,
			temperature: 0.25,
			maxResponseTokens: 512,
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		pluginManager: recordingManager(seen),
	})
}

const pick = (seen: Seen[], event: PluginHookEvent) => seen.find((s) => s.event === event)?.ctx

describe('what an extension is shown about a model call', () => {
	it('shows the request the run is about to send', async () => {
		const seen: Seen[] = []
		await runWithHooks(seen)

		const request = pick(seen, 'pre_llm_call')?.request
		expect(request?.model).toBe('mock-model')
		expect(request?.messages.map((m) => m.content)).toContain('what is the answer')
		expect(request?.temperature).toBe(0.25)
		expect(request?.maxTokens).toBe(512)
	})

	it('names the tools the model is being offered', async () => {
		// The set, not the schemas: an audit asks which capabilities were
		// exposed on this turn, and the schemas are the driver's business.
		const seen: Seen[] = []
		await runWithHooks(seen, ['read_file', 'write_file'])

		expect([...(pick(seen, 'pre_llm_call')?.request?.toolNames ?? [])].sort()).toEqual([
			'read_file',
			'write_file',
		])
	})

	it('shows the reply and what it cost', async () => {
		const seen: Seen[] = []
		await runWithHooks(seen)

		const response = pick(seen, 'post_llm_call')?.response
		expect(response?.content).toBe('the answer')
		expect(response?.finishReason).toBe('stop')
		// A per-tenant token ledger is the whole point of carrying usage.
		expect(response?.usage).toMatchObject({ promptTokens: 11, completionTokens: 4 })
	})

	it('threads one run-owned cancellation signal through every lifecycle hook', async () => {
		const seen: Seen[] = []
		const tools = new ToolRegistry()
		tools.register({
			name: 'lookup',
			description: 'look something up',
			inputSchema: z.object({}),
			execute: () => Promise.resolve({ success: true, output: 'found it' }),
		})
		await drainQuery({
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ name: 'lookup', args: {} }] }, { text: 'done' }],
			}),
			tools,
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'look it up' }],
			workingDirectory: process.cwd(),
			runConfig: {
				model: 'mock-model',
				tokenBudget: 100_000,
				timeoutMs: 30_000,
				maxIterations: 3,
				maxResponseTokens: 512,
			},
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			pluginManager: recordingManager(seen),
		})

		const expected = [
			'run_start',
			'iteration_start',
			'pre_llm_call',
			'post_llm_call',
			'pre_tool_use',
			'post_tool_use',
			'iteration_end',
			'run_end',
		] satisfies PluginHookEvent[]
		const firstSignal = seen[0]?.ctx.signal
		expect(firstSignal).toBeInstanceOf(AbortSignal)
		for (const event of expected) {
			const contexts = seen.filter((entry) => entry.event === event).map((entry) => entry.ctx)
			expect(contexts.length, `${event} was not reached`).toBeGreaterThan(0)
			for (const context of contexts) expect(context.signal, event).toBe(firstSignal)
		}
	})

	it('refuses a hook that writes into the request', async () => {
		// One hook shaping the request for the next would make the outcome
		// depend on registration order, and the last one registered would
		// silently win. Shaping stays with the single-slot host callback.
		const seen: Seen[] = []
		await runWithHooks(seen)

		const request = pick(seen, 'pre_llm_call')?.request
		// Asserted present first: a missing projection would also make the
		// write below throw, and the test would pass for the wrong reason.
		expect(request).toBeDefined()
		expect(Object.isFrozen(request)).toBe(true)
		expect(() => {
			;(request as unknown as { model: string }).model = 'something-else'
		}).toThrow()
		expect(request?.model).toBe('mock-model')
	})

	it('hands over copies, so a write cannot reach the run history', async () => {
		const seen: Seen[] = []
		const run = await runWithHooks(seen)

		const shown = pick(seen, 'pre_llm_call')?.request?.messages ?? []
		const ask = shown.find((m) => m.content === 'what is the answer')
		expect(ask).toBeDefined()
		expect(() => {
			;(ask as unknown as { content: string }).content = 'tampered'
		}).toThrow()
		expect(run.messages.some((m) => m.content === 'what is the answer')).toBe(true)
	})
})
