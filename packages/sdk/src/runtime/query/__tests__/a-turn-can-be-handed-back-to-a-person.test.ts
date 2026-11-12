import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { HAND_BACK_SIBLING_REFUSAL, HAND_BACK_TOOL_NAME } from '../../../tools/hand-back/index.js'
import type { ToolResult } from '../../../types/tool/index.js'
import { type QueryParams, drainQuery } from '../index.js'
import { memorySession } from './support/session.js'

const HAND_BACK = {
	kind: 'missing',
	blocker: 'the API key is not in this environment',
	tried: 'looked in the config and the environment',
	needed: 'provide a key or say which service to use',
}

function build(handBack: boolean, turns: ConstructorParameters<typeof MockLLMProvider>[0]) {
	const writes = vi.fn(async (): Promise<ToolResult> => ({ success: true, output: 'written' }))
	const provider = new MockLLMProvider(turns)
	const params = {
		provider,
		toolsets: [
			testToolset({
				name: 'write_note',
				description: 'Write a note',
				inputSchema: z.object({}),
				execute: writes,
			}),
		],
		agentId: 'agent_hand_back',
		agentName: 'Hand back agent',
		workingDirectory: process.cwd(),
		retry: false,
		...memorySession(),
		messages: [{ role: 'user', content: 'do the thing' }],
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 6,
			maxResponseTokens: 256,
			permissionMode: 'auto',
			...(handBack ? { handBack: true } : {}),
		},
	} as unknown as QueryParams
	return { params, provider, writes }
}

const toolNames = (provider: MockLLMProvider): string[] =>
	(provider.requests[0]?.tools ?? []).map((t) => t.function.name)

describe('handing a task back to a person', () => {
	it('ends the turn at the call: one model call, the fact on the turn, no answer needed', async () => {
		const { params, provider } = build(true, {
			turns: [
				{ toolCalls: [{ id: 'c1', name: HAND_BACK_TOOL_NAME, args: HAND_BACK }] },
				{ text: 'never' },
			],
		})
		const turn = await drainQuery(params, () => {})
		expect(provider.requests).toHaveLength(1)
		expect(turn.handedBack).toEqual(HAND_BACK)
		expect(turn.stopReason).toBe('end_turn')
		expect(turn.status).toBe('completed')
	})

	it('runs nothing else in the step that handed the task back', async () => {
		const { params, provider, writes } = build(true, {
			turns: [
				{
					toolCalls: [
						{ id: 'c1', name: 'write_note', args: {} },
						{ id: 'c2', name: HAND_BACK_TOOL_NAME, args: HAND_BACK },
						{ id: 'c3', name: 'write_note', args: {} },
					],
				},
				{ text: 'never' },
			],
		})
		const turn = await drainQuery(params, () => {})
		expect(writes).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(1)
		expect(turn.handedBack?.kind).toBe('missing')
		const refused = turn.messages.filter(
			(m) => m.role === 'tool' && String(m.content).includes(HAND_BACK_SIBLING_REFUSAL),
		)
		expect(refused).toHaveLength(2)
	})

	it('keeps what the turn changed beside the hand-back, not inside it', async () => {
		const { params, writes } = build(true, {
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'write_note', args: {} }] },
				{ toolCalls: [{ id: 'c2', name: HAND_BACK_TOOL_NAME, args: HAND_BACK }] },
			],
		})
		const turn = await drainQuery(params, () => {})
		expect(writes).toHaveBeenCalledTimes(1)
		expect(turn.handedBack).toBeDefined()
		expect(turn.outcome).toBeDefined()
		expect(Object.keys(turn.outcome ?? {})).not.toContain('handedBack')
	})

	it('offers neither the tool nor the guidance with the setting off', async () => {
		const off = build(false, { turns: [{ text: 'done' }] })
		await drainQuery(off.params, () => {})
		expect(toolNames(off.provider)).not.toContain(HAND_BACK_TOOL_NAME)
		const on = build(true, { turns: [{ text: 'done' }] })
		await drainQuery(on.params, () => {})
		expect(toolNames(on.provider)).toContain(HAND_BACK_TOOL_NAME)
		const system = (p: MockLLMProvider) =>
			JSON.stringify(p.requests[0]?.messages.filter((m) => m.role === 'system'))
		expect(system(off.provider)).not.toContain('Handing a task back')
		expect(system(on.provider)).toContain('Handing a task back')
	})

	it('treats a refused call as no hand-back and lets the model go on', async () => {
		const { params, provider } = build(true, {
			turns: [
				{ toolCalls: [{ id: 'c1', name: HAND_BACK_TOOL_NAME, args: { kind: 'missing' } }] },
				{ text: 'fine, I will finish it' },
			],
		})
		const turn = await drainQuery(params, () => {})
		expect(turn.handedBack).toBeUndefined()
		expect(provider.requests).toHaveLength(2)
	})

	it('runs the sibling calls when the hand-back call itself is invalid', async () => {
		const { params, provider, writes } = build(true, {
			turns: [
				{
					toolCalls: [
						{ id: 'c1', name: HAND_BACK_TOOL_NAME, args: { kind: 'missing' } },
						{ id: 'c2', name: 'write_note', args: {} },
					],
				},
				{ text: 'fine, I will finish it' },
			],
		})
		const turn = await drainQuery(params, () => {})
		expect(writes).toHaveBeenCalledTimes(1)
		expect(provider.requests).toHaveLength(2)
		expect(turn.handedBack).toBeUndefined()
		expect(
			turn.messages.some((m) => m.role === 'tool' && String(m.content).includes('the turn ends')),
		).toBe(false)
	})
})
