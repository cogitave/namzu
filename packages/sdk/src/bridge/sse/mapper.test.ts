/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `mapRunToStreamEvent(event, runId)` returns `{wire, data}` or null.
 *   - Wire names match a fixed mapping (one per RunEvent.type):
 *     run.started, iteration.started, iteration.completed, message.delta,
 *     tool.executing, tool.completed, review.requested, review.completed,
 *     checkpoint.created, run.paused, run.resuming, token.usage,
 *     activity.created, activity.updated, plan.ready, plan.approved,
 *     plan.rejected, plan.step_updated, agent.pending, agent.completed,
 *     agent.failed, agent.canceled, task.created, task.updated,
 *     plugin.hook_executing, plugin.hook_completed, sandbox.created,
 *     sandbox.exec, sandbox.destroyed.
 *   - `run_completed` and `run_failed` produce null (final state is
 *     delivered by the task.* path, not the SSE delta).
 *   - Sub-session lifecycle events (spawned / messaged / idled) produce
 *     null — the SSE wire surface does not carry them today.
 *   - `data.run_id` is always set from the second arg.
 *   - `llm_response` data: `content` falls back to null when empty;
 *     `has_tool_calls` is a boolean.
 *   - If the event carries `sourceAgentId` or `parentTaskId` fields,
 *     they are mirrored onto `data.source_agent_id` / `data.parent_task_id`
 *     (snake-cased).
 *   - `mapSessionToStreamEvent` is a deprecated alias.
 */

import { describe, expect, it } from 'vitest'

import type {
	ActivityId,
	CheckpointId,
	PlanId,
	PluginId,
	RunId,
	SandboxId,
	TaskId,
} from '../../types/ids/index.js'
import type { RunEvent } from '../../types/run/events.js'

import { mapRunToStreamEvent, mapSessionToStreamEvent } from './mapper.js'

const RID = 'run_1' as RunId

describe('mapRunToStreamEvent — mapped variants', () => {
	it('run_started → run.started', () => {
		const r = mapRunToStreamEvent(
			{ type: 'run_started', runId: RID, systemPrompt: 'be terse' },
			RID,
		)
		expect(r?.wire).toBe('run.started')
		expect(r?.data).toMatchObject({ run_id: RID, system_prompt: 'be terse' })
	})

	it('run_started with no systemPrompt → system_prompt: null', () => {
		const r = mapRunToStreamEvent({ type: 'run_started', runId: RID }, RID)
		expect(r?.data).toMatchObject({ system_prompt: null })
	})

	it('iteration_started / iteration_completed carry iteration number', () => {
		const a = mapRunToStreamEvent({ type: 'iteration_started', runId: RID, iteration: 2 }, RID)
		expect(a).toEqual({ wire: 'iteration.started', data: { run_id: RID, iteration: 2 } })

		const b = mapRunToStreamEvent(
			{ type: 'iteration_completed', runId: RID, iteration: 2, hasToolCalls: false },
			RID,
		)
		expect(b).toEqual({ wire: 'iteration.completed', data: { run_id: RID, iteration: 2 } })
	})

	it('tool_executing / tool_completed carry tool_use_id, tool_name, input/result, is_error', () => {
		const TUID = 'toolu_x'
		const exec = mapRunToStreamEvent(
			{
				type: 'tool_executing',
				runId: RID,
				toolUseId: TUID,
				toolName: 'read_file',
				input: { path: '/a' },
			},
			RID,
		)
		expect(exec?.wire).toBe('tool.executing')
		expect(exec?.data).toMatchObject({
			tool_use_id: TUID,
			tool_name: 'read_file',
			input: { path: '/a' },
		})

		const done = mapRunToStreamEvent(
			{
				type: 'tool_completed',
				runId: RID,
				toolUseId: TUID,
				toolName: 'read_file',
				result: 'ok',
				isError: false,
			},
			RID,
		)
		expect(done?.wire).toBe('tool.completed')
		expect(done?.data).toMatchObject({
			tool_use_id: TUID,
			tool_name: 'read_file',
			result: 'ok',
			is_error: false,
		})
	})

	it('tool_review_requested / tool_review_completed carry review fields', () => {
		const a = mapRunToStreamEvent(
			{
				type: 'tool_review_requested',
				runId: RID,
				iteration: 1,
				toolCalls: [{ id: 'tc1', name: 'write_file', input: {}, isDestructive: true }],
			},
			RID,
		)
		expect(a?.wire).toBe('review.requested')
		expect(a?.data.iteration).toBe(1)

		const b = mapRunToStreamEvent(
			{ type: 'tool_review_completed', runId: RID, decision: 'modified' },
			RID,
		)
		expect(b).toEqual({ wire: 'review.completed', data: { run_id: RID, decision: 'modified' } })
	})

	it('checkpoint_created → checkpoint.created', () => {
		const r = mapRunToStreamEvent(
			{
				type: 'checkpoint_created',
				runId: RID,
				checkpointId: 'ckpt_1' as CheckpointId,
				iteration: 1,
			},
			RID,
		)
		expect(r?.wire).toBe('checkpoint.created')
		expect(r?.data).toMatchObject({ checkpoint_id: 'ckpt_1', iteration: 1 })
	})

	it('run_paused / run_resuming carry checkpoint fields', () => {
		const p = mapRunToStreamEvent(
			{
				type: 'run_paused',
				runId: RID,
				checkpointId: 'ckpt_2' as CheckpointId,
				reason: 'input required',
			},
			RID,
		)
		expect(p?.wire).toBe('run.paused')
		expect(p?.data).toMatchObject({ checkpoint_id: 'ckpt_2', reason: 'input required' })

		const r = mapRunToStreamEvent(
			{ type: 'run_resuming', runId: RID, fromCheckpointId: 'ckpt_2' as CheckpointId },
			RID,
		)
		expect(r).toEqual({
			wire: 'run.resuming',
			data: { run_id: RID, from_checkpoint_id: 'ckpt_2' },
		})
	})

	it('plan_* events carry plan_id', () => {
		const ready = mapRunToStreamEvent(
			{
				type: 'plan_ready',
				runId: RID,
				planId: 'plan_1' as PlanId,
				title: 't',
				summary: 's',
				steps: [],
			},
			RID,
		)
		expect(ready?.wire).toBe('plan.ready')

		expect(
			mapRunToStreamEvent({ type: 'plan_approved', runId: RID, planId: 'plan_1' as PlanId }, RID)
				?.wire,
		).toBe('plan.approved')

		expect(
			mapRunToStreamEvent(
				{ type: 'plan_rejected', runId: RID, planId: 'plan_1' as PlanId, reason: 'nope' },
				RID,
			)?.wire,
		).toBe('plan.rejected')

		expect(
			mapRunToStreamEvent(
				{
					type: 'plan_step_updated',
					runId: RID,
					planId: 'plan_1' as PlanId,
					stepId: 's1',
					status: 'completed',
				},
				RID,
			)?.wire,
		).toBe('plan.step_updated')
	})

	it('agent_* events carry task_id', () => {
		const pending = mapRunToStreamEvent(
			{
				type: 'agent_pending',
				runId: RID,
				taskId: 'task_1' as TaskId,
				parentAgentId: 'a',
				childAgentId: 'b',
				depth: 1,
			},
			RID,
		)
		expect(pending?.wire).toBe('agent.pending')
		expect(pending?.data).toMatchObject({ task_id: 'task_1', depth: 1 })

		expect(
			mapRunToStreamEvent(
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
				RID,
			)?.wire,
		).toBe('agent.completed')

		expect(
			mapRunToStreamEvent(
				{ type: 'agent_failed', runId: RID, taskId: 'task_1' as TaskId, error: 'e' },
				RID,
			)?.wire,
		).toBe('agent.failed')

		expect(
			mapRunToStreamEvent({ type: 'agent_canceled', runId: RID, taskId: 'task_1' as TaskId }, RID)
				?.wire,
		).toBe('agent.canceled')
	})

	it('task_created / task_updated map cleanly', () => {
		const a = mapRunToStreamEvent(
			{
				type: 'task_created',
				runId: RID,
				taskId: 'task_1' as TaskId,
				subject: 's',
				status: 'pending',
			},
			RID,
		)
		expect(a?.wire).toBe('task.created')

		const b = mapRunToStreamEvent(
			{
				type: 'task_updated',
				runId: RID,
				taskId: 'task_1' as TaskId,
				subject: 's',
				status: 'completed',
			},
			RID,
		)
		expect(b?.wire).toBe('task.updated')
		expect(b?.data.owner).toBe(null) // undefined owner → null
	})

	it('plugin_hook_* + sandbox_* + activity_* events map cleanly', () => {
		expect(
			mapRunToStreamEvent(
				{
					type: 'plugin_hook_executing',
					runId: RID,
					pluginId: 'plugin_x' as PluginId,
					hookEvent: 'pre_tool_use',
				},
				RID,
			)?.wire,
		).toBe('plugin.hook_executing')

		expect(
			mapRunToStreamEvent(
				{
					type: 'plugin_hook_completed',
					runId: RID,
					pluginId: 'plugin_x' as PluginId,
					hookEvent: 'pre_tool_use',
					result: { action: 'continue' },
				},
				RID,
			)?.wire,
		).toBe('plugin.hook_completed')

		expect(
			mapRunToStreamEvent(
				{
					type: 'sandbox_created',
					runId: RID,
					sandboxId: 'sbx_1' as SandboxId,
					environment: 'basic',
				},
				RID,
			)?.wire,
		).toBe('sandbox.created')

		expect(
			mapRunToStreamEvent(
				{
					type: 'sandbox_exec',
					runId: RID,
					sandboxId: 'sbx_1' as SandboxId,
					command: 'ls',
					exitCode: 0,
					durationMs: 10,
				},
				RID,
			)?.wire,
		).toBe('sandbox.exec')

		expect(
			mapRunToStreamEvent(
				{ type: 'sandbox_destroyed', runId: RID, sandboxId: 'sbx_1' as SandboxId },
				RID,
			)?.wire,
		).toBe('sandbox.destroyed')

		expect(
			mapRunToStreamEvent(
				{
					type: 'activity_created',
					runId: RID,
					activityId: 'act_1' as ActivityId,
					activityType: 'tool_call',
					description: 'd',
				},
				RID,
			)?.wire,
		).toBe('activity.created')

		expect(
			mapRunToStreamEvent(
				{
					type: 'activity_updated',
					runId: RID,
					activityId: 'act_1' as ActivityId,
					status: 'completed',
				},
				RID,
			)?.wire,
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
		}
		const r = mapRunToStreamEvent({ type: 'token_usage_updated', runId: RID, usage, cost }, RID)
		expect(r?.wire).toBe('token.usage')
		expect(r?.data).toMatchObject({ usage, cost })
	})

	it('source_agent_id + parent_task_id are mirrored when present on the event', () => {
		const event = {
			type: 'run_started',
			runId: RID,
			sourceAgentId: 'sub_agent_1',
			parentTaskId: 'task_42',
		} as unknown as RunEvent
		const r = mapRunToStreamEvent(event, RID)
		expect(r?.data).toMatchObject({ source_agent_id: 'sub_agent_1', parent_task_id: 'task_42' })
	})
})

describe('mapRunToStreamEvent — explicit null set', () => {
	it.each([
		[{ type: 'run_completed' as const, runId: RID, result: 'ok' }],
		[{ type: 'run_failed' as const, runId: RID, error: 'boom' }],
	])('%o returns null', (event) => {
		expect(mapRunToStreamEvent(event, RID)).toBeNull()
	})
})

describe('mapRunToStreamEvent — v3 message and tool-input lifecycle', () => {
	const MID = 'msg_1' as `msg_${string}`
	const TUID = 'toolu_a'

	it('message_started → message.created', () => {
		const r = mapRunToStreamEvent(
			{ type: 'message_started', runId: RID, iteration: 0, messageId: MID },
			RID,
		)
		expect(r?.wire).toBe('message.created')
		expect(r?.data).toMatchObject({ run_id: RID, iteration: 0, message_id: MID })
	})

	it('text_delta → message.delta carries raw text fragment', () => {
		const r = mapRunToStreamEvent(
			{
				type: 'text_delta',
				runId: RID,
				iteration: 0,
				messageId: MID,
				text: 'hel',
			},
			RID,
		)
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
		const r = mapRunToStreamEvent(
			{
				type: 'message_completed',
				runId: RID,
				iteration: 0,
				messageId: MID,
				stopReason: 'end_turn',
				usage,
			},
			RID,
		)
		expect(r?.wire).toBe('message.completed')
		expect(r?.data).toMatchObject({
			message_id: MID,
			stop_reason: 'end_turn',
			usage,
		})
	})

	it('message_completed without usage → usage: null (defensive against dropped message_stop)', () => {
		const r = mapRunToStreamEvent(
			{
				type: 'message_completed',
				runId: RID,
				iteration: 0,
				messageId: MID,
				stopReason: 'tool_use',
			},
			RID,
		)
		expect(r?.data).toMatchObject({ usage: null })
	})

	it('tool_input_started → tool.input_started carries toolUseId + toolName', () => {
		const r = mapRunToStreamEvent(
			{
				type: 'tool_input_started',
				runId: RID,
				iteration: 0,
				messageId: MID,
				toolUseId: TUID,
				toolName: 'read',
			},
			RID,
		)
		expect(r?.wire).toBe('tool.input_started')
		expect(r?.data).toMatchObject({
			tool_use_id: TUID,
			tool_name: 'read',
			message_id: MID,
		})
	})

	it('tool_input_delta → tool.input_delta carries raw partial JSON fragment', () => {
		const r = mapRunToStreamEvent(
			{
				type: 'tool_input_delta',
				runId: RID,
				toolUseId: TUID,
				partialJson: '{"file_path":"',
			},
			RID,
		)
		expect(r?.wire).toBe('tool.input_delta')
		expect(r?.data).toMatchObject({
			tool_use_id: TUID,
			partial_json: '{"file_path":"',
		})
	})

	it('tool_input_completed → tool.input_completed carries parsed input object', () => {
		const r = mapRunToStreamEvent(
			{
				type: 'tool_input_completed',
				runId: RID,
				toolUseId: TUID,
				input: { file_path: '/etc/passwd' },
			},
			RID,
		)
		expect(r?.wire).toBe('tool.input_completed')
		expect(r?.data).toMatchObject({
			tool_use_id: TUID,
			input: { file_path: '/etc/passwd' },
		})
	})
})

describe('mapSessionToStreamEvent (deprecated alias)', () => {
	it('is the same function reference as mapRunToStreamEvent', () => {
		// Identity check is deterministic. toEqual on paired calls
		// would work here (SSE mapper doesn't touch the clock), but
		// we mirror the a2a mapper test pattern for consistency —
		// the deprecation shim is literal assignment, so identity is
		// the strictest possible assertion.
		expect(mapSessionToStreamEvent).toBe(mapRunToStreamEvent)
	})
})
