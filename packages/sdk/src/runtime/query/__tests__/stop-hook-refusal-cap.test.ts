import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { PluginHookEvent } from '../../../types/plugin/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

registerMock()

type Answer = { action: 'skip'; reason: string } | { action: 'continue' }

/** A stand-in manager: `answer(event, nth)` decides each `turn_end` / `subagent_stop` ask. */
function manager(
	asked: PluginHookEvent[],
	answer: (event: PluginHookEvent, nth: number) => Answer,
): PluginLifecycleManager {
	return {
		executeHooks: async (
			event: PluginHookEvent,
			ctx: { sessionId: string; turnId?: string },
			emit?: (e: unknown) => Promise<void>,
		) => {
			if (event !== 'turn_end' && event !== 'subagent_stop') return []
			asked.push(event)
			const result = answer(event, asked.length)
			await emit?.({
				type: 'plugin_hook_completed',
				sessionId: ctx.sessionId,
				pluginId: 'closing-gate',
				hookEvent: event,
				result,
			})
			return [result]
		},
	} as unknown as PluginLifecycleManager
}

const texts = (n: number): MockTurn[] => Array.from({ length: n }, (_, i) => ({ text: `say ${i}` }))

async function run(opts: {
	turns: MockTurn[]
	pluginManager: PluginLifecycleManager
	maxIterations?: number
	maxHookRefusals?: number
	child?: boolean
}) {
	const provider = new MockLLMProvider({ turns: opts.turns })
	const tools = testToolset({
		name: 'probe',
		description: 'probe',
		inputSchema: z.object({}),
		execute: () => Promise.resolve({ success: true, output: 'ok' }),
	})
	const sessionId = generateSessionId()
	const turn = await drainQuery({
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
			maxIterations: opts.maxIterations ?? 40,
			maxResponseTokens: 512,
			...(opts.maxHookRefusals !== undefined ? { maxHookRefusals: opts.maxHookRefusals } : {}),
		},
		projectId: generateProjectId(),
		sessionId,
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		pluginManager: opts.pluginManager,
		...(opts.child ? { parentSessionId: generateSessionId(), agentType: 'worker' } : {}),
	} as Parameters<typeof drainQuery>[0])
	return { turn, provider }
}

const refuse: Answer = { action: 'skip', reason: 'not yet' }
const accept: Answer = { action: 'continue' }

const notices = (turn: { messages: readonly { content?: unknown; source?: unknown }[] }) =>
	turn.messages.filter(
		(m) =>
			typeof m.content === 'string' &&
			m.content.includes('in a row') &&
			(m.source as { kind?: string } | undefined)?.kind === 'hook-feedback',
	)

describe('a turn-end hook that always refuses', () => {
	it('is honoured 8 times, then the turn ends with one notice naming the hook', async () => {
		const asked: PluginHookEvent[] = []
		const { provider, turn } = await run({
			turns: texts(60),
			pluginManager: manager(asked, () => refuse),
		})
		// First answer + 8 continuations; the 9th refusal is not honoured.
		expect(provider.requests.length).toBe(9)
		expect(asked.length).toBe(9)
		expect(turn.stopReason).toBe('end_turn')
		const found = notices(turn)
		expect(found).toHaveLength(1)
		expect(found[0]?.content).toContain('"closing-gate"')
		expect(found[0]?.content).toContain('8 times in a row')
	})

	it('takes its limit from maxHookRefusals', async () => {
		const { provider, turn } = await run({
			turns: texts(60),
			maxHookRefusals: 3,
			pluginManager: manager([], () => refuse),
		})
		expect(provider.requests.length).toBe(4)
		expect(notices(turn)).toHaveLength(1)
	})

	it('is not capped when the limit is 0', async () => {
		const { provider, turn } = await run({
			turns: texts(60),
			maxHookRefusals: 0,
			maxIterations: 20,
			pluginManager: manager([], () => refuse),
		})
		expect(provider.requests.length).toBe(20)
		expect(turn.stopReason).toBe('max_iterations')
		expect(notices(turn)).toHaveLength(0)
	})
})

describe('a hook that refuses fewer times than the limit', () => {
	it('is unaffected: refuses twice, then accepts, and no notice is recorded', async () => {
		const { provider, turn } = await run({
			turns: texts(10),
			pluginManager: manager([], (_e, nth) => (nth <= 2 ? refuse : accept)),
		})
		expect(provider.requests.length).toBe(3)
		expect(turn.stopReason).toBe('end_turn')
		expect(notices(turn)).toHaveLength(0)
	})

	it('can refuse exactly as many times as the limit and still be honoured', async () => {
		const { provider, turn } = await run({
			turns: texts(10),
			maxHookRefusals: 3,
			pluginManager: manager([], (_e, nth) => (nth <= 3 ? refuse : accept)),
		})
		expect(provider.requests.length).toBe(4)
		expect(notices(turn)).toHaveLength(0)
	})
})

describe('the count of refusals', () => {
	it('starts over after a tool call', async () => {
		const { provider, turn } = await run({
			turns: [
				{ text: 'a' },
				{ text: 'b' },
				{ toolCalls: [{ name: 'probe', args: {} }] },
				{ text: 'c' },
				{ text: 'd' },
				{ text: 'e' },
				{ text: 'unused' },
			],
			maxHookRefusals: 2,
			pluginManager: manager([], () => refuse),
		})
		// Without the reset the cap would land on the 4th request.
		expect(provider.requests.length).toBe(6)
		expect(notices(turn)).toHaveLength(1)
	})
})

describe('a sub-agent stop hook that always refuses', () => {
	it('is capped the same way', async () => {
		const asked: PluginHookEvent[] = []
		const { provider, turn } = await run({
			turns: texts(60),
			maxHookRefusals: 2,
			child: true,
			pluginManager: manager(asked, (event) => (event === 'subagent_stop' ? refuse : accept)),
		})
		expect(provider.requests.length).toBe(3)
		expect(asked.filter((e) => e === 'subagent_stop')).toHaveLength(3)
		expect(turn.stopReason).toBe('end_turn')
		expect(notices(turn)).toHaveLength(1)
	})

	it('counts both events refusing in one round as one refusal', async () => {
		const { provider } = await run({
			turns: texts(60),
			maxHookRefusals: 2,
			child: true,
			pluginManager: manager([], () => refuse),
		})
		expect(provider.requests.length).toBe(3)
	})
})
