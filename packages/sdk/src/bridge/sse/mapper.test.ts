/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `mapSessionEventToStreamEvent(event)` returns `{wire, data}` or null.
 *   - Wire names match a fixed mapping (one per SessionEvent.type):
 *     turn.started, iteration.started, iteration.completed, message.delta,
 *     tool.executing, tool.completed, review.requested, review.completed,
 *     checkpoint.created, turn.paused, turn.resuming, token.usage,
 *     activity.created, activity.updated, plan.ready, plan.approved,
 *     plan.rejected, plan.step_updated, agent.pending, agent.completed,
 *     agent.failed, agent.canceled, task.created, task.updated,
 *     plugin.hook_executing, plugin.hook_completed, sandbox.created,
 *     sandbox.exec, sandbox.destroyed.
 *   - `turn_completed` and `turn_failed` produce null (the host writes the
 *     terminal frame from the settled turn, not the SSE delta).
 *   - Child-session lifecycle events (spawned / messaged / idled) produce
 *     null — the SSE wire surface does not carry them today.
 *   - `data.session_id` is always the event's own session, and `data.turn_id`
 *     its turn when it has one; an event outside a turn carries no `turn_id`.
 *   - `llm_response` data: `content` falls back to null when empty;
 *     `has_tool_calls` is a boolean.
 *   - If the event carries `sourceAgentId` or `parentTaskId` fields,
 *     they are mirrored onto `data.source_agent_id` / `data.parent_task_id`
 *     (snake-cased).
 *   - `mapSessionToStreamEvent` is a deprecated alias.
 */

import { describe, expect, it } from 'vitest'

import { fixtureId } from '../../test-support/ids.js'
import type {
	ActivityId,
	CheckpointId,
	PlanId,
	PluginId,
	SandboxId,
	SessionId,
	TaskId,
	TurnId,
} from '../../types/ids/index.js'
import type { SessionEvent } from '../../types/session/events.js'

import { mapSessionEventToStreamEvent, mapSessionToStreamEvent } from './mapper.js'

const SID = '37ddff8e-e13f-4e57-937f-d048fa323f5e' as SessionId
const TID = '0199b3a0-0000-7000-8000-00000000000a' as TurnId
/** The fields `turn_started` requires and these tests do not look at. */
const STARTED = {
	userMessageId: fixtureId.message('prompt'),
	config: { model: 'm', tokenBudget: 1, timeoutMs: 1 },
}

describe('mapSessionEventToStreamEvent — mapped variants', () => {
	it('turn_started → turn.started', () => {
		const r = mapSessionEventToStreamEvent({
			type: 'turn_started',
			sessionId: SID,
			turnId: TID,
			...STARTED,
			systemPrompt: 'be terse',
		})
		expect(r?.wire).toBe('turn.started')
		expect(r?.data).toMatchObject({ session_id: SID, turn_id: TID, system_prompt: 'be terse' })
	})

	it('turn_started with no systemPrompt → system_prompt: null', () => {
		const r = mapSessionEventToStreamEvent({
			type: 'turn_started',
			sessionId: SID,
			turnId: TID,
			...STARTED,
		})
		expect(r?.data).toMatchObject({ system_prompt: null })
	})

	it('iteration_started / iteration_completed carry iteration number', () => {
		const a = mapSessionEventToStreamEvent({
			type: 'iteration_started',
			sessionId: SID,
			turnId: TID,
			iteration: 2,
		})
		expect(a).toEqual({
			wire: 'iteration.started',
			data: { session_id: SID, turn_id: TID, iteration: 2 },
		})

		const b = mapSessionEventToStreamEvent({
			type: 'iteration_completed',
			sessionId: SID,
			turnId: TID,
			iteration: 2,
			hasToolCalls: false,
		})
		expect(b).toEqual({
			wire: 'iteration.completed',
			data: { session_id: SID, turn_id: TID, iteration: 2 },
		})
	})

	it('tool_executing / tool_completed carry tool_use_id, tool_name, input/result, is_error', () => {
		const TUID = 'toolu_x'
		const exec = mapSessionEventToStreamEvent({
			type: 'tool_executing',
			sessionId: SID,
			turnId: TID,
			toolUseId: TUID,
			toolName: 'read_file',
			input: { path: '/a' },
		})
		expect(exec?.wire).toBe('tool.executing')
		expect(exec?.data).toMatchObject({
			tool_use_id: TUID,
			tool_name: 'read_file',
			input: { path: '/a' },
		})

		const done = mapSessionEventToStreamEvent({
			type: 'tool_completed',
			sessionId: SID,
			turnId: TID,
			toolUseId: TUID,
			toolName: 'read_file',
			result: 'ok',
			isError: false,
		})
		expect(done?.wire).toBe('tool.completed')
		expect(done?.data).toMatchObject({
			tool_use_id: TUID,
			tool_name: 'read_file',
			result: 'ok',
			is_error: false,
		})
	})

	it('tool_review_requested / tool_review_completed carry review fields', () => {
		const a = mapSessionEventToStreamEvent({
			type: 'tool_review_requested',
			sessionId: SID,
			turnId: TID,
			iteration: 1,
			toolCalls: [{ id: 'tc1', name: 'write_file', input: {}, isDestructive: true }],
		})
		expect(a?.wire).toBe('review.requested')
		expect(a?.data.iteration).toBe(1)

		const b = mapSessionEventToStreamEvent({
			type: 'tool_review_completed',
			sessionId: SID,
			turnId: TID,
			decision: 'modified',
		})
		expect(b).toEqual({
			wire: 'review.completed',
			data: { session_id: SID, turn_id: TID, decision: 'modified' },
		})
	})

	it('checkpoint_created → checkpoint.created', () => {
		const r = mapSessionEventToStreamEvent({
			type: 'checkpoint_created',
			sessionId: SID,
			turnId: TID,
			checkpointId: 'ckpt_1' as CheckpointId,
			iteration: 1,
		})
		expect(r?.wire).toBe('checkpoint.created')
		expect(r?.data).toMatchObject({ checkpoint_id: 'ckpt_1', iteration: 1 })
	})

	it('turn_paused / turn_resuming carry checkpoint fields', () => {
		const p = mapSessionEventToStreamEvent({
			type: 'turn_paused',
			sessionId: SID,
			turnId: TID,
			checkpointId: 'ckpt_2' as CheckpointId,
			reason: 'input required',
			failure: {
				code: 'provider_error',
				message: 'slow down',
				retryable: true,
				details: { providerCode: 'rate_limit', retryAfterMs: 3_000 },
			},
			explanation: {
				id: 'provider.rate_limit',
				message: 'The provider is rate limiting this turn.',
				hint: 'Wait, then resume.',
			},
		})
		expect(p?.wire).toBe('turn.paused')
		expect(p?.data).toMatchObject({
			checkpoint_id: 'ckpt_2',
			reason: 'input required',
			failure: { retryable: true, details: { retryAfterMs: 3_000 } },
			explanation: { id: 'provider.rate_limit' },
		})

		const r = mapSessionEventToStreamEvent({
			type: 'turn_resuming',
			sessionId: SID,
			turnId: TID,
			fromCheckpointId: 'ckpt_2' as CheckpointId,
		})
		expect(r).toEqual({
			wire: 'turn.resuming',
			data: { session_id: SID, turn_id: TID, from_checkpoint_id: 'ckpt_2' },
		})
	})

	it('plan_* events carry plan_id', () => {
		const ready = mapSessionEventToStreamEvent({
			type: 'plan_ready',
			sessionId: SID,
			turnId: TID,
			planId: 'f892ba68-03a6-484b-94ed-6368b6ba644a' as PlanId,
			title: 't',
			summary: 's',
			steps: [],
		})
		expect(ready?.wire).toBe('plan.ready')

		expect(
			mapSessionEventToStreamEvent({
				type: 'plan_approved',
				sessionId: SID,
				turnId: TID,
				planId: 'f892ba68-03a6-484b-94ed-6368b6ba644a' as PlanId,
			})?.wire,
		).toBe('plan.approved')

		expect(
			mapSessionEventToStreamEvent({
				type: 'plan_rejected',
				sessionId: SID,
				turnId: TID,
				planId: 'f892ba68-03a6-484b-94ed-6368b6ba644a' as PlanId,
				reason: 'nope',
			})?.wire,
		).toBe('plan.rejected')

		expect(
			mapSessionEventToStreamEvent({
				type: 'plan_step_updated',
				sessionId: SID,
				turnId: TID,
				planId: 'f892ba68-03a6-484b-94ed-6368b6ba644a' as PlanId,
				stepId: 's1',
				status: 'completed',
			})?.wire,
		).toBe('plan.step_updated')
	})

	it('agent_* events carry task_id', () => {
		const pending = mapSessionEventToStreamEvent({
			type: 'agent_pending',
			sessionId: SID,
			turnId: TID,
			taskId: '5f5d0823-8327-45fd-a288-bf8fd5f45f91' as TaskId,
			parentAgentId: 'a',
			childAgentId: 'b',
			depth: 1,
		})
		expect(pending?.wire).toBe('agent.pending')
		expect(pending?.data).toMatchObject({
			task_id: '5f5d0823-8327-45fd-a288-bf8fd5f45f91',
			depth: 1,
		})

		expect(
			mapSessionEventToStreamEvent({
				type: 'agent_completed',
				sessionId: SID,
				turnId: TID,
				taskId: '5f5d0823-8327-45fd-a288-bf8fd5f45f91' as TaskId,
				result: {
					sessionId: SID,
					turnId: TID,
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
						unpricedTokens: 0,
					},
				},
			})?.wire,
		).toBe('agent.completed')

		expect(
			mapSessionEventToStreamEvent({
				type: 'agent_failed',
				sessionId: SID,
				turnId: TID,
				taskId: '5f5d0823-8327-45fd-a288-bf8fd5f45f91' as TaskId,
				error: 'e',
			})?.wire,
		).toBe('agent.failed')

		expect(
			mapSessionEventToStreamEvent({
				type: 'agent_canceled',
				sessionId: SID,
				turnId: TID,
				taskId: '5f5d0823-8327-45fd-a288-bf8fd5f45f91' as TaskId,
			})?.wire,
		).toBe('agent.canceled')
	})

	it('agent.pending carries an approved plan edge when present', () => {
		const pending = mapSessionEventToStreamEvent({
			type: 'agent_pending',
			sessionId: SID,
			turnId: TID,
			taskId: 'task_1' as TaskId,
			parentAgentId: 'supervisor',
			childAgentId: 'worker',
			depth: 1,
			planId: 'plan_1',
			planStepId: 'step_2',
		})

		expect(pending?.data).toMatchObject({
			plan_id: 'plan_1',
			plan_step_id: 'step_2',
		})
	})

	it('agent.pending carries display labels when present', () => {
		const pending = mapSessionEventToStreamEvent({
			type: 'agent_pending',
			sessionId: SID,
			turnId: TID,
			taskId: 'task_1' as TaskId,
			parentAgentId: 'supervisor',
			childAgentId: 'worker',
			depth: 1,
			workflow: 'Release audit',
			phase: 'Verify',
			phaseDetail: 'Confirm the fix against the failing case.',
			phaseOrder: 0,
		})

		expect(pending?.data).toMatchObject({
			workflow: 'Release audit',
			phase: 'Verify',
			phase_detail: 'Confirm the fix against the failing case.',
			// Zero is the FIRST phase, not a missing one. The transform tests
			// `!== undefined` for exactly this; a truthiness check here would
			// drop the opening phase of every grouped delegation.
			phase_order: 0,
		})
	})

	it('agent.pending omits them when absent', () => {
		// The transform is an allowlist, so both directions need pinning: a
		// consumer distinguishes "this host groups nothing" from "grouped
		// under an empty label" by the key not being there at all.
		const pending = mapSessionEventToStreamEvent({
			type: 'agent_pending',
			sessionId: SID,
			turnId: TID,
			taskId: 'task_1' as TaskId,
			parentAgentId: 'supervisor',
			childAgentId: 'worker',
			depth: 1,
		})

		expect(pending?.wire).toBe('agent.pending')
		for (const key of ['workflow', 'phase', 'phase_detail', 'phase_order'])
			expect(pending?.data).not.toHaveProperty(key)
	})

	it('task_created / task_updated map cleanly', () => {
		const a = mapSessionEventToStreamEvent({
			type: 'task_created',
			sessionId: SID,
			turnId: TID,
			taskId: '5f5d0823-8327-45fd-a288-bf8fd5f45f91' as TaskId,
			subject: 's',
			status: 'pending',
		})
		expect(a?.wire).toBe('task.created')

		const b = mapSessionEventToStreamEvent({
			type: 'task_updated',
			sessionId: SID,
			turnId: TID,
			taskId: '5f5d0823-8327-45fd-a288-bf8fd5f45f91' as TaskId,
			subject: 's',
			status: 'completed',
		})
		expect(b?.wire).toBe('task.updated')
		expect(b?.data.owner).toBe(null) // undefined owner → null
		expect(b?.data).not.toHaveProperty('deleted')

		const c = mapSessionEventToStreamEvent({
			type: 'task_updated',
			sessionId: SID,
			turnId: TID,
			taskId: '5f5d0823-8327-45fd-a288-bf8fd5f45f91' as TaskId,
			subject: 's',
			status: 'pending',
			deleted: true,
		})
		expect(c?.data.deleted).toBe(true)
	})

	it('plugin_hook_* + sandbox_* + activity_* events map cleanly', () => {
		expect(
			mapSessionEventToStreamEvent({
				type: 'plugin_hook_executing',
				sessionId: SID,
				turnId: TID,
				pluginId: 'plugin_x' as PluginId,
				hookEvent: 'pre_tool_use',
			})?.wire,
		).toBe('plugin.hook_executing')

		expect(
			mapSessionEventToStreamEvent({
				type: 'plugin_hook_completed',
				sessionId: SID,
				turnId: TID,
				pluginId: 'plugin_x' as PluginId,
				hookEvent: 'pre_tool_use',
				result: { action: 'continue' },
			})?.wire,
		).toBe('plugin.hook_completed')

		expect(
			mapSessionEventToStreamEvent({
				type: 'sandbox_created',
				sessionId: SID,
				turnId: TID,
				sandboxId: 'efcf1d0f-3ba3-4447-bc22-8a955cacbeb9' as SandboxId,
				environment: 'basic',
			})?.wire,
		).toBe('sandbox.created')

		expect(
			mapSessionEventToStreamEvent({
				type: 'sandbox_exec',
				sessionId: SID,
				turnId: TID,
				sandboxId: 'efcf1d0f-3ba3-4447-bc22-8a955cacbeb9' as SandboxId,
				command: 'ls',
				exitCode: 0,
				durationMs: 10,
			})?.wire,
		).toBe('sandbox.exec')

		expect(
			mapSessionEventToStreamEvent({
				type: 'sandbox_destroyed',
				sessionId: SID,
				turnId: TID,
				sandboxId: 'efcf1d0f-3ba3-4447-bc22-8a955cacbeb9' as SandboxId,
			})?.wire,
		).toBe('sandbox.destroyed')

		expect(
			mapSessionEventToStreamEvent({
				type: 'activity_created',
				sessionId: SID,
				turnId: TID,
				activityId: '90132664-4743-4cd5-bf4c-c5ff06465fbc' as ActivityId,
				activityType: 'tool_call',
				description: 'd',
			})?.wire,
		).toBe('activity.created')

		expect(
			mapSessionEventToStreamEvent({
				type: 'activity_updated',
				sessionId: SID,
				turnId: TID,
				activityId: '90132664-4743-4cd5-bf4c-c5ff06465fbc' as ActivityId,
				status: 'completed',
			})?.wire,
		).toBe('activity.updated')
	})

	it('token_usage_updated → token.usage with usage + cost passed through', () => {
		const usage = {
			promptTokens: 10,
			completionTokens: 20,
			totalTokens: 30,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		const cost = {
			inputCostPer1M: 1,
			outputCostPer1M: 2,
			totalCost: 0.01,
			cacheDiscount: 0,
			unpricedTokens: 0,
		}
		const r = mapSessionEventToStreamEvent({
			type: 'token_usage_updated',
			sessionId: SID,
			turnId: TID,
			usage,
			cost,
		})
		expect(r?.wire).toBe('token.usage')
		expect(r?.data).toMatchObject({ usage, cost })
	})

	it('source_agent_id + parent_task_id are mirrored when present on the event', () => {
		const event = {
			type: 'turn_started',
			sessionId: SID,
			turnId: TID,
			sourceAgentId: 'de369c12-a778-45cc-9220-7509d19510ca',
			parentTaskId: 'dc96f849-400d-466e-96b9-c5b06fa87727',
		} as unknown as SessionEvent
		const r = mapSessionEventToStreamEvent(event)
		expect(r?.data).toMatchObject({
			source_agent_id: 'de369c12-a778-45cc-9220-7509d19510ca',
			parent_task_id: 'dc96f849-400d-466e-96b9-c5b06fa87727',
		})
	})
})

describe('mapSessionEventToStreamEvent — explicit null set', () => {
	it.each([
		[{ type: 'turn_completed', sessionId: SID, turnId: TID, result: 'ok' } as SessionEvent],
		[{ type: 'turn_failed', sessionId: SID, turnId: TID, error: 'boom' } as SessionEvent],
	])('%o returns null', (event) => {
		expect(mapSessionEventToStreamEvent(event)).toBeNull()
	})
})

describe('mapSessionEventToStreamEvent — session and turn ids', () => {
	it('an event outside any turn carries the session and no turn_id', () => {
		// A background job can exit between turns. An absent `turn_id` is how a
		// client tells "between turns" from a turn it has not heard of.
		const r = mapSessionEventToStreamEvent({
			type: 'background_job_exited',
			sessionId: SID,
			jobId: 'job_1',
			command: 'sleep 1',
			status: 'exited',
			exitCode: 0,
		})
		expect(r?.data).toMatchObject({ session_id: SID, job_id: 'job_1' })
		expect(r?.data).not.toHaveProperty('turn_id')
	})

	it('every turn.* frame names both the session and the turn', () => {
		const frames = [
			mapSessionEventToStreamEvent({
				type: 'turn_started',
				sessionId: SID,
				turnId: TID,
				...STARTED,
			}),
			mapSessionEventToStreamEvent({
				type: 'turn_paused',
				sessionId: SID,
				turnId: TID,
				checkpointId: fixtureId.checkpoint('1'),
				reason: 'review',
			}),
			mapSessionEventToStreamEvent({
				type: 'turn_resuming',
				sessionId: SID,
				turnId: TID,
				fromCheckpointId: fixtureId.checkpoint('1'),
			}),
		]
		expect(frames.map((frame) => frame?.wire)).toEqual([
			'turn.started',
			'turn.paused',
			'turn.resuming',
		])
		for (const frame of frames) {
			expect(frame?.data).toMatchObject({ session_id: SID, turn_id: TID })
			expect(frame?.data).not.toHaveProperty('run_id')
		}
	})
})

describe('mapSessionEventToStreamEvent — v3 message and tool-input lifecycle', () => {
	const MID = fixtureId.message('1')
	const TUID = 'toolu_a'

	it('message_started → message.created', () => {
		const r = mapSessionEventToStreamEvent({
			type: 'message_started',
			sessionId: SID,
			turnId: TID,
			iteration: 0,
			messageId: MID,
		})
		expect(r?.wire).toBe('message.created')
		expect(r?.data).toMatchObject({ session_id: SID, turn_id: TID, iteration: 0, message_id: MID })
	})

	it('text_delta → message.delta carries raw text fragment', () => {
		const r = mapSessionEventToStreamEvent({
			type: 'text_delta',
			sessionId: SID,
			turnId: TID,
			iteration: 0,
			messageId: MID,
			text: 'hel',
		})
		expect(r?.wire).toBe('message.delta')
		expect(r?.data).toMatchObject({ message_id: MID, text: 'hel' })
	})

	it('message_completed → message.completed carries stop reason and usage', () => {
		const usage = {
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		const r = mapSessionEventToStreamEvent({
			type: 'message_completed',
			sessionId: SID,
			turnId: TID,
			iteration: 0,
			messageId: MID,
			stopReason: 'end_turn',
			usage,
		})
		expect(r?.wire).toBe('message.completed')
		expect(r?.data).toMatchObject({
			message_id: MID,
			stop_reason: 'end_turn',
			usage,
		})
	})

	it('message_completed without usage → usage: null (defensive against dropped message_stop)', () => {
		const r = mapSessionEventToStreamEvent({
			type: 'message_completed',
			sessionId: SID,
			turnId: TID,
			iteration: 0,
			messageId: MID,
			stopReason: 'tool_use',
		})
		expect(r?.data).toMatchObject({ usage: null })
	})

	it('tool_input_started → tool.input_started carries toolUseId + toolName', () => {
		const r = mapSessionEventToStreamEvent({
			type: 'tool_input_started',
			sessionId: SID,
			turnId: TID,
			iteration: 0,
			messageId: MID,
			toolUseId: TUID,
			toolName: 'read',
		})
		expect(r?.wire).toBe('tool.input_started')
		expect(r?.data).toMatchObject({
			tool_use_id: TUID,
			tool_name: 'read',
			message_id: MID,
		})
	})

	it('tool_input_delta → tool.input_delta carries raw partial JSON fragment', () => {
		const r = mapSessionEventToStreamEvent({
			type: 'tool_input_delta',
			sessionId: SID,
			turnId: TID,
			toolUseId: TUID,
			partialJson: '{"file_path":"',
		})
		expect(r?.wire).toBe('tool.input_delta')
		expect(r?.data).toMatchObject({
			tool_use_id: TUID,
			partial_json: '{"file_path":"',
		})
	})

	it('tool_input_completed → tool.input_completed carries parsed input object', () => {
		const r = mapSessionEventToStreamEvent({
			type: 'tool_input_completed',
			sessionId: SID,
			turnId: TID,
			toolUseId: TUID,
			input: { file_path: '/etc/passwd' },
		})
		expect(r?.wire).toBe('tool.input_completed')
		expect(r?.data).toMatchObject({
			tool_use_id: TUID,
			input: { file_path: '/etc/passwd' },
		})
	})
})

describe('the compaction family on the wire', () => {
	const cleared = {
		type: 'compaction_tool_results_cleared' as const,
		sessionId: SID,
		turnId: TID,
		iteration: 4,
		clearedCount: 2,
		charsReclaimed: 158_476,
		reclaimedTokens: 39_619,
		reliefWasEnough: false,
	}

	it('carries every field of a tool-result clear, snake-cased', () => {
		// The transform was wired and nothing exercised it — the whole
		// point of the event is that a host can render what was lost, and a
		// field dropped in the mapping loses it just as surely as not
		// emitting at all. Asserted field by field, not by shape, because
		// `toMatchObject` on a subset would pass with the interesting half
		// missing.
		const r = mapSessionEventToStreamEvent(cleared)

		expect(r?.wire).toBe('compaction.tool_results_cleared')
		expect(r?.data).toEqual({
			session_id: SID,
			turn_id: TID,
			iteration: 4,
			cleared_count: 2,
			chars_reclaimed: 158_476,
			reclaimed_tokens: 39_619,
			relief_was_enough: false,
		})
	})

	it('carries the relieved branch as a distinct value, not an omission', () => {
		// `false` and absent read the same to a consumer doing a truthiness
		// check, and they mean opposite things: one says a summarization
		// followed, the other says nothing at all.
		const r = mapSessionEventToStreamEvent({ ...cleared, reliefWasEnough: true })

		expect(r?.data).toMatchObject({ relief_was_enough: true })
	})
})

describe('mapSessionToStreamEvent (deprecated alias)', () => {
	it('is the same function reference as mapSessionEventToStreamEvent', () => {
		// Identity check is deterministic. toEqual on paired calls
		// would work here (SSE mapper doesn't touch the clock), but
		// we mirror the a2a mapper test pattern for consistency —
		// the deprecation shim is literal assignment, so identity is
		// the strictest possible assertion.
		expect(mapSessionToStreamEvent).toBe(mapSessionEventToStreamEvent)
	})
})
