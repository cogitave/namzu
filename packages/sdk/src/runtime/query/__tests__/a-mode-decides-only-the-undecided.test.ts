/**
 * Only calls the gate routed to review reach a review policy, and the mode
 * decides what happens to them. These pin the five answers, the exemption
 * predicate, and that "approve all" is remembered where the host looks.
 */

import { describe, expect, it, vi } from 'vitest'

import { z } from 'zod'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { HITLDecisionRequest, ToolCallSummary } from '../../../types/hitl/index.js'
import type { CheckpointId, RunId } from '../../../types/ids/index.js'
import {
	PLAN_MODE_REFUSAL,
	STRICT_MODE_REFUSAL,
	batchNeedsReview,
	createReviewHandler,
	createReviewPolicy,
	isReviewExempt,
} from '../review-policy.js'

const call = (name: string, extra: Partial<ToolCallSummary> = {}): ToolCallSummary => ({
	id: `call_${name}`,
	name,
	input: {},
	isDestructive: false,
	...extra,
})

const review = (...toolCalls: ToolCallSummary[]): HITLDecisionRequest => ({
	type: 'tool_review',
	runId: 'run_review' as RunId,
	checkpointId: 'cp_review' as CheckpointId,
	toolCalls,
})

const exemptNames =
	(...names: string[]) =>
	(name: string) =>
		names.includes(name)

describe('isReviewExempt', () => {
	const registry = new ToolRegistry()
	registry.register(
		defineTool({
			name: 'read',
			description: 'r',
			inputSchema: z.object({}),
			readOnly: true,
			category: 'filesystem',
			permissions: [],
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: '' }),
		}),
	)
	registry.register(
		defineTool({
			name: 'write',
			description: 'w',
			inputSchema: z.object({}),
			readOnly: false,
			category: 'filesystem',
			permissions: [],
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: '' }),
		}),
	)
	registry.register(
		defineTool({
			name: 'web_fetch',
			description: 'f',
			inputSchema: z.object({}),
			readOnly: true,
			category: 'network',
			permissions: [],
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: '' }),
		}),
	)

	it('exempts a trusted read-only tool and the named bookkeeping writes', () => {
		expect(isReviewExempt(registry, 'read', {})).toBe(true)
		expect(isReviewExempt(registry, 'task_create', {})).toBe(true)
		expect(isReviewExempt(registry, 'TASK_UPDATE', {})).toBe(true)
	})

	it('reviews a write, a network fetch even when read-only, and a tool it does not know', () => {
		expect(isReviewExempt(registry, 'write', {})).toBe(false)
		expect(isReviewExempt(registry, 'web_fetch', {})).toBe(false)
		expect(isReviewExempt(registry, 'save_memory', {})).toBe(false)
	})
})

describe('batchNeedsReview', () => {
	it('is quiet for exempt calls and loud for a destructive one even when exempt', () => {
		expect(batchNeedsReview([call('read')], exemptNames('read'))).toBe(false)
		expect(batchNeedsReview([call('read', { isDestructive: true })], exemptNames('read'))).toBe(
			true,
		)
		expect(batchNeedsReview([call('read'), call('write')], exemptNames('read'))).toBe(true)
	})
})

describe('the five modes', () => {
	it('defaults to prompt with a prompt and auto without one', async () => {
		const prompt = vi.fn(async () => ({ kind: 'approve' as const }))
		await createReviewHandler({ prompt })(review(call('bash')))
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(await createReviewHandler()(review(call('bash')))).toEqual({
			action: 'approve_tools',
		})
		expect(createReviewPolicy({ prompt }).name).toBe('prompt')
		expect(createReviewPolicy().name).toBe('auto')
	})

	it('never asks about a batch that needs no review', async () => {
		const prompt = vi.fn(async () => ({ kind: 'reject' as const }))
		const decide = createReviewHandler({ prompt, exempt: exemptNames('read') })
		expect(await decide(review(call('read')))).toEqual({
			action: 'approve_tools',
		})
		expect(prompt).not.toHaveBeenCalled()
	})

	it('accept-edits approves a batch of plain edits and asks when a shell call rides along', async () => {
		const prompt = vi.fn(async () => ({ kind: 'approve' as const }))
		const decide = createReviewHandler({ mode: 'accept-edits', prompt })
		expect(await decide(review(call('edit'), call('write')))).toEqual({
			action: 'approve_tools',
		})
		expect(prompt).not.toHaveBeenCalled()
		await decide(review(call('edit'), call('bash')))
		expect(prompt).toHaveBeenCalledTimes(1)
		await decide(review(call('edit', { isDestructive: true })))
		expect(prompt).toHaveBeenCalledTimes(2)
	})

	it('plan and strict refuse with the words that tell the model what to do instead', async () => {
		expect(await createReviewHandler({ mode: 'plan' })(review(call('write')))).toEqual({
			action: 'reject_tools',
			feedback: PLAN_MODE_REFUSAL,
		})
		expect(await createReviewHandler({ mode: 'strict' })(review(call('write')))).toEqual({
			action: 'reject_tools',
			feedback: STRICT_MODE_REFUSAL,
		})
	})

	it('remembers approve-all in the box the host handed over', async () => {
		const remembered = { all: false }
		const prompt = vi.fn(async () => ({ kind: 'approve-all' as const }))
		const decide = createReviewHandler({ prompt, remembered })
		await decide(review(call('bash')))
		expect(remembered.all).toBe(true)
		await decide(review(call('bash')))
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('relays a rejection with the feedback the person gave, or a default', async () => {
		const decide = createReviewHandler({
			prompt: async () => ({ kind: 'reject', feedback: 'not that file' }),
		})
		expect(await decide(review(call('bash')))).toEqual({
			action: 'reject_tools',
			feedback: 'not that file',
		})
		const quiet = createReviewHandler({
			prompt: async () => ({ kind: 'reject' }),
		})
		expect(await quiet(review(call('bash')))).toMatchObject({
			action: 'reject_tools',
		})
	})

	it('approves a plan and continues everything else that is not a tool review', async () => {
		const decide = createReviewHandler({ mode: 'strict' })
		expect(
			await decide({
				type: 'plan_approval',
				runId: 'r' as RunId,
				checkpointId: 'c' as CheckpointId,
			} as HITLDecisionRequest),
		).toEqual({ action: 'approve_plan' })
	})
})
