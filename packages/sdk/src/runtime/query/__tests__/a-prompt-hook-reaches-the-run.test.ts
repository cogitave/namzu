import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type {
	PluginHookContext,
	PluginHookEvent,
	PluginHookResult,
} from '../../../types/plugin/index.js'
import type { RunEvent } from '../../../types/run/events.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * The events other coding agents' operators script against, fired by the
 * kernel so every host has them: the prompt before the model sees it, a
 * compaction pass, a delegated run ending.
 */

registerMock()

type Seen = { event: PluginHookEvent; ctx: Omit<PluginHookContext, 'pluginId' | 'event'> }

function manager(
	seen: Seen[],
	answer: (event: PluginHookEvent) => PluginHookResult[] = () => [],
): PluginLifecycleManager {
	return {
		executeHooks: async (event: PluginHookEvent, ctx: Seen['ctx']) => {
			seen.push({ event, ctx })
			return answer(event)
		},
	} as unknown as PluginLifecycleManager
}

async function run(
	seen: Seen[],
	options: {
		answer?: (event: PluginHookEvent) => PluginHookResult[]
		parentRunId?: ReturnType<typeof generateRunId>
		contextWindowTokens?: number
		prompt?: string
	} = {},
) {
	const events: RunEvent[] = []
	const sessionId = generateSessionId()
	const result = await drainQuery(
		{
			provider: new MockLLMProvider({
				turns: [
					{ text: 'the answer', usage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 } },
				],
			}),
			tools: new ToolRegistry(),
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: options.prompt ?? 'what is the answer' }],
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
			sessionId,
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			pluginManager: manager(seen, options.answer),
			...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
			...(options.contextWindowTokens
				? {
						compactionConfig: CompactionConfigSchema.parse({
							contextWindowTokens: options.contextWindowTokens,
						}),
					}
				: {}),
		},
		(event) => {
			events.push(event)
		},
	)
	return { result, events, sessionId }
}

const pick = (seen: Seen[], event: PluginHookEvent) => seen.find((s) => s.event === event)?.ctx

describe('the prompt, before the model sees it', () => {
	it('is shown to the hook with the session it came from, before run_start', async () => {
		const seen: Seen[] = []
		const { sessionId } = await run(seen, { prompt: 'deploy the thing' })
		const ctx = pick(seen, 'user_prompt_submit')
		expect(ctx?.prompt).toBe('deploy the thing')
		expect(ctx?.sessionId).toBe(sessionId)
		const order = seen.map((s) => s.event)
		expect(order.indexOf('user_prompt_submit')).toBeLessThan(order.indexOf('run_start'))
	})

	it('carries what the hook added into the system prompt', async () => {
		const seen: Seen[] = []
		const { events } = await run(seen, {
			answer: (event) =>
				event === 'user_prompt_submit' ? [{ action: 'annotate', text: 'branch: feat/x' }] : [],
		})
		const started = events.find((e) => e.type === 'run_started')
		expect(started?.type === 'run_started' ? started.systemPrompt : '').toContain('branch: feat/x')
	})

	it('ends the run, failed and naming the reason, when the hook refuses the prompt', async () => {
		const seen: Seen[] = []
		const { result } = await run(seen, {
			answer: (event) =>
				event === 'user_prompt_submit' ? [{ action: 'skip', reason: 'not on main' }] : [],
		})
		expect(result.status).toBe('failed')
		expect(JSON.stringify(result)).toContain('Prompt blocked by hook: not on main')
		expect(seen.map((s) => s.event)).not.toContain('run_start')
	})
})

describe('a delegated run ending', () => {
	it('fires subagent_stop with the parent, after its own run_end', async () => {
		const seen: Seen[] = []
		const parentRunId = generateRunId()
		await run(seen, { parentRunId })
		const order = seen.map((s) => s.event)
		expect(order.indexOf('subagent_stop')).toBeGreaterThan(order.indexOf('run_end'))
		expect(pick(seen, 'subagent_stop')?.parentRunId).toBe(parentRunId)
	})

	it('is not a root run', async () => {
		const seen: Seen[] = []
		await run(seen)
		expect(seen.map((s) => s.event)).not.toContain('subagent_stop')
	})
})

describe('a compaction pass', () => {
	it('is bracketed by pre_compact and post_compact carrying the numbers', async () => {
		const seen: Seen[] = []
		await run(seen, {
			contextWindowTokens: 120,
			prompt: 'a prompt long enough to cross a tiny window '.repeat(20),
		})
		const pre = pick(seen, 'pre_compact')?.compaction
		const post = pick(seen, 'post_compact')?.compaction
		expect(pre?.reason).toBe('threshold')
		expect(pre?.tokensBefore).toBeGreaterThan(0)
		expect(pre?.contextWindowTokens).toBe(120)
		expect(post?.tokensAfter).toBeGreaterThan(0)
		const order = seen.map((s) => s.event)
		expect(order.indexOf('pre_compact')).toBeLessThan(order.indexOf('post_compact'))
	})

	it('does not fire when the context fits', async () => {
		const seen: Seen[] = []
		await run(seen)
		expect(seen.map((s) => s.event)).not.toContain('pre_compact')
	})
})
