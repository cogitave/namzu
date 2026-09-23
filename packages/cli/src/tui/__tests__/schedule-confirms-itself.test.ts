/**
 * The `schedule` tool's `create`, `resume` and `delete` draw their own
 * confirmation. The permission review in front of them asked "Do you want to
 * run schedule?" first, so a person answered twice for one job. They skip
 * the review in `prompt`, `accept-edits` and `auto`; `plan` and `strict`
 * still refuse, an `ask` rule still asks, and `pause` is reviewed as before.
 */

import {
	type HITLDecisionRequest,
	type SessionId,
	type ToolCallSummary,
	ToolRegistry,
	asTurnId,
} from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '../../permissions/mode.js'
import { confirmsItself, makeResumeHandler, reviewExemptionFor } from '../agent.js'

const registry = new ToolRegistry()
const call = (action: string, extra: Partial<ToolCallSummary> = {}): ToolCallSummary => ({
	id: `c_${action}`,
	name: 'schedule',
	input: { action },
	isDestructive: false,
	...extra,
})
const request = (tc: ToolCallSummary): HITLDecisionRequest => ({
	sessionId: '3e2d1c0b-4a59-4867-9f8e-7d6c5b4a3e2f' as SessionId,
	type: 'tool_review',
	turnId: asTurnId('7a0b4c1e-2f3d-4e5a-8b6c-9d0e1f2a3b4c'),
	checkpointId: '82267e66-99cd-4ee0-8a15-b8108f6fce73' as never,
	toolCalls: [tc],
})

async function decide(mode: PermissionMode, tc: ToolCallSummary) {
	const prompt = vi.fn(async () => ({ kind: 'approve' as const }))
	const handler = makeResumeHandler(
		{ all: false },
		prompt,
		mode,
		reviewExemptionFor(mode, registry, () => false),
	)
	const decision = await handler(request(tc))
	return { action: decision.action, asked: prompt.mock.calls.length }
}

describe('the schedule tool’s own confirmation', () => {
	it('names create, resume and delete, and nothing else', () => {
		expect(confirmsItself('schedule', { action: 'create' })).toBe(true)
		expect(confirmsItself('schedule', { action: 'resume' })).toBe(true)
		expect(confirmsItself('schedule', { action: 'delete' })).toBe(true)
		expect(confirmsItself('schedule', { action: 'pause' })).toBe(false)
		expect(confirmsItself('bash', { action: 'create' })).toBe(false)
	})

	it.each(['prompt', 'accept-edits', 'auto'] as const)(
		'is not preceded by a review in %s',
		async (mode) => {
			for (const action of ['create', 'resume', 'delete']) {
				expect(await decide(mode, call(action))).toEqual({ action: 'approve_tools', asked: 0 })
			}
		},
	)

	it('is still reviewed for pause', async () => {
		expect(await decide('prompt', call('pause'))).toEqual({ action: 'approve_tools', asked: 1 })
	})

	it('is still refused in plan and strict', async () => {
		expect((await decide('plan', call('create'))).action).toBe('reject_tools')
		expect((await decide('strict', call('create'))).action).toBe('reject_tools')
	})

	it('is still asked about under an explicit ask rule', async () => {
		const asked = await decide(
			'prompt',
			call('create', {
				authorization: { decision: 'review', explicitReview: true, reason: 'ask rule' } as never,
			}),
		)
		expect(asked.asked).toBe(1)
	})
})
