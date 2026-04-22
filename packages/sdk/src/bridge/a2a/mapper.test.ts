/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `mapRunToA2AEvent(event, contextId?)` is a one-way mapper: RunEvent →
 *     A2AStreamEvent | null. There is no reverse mapper (§2.7).
 *   - For events in MAPPING, the returned object is either a
 *     TaskStatusUpdateEvent (with a `status` field) or a
 *     TaskArtifactUpdateEvent (with an `artifact` field).
 *   - For events explicitly mapped to null (iteration_completed,
 *     tool_executing, sub-session lifecycle, etc.), the mapper returns
 *     null — this is NOT a bug, it is the "bridge does not surface this"
 *     contract. Asserting the null-set here pins the contract.
 *   - `run_started` / `run_completed` / `run_failed` / `iteration_started`
 *     / `run_paused` produce TaskStatusUpdateEvent with stable states:
 *     running / completed / failed / running / input-required.
 *   - `run_completed.final` is true; every non-terminal status event has
 *     `final: false`.
 *   - `llm_response` with null/empty `content` returns null; with content
 *     returns a running status event.
 *   - `tool_completed` produces an artifact event with `artifactId`
 *     containing a timestamp and `metadata.toolName`.
 *   - `tool_review_requested` and `plan_ready` attach data parts with
 *     domain-specific mime types: `application/x-namzu-review-request`
 *     and `application/x-namzu-plan`.
 *   - `contextId` threads through into the returned event when provided.
 *   - `mapSessionToA2AEvent` is a deprecated alias — identical behavior.
 */

import { describe, expect, it } from 'vitest'

import type { CheckpointId, PlanId, RunId, TaskId } from '../../types/ids/index.js'
import type { RunEvent } from '../../types/run/events.js'

import { mapRunToA2AEvent, mapSessionToA2AEvent } from './mapper.js'

const RID = 'run_1' as RunId

function isStatusEvent(
	e: ReturnType<typeof mapRunToA2AEvent>,
): e is Extract<NonNullable<ReturnType<typeof mapRunToA2AEvent>>, { status: unknown }> {
	return !!e && 'status' in e
}

function isArtifactEvent(
	e: ReturnType<typeof mapRunToA2AEvent>,
): e is Extract<NonNullable<ReturnType<typeof mapRunToA2AEvent>>, { artifact: unknown }> {
	return !!e && 'artifact' in e
}

describe('mapRunToA2AEvent — mapped variants', () => {
	it('run_started → running / not final / contextId threaded', () => {
		const event: RunEvent = { type: 'run_started', runId: RID }
		const a2a = mapRunToA2AEvent(event, 'ctx_42')
		expect(isStatusEvent(a2a)).toBe(true)
		if (isStatusEvent(a2a)) {
			expect(a2a.status.state).toBe('running')
			expect(a2a.final).toBe(false)
			expect(a2a.contextId).toBe('ctx_42')
			expect(a2a.taskId).toBe(RID)
		}
	})

	it('run_completed → completed / final / message carries the result', () => {
		const event: RunEvent = { type: 'run_completed', runId: RID, result: 'done' }
		const a2a = mapRunToA2AEvent(event)
		expect(isStatusEvent(a2a)).toBe(true)
		if (isStatusEvent(a2a)) {
			expect(a2a.status.state).toBe('completed')
			expect(a2a.final).toBe(true)
			expect(a2a.status.message?.parts).toEqual([{ kind: 'text', text: 'done' }])
		}
	})

	it('run_failed → failed / final / message carries the error', () => {
		const event: RunEvent = { type: 'run_failed', runId: RID, error: 'boom' }
		const a2a = mapRunToA2AEvent(event)
		expect(isStatusEvent(a2a)).toBe(true)
		if (isStatusEvent(a2a)) {
			expect(a2a.status.state).toBe('failed')
			expect(a2a.final).toBe(true)
			expect(a2a.status.message?.parts).toEqual([{ kind: 'text', text: 'boom' }])
		}
	})

	it('iteration_started → running / not final / message names the iteration', () => {
		const event: RunEvent = { type: 'iteration_started', runId: RID, iteration: 3 }
		const a2a = mapRunToA2AEvent(event)
		expect(isStatusEvent(a2a)).toBe(true)
		if (isStatusEvent(a2a)) {
			expect(a2a.status.state).toBe('running')
			expect(a2a.final).toBe(false)
			expect(a2a.status.message?.parts[0]).toMatchObject({
				kind: 'text',
				text: expect.stringContaining('Iteration 3'),
			})
		}
	})

	it('llm_response with content → running + text part', () => {
		const event: RunEvent = { type: 'llm_response', runId: RID, content: 'hi', hasToolCalls: false }
		const a2a = mapRunToA2AEvent(event)
		expect(isStatusEvent(a2a)).toBe(true)
		if (isStatusEvent(a2a)) {
			expect(a2a.status.state).toBe('running')
			expect(a2a.status.message?.parts).toEqual([{ kind: 'text', text: 'hi' }])
		}
	})

	it('llm_response with null content → null', () => {
		const event: RunEvent = { type: 'llm_response', runId: RID, content: null, hasToolCalls: true }
		expect(mapRunToA2AEvent(event)).toBeNull()
	})

	it('llm_response with empty-string content → null (falsy)', () => {
		const event: RunEvent = { type: 'llm_response', runId: RID, content: '', hasToolCalls: false }
		expect(mapRunToA2AEvent(event)).toBeNull()
	})

	it('tool_completed → artifact with toolName metadata + timestamped id', () => {
		const event: RunEvent = {
			type: 'tool_completed',
			runId: RID,
			toolName: 'read_file',
			result: 'ok',
		}
		const a2a = mapRunToA2AEvent(event)
		expect(isArtifactEvent(a2a)).toBe(true)
		if (isArtifactEvent(a2a)) {
			expect(a2a.artifact.artifactId).toMatch(/^tool-read_file-\d+$/)
			expect(a2a.artifact.name).toBe('read_file result')
			expect(a2a.artifact.parts).toEqual([{ kind: 'text', text: 'ok' }])
			expect(a2a.artifact.metadata).toEqual({ toolName: 'read_file' })
		}
	})

	it('tool_review_requested → input-required + data part with review mime type', () => {
		const event: RunEvent = {
			type: 'tool_review_requested',
			runId: RID,
			iteration: 2,
			toolCalls: [{ id: 'tc1', name: 'write_file', input: {}, isDestructive: true }],
		}
		const a2a = mapRunToA2AEvent(event)
		expect(isStatusEvent(a2a)).toBe(true)
		if (isStatusEvent(a2a)) {
			expect(a2a.status.state).toBe('input-required')
			const dataPart = a2a.status.message?.parts.find((p) => p.kind === 'data')
			expect(dataPart).toBeDefined()
			if (dataPart && dataPart.kind === 'data') {
				expect(dataPart.mimeType).toBe('application/x-namzu-review-request')
				expect(dataPart.data).toEqual({
					toolCalls: [{ id: 'tc1', name: 'write_file', isDestructive: true }],
				})
			}
		}
	})

	it('plan_ready → input-required + data part with plan mime type', () => {
		const event: RunEvent = {
			type: 'plan_ready',
			runId: RID,
			planId: 'plan_1' as PlanId,
			title: 'Migrate tables',
			summary: 'Three steps',
			steps: [
				{
					id: 's1',
					description: 'create schema',
					toolName: 'bash',
					dependsOn: [],
					order: 0,
					status: 'pending',
				},
			],
		}
		const a2a = mapRunToA2AEvent(event)
		expect(isStatusEvent(a2a)).toBe(true)
		if (isStatusEvent(a2a)) {
			expect(a2a.status.state).toBe('input-required')
			const dataPart = a2a.status.message?.parts.find((p) => p.kind === 'data')
			expect(dataPart).toBeDefined()
			if (dataPart && dataPart.kind === 'data') {
				expect(dataPart.mimeType).toBe('application/x-namzu-plan')
				expect(dataPart.data).toMatchObject({
					planId: 'plan_1',
					title: 'Migrate tables',
					summary: 'Three steps',
				})
			}
		}
	})

	it('run_paused → input-required + reason in text part', () => {
		const event: RunEvent = {
			type: 'run_paused',
			runId: RID,
			checkpointId: 'ckpt_1' as CheckpointId,
			reason: 'waiting for review',
		}
		const a2a = mapRunToA2AEvent(event)
		expect(isStatusEvent(a2a)).toBe(true)
		if (isStatusEvent(a2a)) {
			expect(a2a.status.state).toBe('input-required')
			expect(a2a.status.message?.parts[0]).toMatchObject({
				kind: 'text',
				text: expect.stringContaining('waiting for review'),
			})
		}
	})
})

describe('mapRunToA2AEvent — explicit null set', () => {
	const nullEvents: RunEvent[] = [
		{ type: 'iteration_completed', runId: RID, iteration: 1, hasToolCalls: false },
		{ type: 'tool_executing', runId: RID, toolName: 'x', input: {} },
		{ type: 'tool_review_completed', runId: RID, decision: 'approved' },
		{
			type: 'checkpoint_created',
			runId: RID,
			checkpointId: 'ckpt_1' as CheckpointId,
			iteration: 1,
		},
		{ type: 'run_resuming', runId: RID, fromCheckpointId: 'ckpt_1' as CheckpointId },
		{
			type: 'token_usage_updated',
			runId: RID,
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			cost: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: 0, cacheDiscount: 0 },
		},
		{ type: 'plan_approved', runId: RID, planId: 'plan_1' as PlanId },
		{ type: 'plan_rejected', runId: RID, planId: 'plan_1' as PlanId },
		{
			type: 'agent_pending',
			runId: RID,
			taskId: 'task_1' as TaskId,
			parentAgentId: 'a',
			childAgentId: 'b',
			depth: 1,
		},
		{
			type: 'agent_completed',
			runId: RID,
			taskId: 'task_1' as TaskId,
			result: {
				runId: RID,
				status: 'completed',
				iterations: 1,
				durationMs: 1,
				messages: [],
				usage: {
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
				cost: {
					inputCostPer1M: 0,
					outputCostPer1M: 0,
					totalCost: 0,
					cacheDiscount: 0,
				},
			},
		},
		{ type: 'agent_failed', runId: RID, taskId: 'task_1' as TaskId, error: 'e' },
		{ type: 'agent_canceled', runId: RID, taskId: 'task_1' as TaskId },
	]

	it.each(nullEvents.map((e) => [e.type, e] as const))(
		'%s returns null (bridge does not surface)',
		(_name, event) => {
			expect(mapRunToA2AEvent(event)).toBeNull()
		},
	)
})

describe('mapSessionToA2AEvent (deprecated alias)', () => {
	it('is the same function reference as mapRunToA2AEvent', () => {
		// toEqual against paired invocations races the ISO timestamp
		// inside `statusEvent()` across a millisecond boundary; CI
		// flaked once with 1 ms drift (see PR #11 Build & Test (22)
		// 2026-04-22T11:13). Identity check is deterministic and
		// asserts the deprecation shim strictly — not just a "similar
		// output" check.
		expect(mapSessionToA2AEvent).toBe(mapRunToA2AEvent)
	})
})
