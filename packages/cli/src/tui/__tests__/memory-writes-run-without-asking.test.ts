import {
	type MemoryStore,
	ToolManager,
	buildMemoryTools,
	getBuiltinTools,
	toolset,
} from '@namzu/sdk'
import type { HITLDecisionRequest, SessionId, ToolCallSummary, TurnId } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { PLAN_MODE_REFUSAL } from '../../permissions/mode.js'
import { makeResumeHandler, reviewExemptionFor } from '../agent.js'

/**
 * Keeping memory is something the model does as it works, and the store is
 * namzu's own, under its home. Saving or updating a memory runs without a
 * question in `prompt` and `accept-edits`; a write into the workspace still asks.
 */

const sessionId = '02b19846-c793-4e21-9c6e-21962a7d2de5' as SessionId
const turnId = 'f4e0af37-43f7-48fd-82b0-f1b1c68881d3' as TurnId
const manager = new ToolManager({
	toolsets: [toolset('t', [...getBuiltinTools(), ...buildMemoryTools({} as MemoryStore)])],
	messages: () => [],
})

const call = (name: string, input: unknown = {}, isDestructive = false): ToolCallSummary => ({
	id: `call_${name}`,
	name,
	input,
	isDestructive,
})
const review = (...toolCalls: ToolCallSummary[]): HITLDecisionRequest => ({
	sessionId,
	type: 'tool_review',
	turnId,
	checkpointId: '82267e66-99cd-4ee0-8a15-b8108f6fce73' as never,
	toolCalls,
})

function handlerFor(mode: 'prompt' | 'accept-edits' | 'plan' | 'strict') {
	const ask = vi.fn(async () => ({ kind: 'approve' as const }))
	const handler = makeResumeHandler(
		{ all: false },
		ask,
		mode,
		reviewExemptionFor(mode, manager, () => false),
		{},
		undefined,
		undefined,
		{ registry: manager },
	)
	return { handler, ask }
}

describe('memory writes in the terminal', () => {
	for (const mode of ['prompt', 'accept-edits'] as const) {
		describe(mode, () => {
			it('runs save_memory and update_memory without asking', async () => {
				const { handler, ask } = handlerFor(mode)
				for (const name of ['save_memory', 'update_memory']) {
					expect(await handler(review(call(name))), name).toEqual({ action: 'approve_tools' })
				}
				expect(ask).not.toHaveBeenCalled()
			})

			it('still asks about a write into the workspace', async () => {
				const { handler, ask } = handlerFor(mode)
				await handler(review(call('write', { path: '/work/a.ts', content: 'x' })))
				// accept-edits approves an edit inside the roots by its own rule; a
				// shell command is the question that stays in both modes.
				await handler(review(call('bash', { command: 'make' })))
				expect(ask).toHaveBeenCalled()
			})

			it('asks when a memory write rides in the same batch as a shell command', async () => {
				const { handler, ask } = handlerFor(mode)
				await handler(review(call('save_memory'), call('bash', { command: 'make' })))
				expect(ask).toHaveBeenCalledTimes(1)
			})

			it('still asks before a memory is deleted', async () => {
				const { handler, ask } = handlerFor(mode)
				await handler(review(call('delete_memory', {}, true)))
				expect(ask).toHaveBeenCalledTimes(1)
			})
		})
	}

	it('prompt mode asks about a workspace write', async () => {
		const { handler, ask } = handlerFor('prompt')
		await handler(review(call('write', { path: '/work/a.ts', content: 'x' })))
		expect(ask).toHaveBeenCalledTimes(1)
	})

	it('plan mode still refuses a memory write', async () => {
		const { handler, ask } = handlerFor('plan')
		expect(await handler(review(call('save_memory')))).toEqual({
			action: 'reject_tools',
			feedback: PLAN_MODE_REFUSAL,
		})
		expect(ask).not.toHaveBeenCalled()
	})

	it('strict mode still refuses a memory write', async () => {
		const { handler } = handlerFor('strict')
		expect((await handler(review(call('save_memory')))).action).toBe('reject_tools')
	})

	it('does not exempt a memory tool the session does not mount', () => {
		const bare = new ToolManager({ toolsets: [], messages: () => [] })
		expect(reviewExemptionFor('prompt', bare, () => false)('save_memory', {})).toBe(false)
	})
})
