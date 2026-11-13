import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MAX_LAST_MESSAGE_HOOK_CHARS } from '../../../plugin/hook-context.js'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { PluginHookContext, PluginHookEvent } from '../../../types/plugin/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

registerMock()

/**
 * `turn_end` and `subagent_stop` carry the text of the model's last message,
 * on both ways a turn ends: the model finishing with nothing to run (the
 * loop asks), and every other way (the finalizer asks).
 */

type Seen = { event: PluginHookEvent; lastAssistantMessage?: string; hasKey: boolean }

function recorder(seen: Seen[], answers: (nth: number) => 'skip' | 'continue' = () => 'continue') {
	let nth = 0
	return {
		executeHooks: async (event: PluginHookEvent, ctx: Partial<PluginHookContext>) => {
			if (event !== 'turn_end' && event !== 'subagent_stop') return []
			nth++
			seen.push({
				event,
				hasKey: 'lastAssistantMessage' in ctx,
				...(ctx.lastAssistantMessage !== undefined
					? { lastAssistantMessage: ctx.lastAssistantMessage }
					: {}),
			})
			return answers(nth) === 'skip'
				? [{ action: 'skip' as const, reason: 'again' }]
				: [{ action: 'continue' as const }]
		},
	} as unknown as PluginLifecycleManager
}

async function run(opts: {
	turns: MockTurn[]
	pluginManager: PluginLifecycleManager
	maxIterations?: number
	child?: boolean
}) {
	const provider = new MockLLMProvider({ turns: opts.turns })
	const tools = testToolset({
		name: 'probe',
		description: 'probe',
		inputSchema: z.object({}),
		execute: () => Promise.resolve({ success: true, output: 'ok' }),
	})
	return await drainQuery({
		provider,
		toolsets: [tools],
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory: process.cwd(),
		turnConfig: {
			model: 'mock-model',
			tokenBudget: 10_000_000,
			timeoutMs: 60_000,
			maxIterations: opts.maxIterations ?? 10,
			maxResponseTokens: 512,
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		pluginManager: opts.pluginManager,
		...(opts.child ? { parentSessionId: generateSessionId(), agentType: 'worker' } : {}),
	} as Parameters<typeof drainQuery>[0])
}

describe('the last message on turn_end', () => {
	it('is the model’s text when it finishes (the loop asks)', async () => {
		const seen: Seen[] = []
		await run({ turns: [{ text: 'All done, tests pass.' }], pluginManager: recorder(seen) })
		expect(seen).toEqual([
			{ event: 'turn_end', hasKey: true, lastAssistantMessage: 'All done, tests pass.' },
		])
	})

	it('is the newest reply each time a refusal keeps the turn going', async () => {
		const seen: Seen[] = []
		await run({
			turns: [{ text: 'first draft' }, { text: 'second draft' }],
			pluginManager: recorder(seen, (nth) => (nth === 1 ? 'skip' : 'continue')),
		})
		expect(seen.map((s) => s.lastAssistantMessage)).toEqual(['first draft', 'second draft'])
	})

	it('is the text of the last message when another way ends the turn (the finalizer asks)', async () => {
		const seen: Seen[] = []
		// Every ask is refused, so the turn runs out of iterations and ends in the finalizer.
		const turn = await run({
			turns: Array.from({ length: 5 }, (_, i) => ({ text: `say ${i}` })),
			maxIterations: 3,
			pluginManager: recorder(seen, () => 'skip'),
		})
		expect(turn.stopReason).toBe('max_iterations')
		const last = seen.at(-1)
		expect(last?.event).toBe('turn_end')
		expect(last?.lastAssistantMessage).toBe('say 2')
	})

	it('is absent when the turn ended on a tool call with no text', async () => {
		const seen: Seen[] = []
		const turn = await run({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'probe', args: {} }] },
				{ toolCalls: [{ id: 'c2', name: 'probe', args: {} }] },
			],
			maxIterations: 2,
			pluginManager: recorder(seen),
		})
		expect(turn.stopReason).toBe('max_iterations')
		expect(seen).toHaveLength(1)
		expect(seen[0]?.hasKey).toBe(false)
	})

	it('is cut to the limit, with a mark', async () => {
		const seen: Seen[] = []
		await run({
			turns: [{ text: 'x'.repeat(MAX_LAST_MESSAGE_HOOK_CHARS + 500) }],
			pluginManager: recorder(seen),
		})
		const text = seen[0]?.lastAssistantMessage ?? ''
		expect(text.length).toBe(MAX_LAST_MESSAGE_HOOK_CHARS + '\n[truncated]'.length)
		expect(text.endsWith('\n[truncated]')).toBe(true)
	})

	it('reaches subagent_stop for a child on both ways', async () => {
		const seen: Seen[] = []
		await run({ turns: [{ text: 'child done' }], pluginManager: recorder(seen), child: true })
		expect(seen.map((s) => [s.event, s.lastAssistantMessage])).toEqual([
			['turn_end', 'child done'],
			['subagent_stop', 'child done'],
		])
		const finalizer: Seen[] = []
		await run({
			turns: Array.from({ length: 4 }, (_, i) => ({ text: `c${i}` })),
			maxIterations: 2,
			pluginManager: recorder(finalizer, () => 'skip'),
			child: true,
		})
		expect(finalizer.at(-1)).toMatchObject({ event: 'subagent_stop', lastAssistantMessage: 'c1' })
	})
})
