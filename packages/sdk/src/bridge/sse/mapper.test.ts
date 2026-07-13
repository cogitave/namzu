/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `mapRunToStreamEvent(event)` returns `{wire, data}` or null.
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
 *   - `data.run_id` is the EVENT's own `runId` (ses_017 P3, 2026-07-12). The
 *     function used to take a second `runId` argument and stamp THAT onto every
 *     event, discarding `event.runId`; the substitution hid the fact that the
 *     API and the SDK minted different ids for one run. No remapping now.
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
		const r = mapRunToStreamEvent({ type: 'run_started', runId: RID, systemPrompt: 'be terse' })
		expect(r?.wire).toBe('run.started')
		expect(r?.data).toMatchObject({ run_id: RID, system_prompt: 'be terse' })
	})

	it('run_started with no systemPrompt → system_prompt: null', () => {
		const r = mapRunToStreamEvent({ type: 'run_started', runId: RID })
		expect(r?.data).toMatchObject({ system_prompt: null })
	})

	it('iteration_started / iteration_completed carry iteration number', () => {
		const a = mapRunToStreamEvent({ type: 'iteration_started', runId: RID, iteration: 2 })
		expect(a).toEqual({ wire: 'iteration.started', data: { run_id: RID, iteration: 2 } })

		const b = mapRunToStreamEvent({
			type: 'iteration_completed',
			runId: RID,
			iteration: 2,
			hasToolCalls: false,
		})
		expect(b).toEqual({ wire: 'iteration.completed', data: { run_id: RID, iteration: 2 } })
	})

	it('llm_response → message.delta with content + has_tool_calls', () => {
		const r = mapRunToStreamEvent({
			type: 'llm_response',
			runId: RID,
			content: 'hi',
			hasToolCalls: false,
		})
		expect(r).toEqual({
			wire: 'message.delta',
			data: { run_id: RID, content: 'hi', has_tool_calls: false },
		})
	})

	it('llm_response with null content → content: null', () => {
		const r = mapRunToStreamEvent({
			type: 'llm_response',
			runId: RID,
			content: null,
			hasToolCalls: true,
		})
		expect(r?.data).toMatchObject({ content: null, has_tool_calls: true })
	})

	it('tool_executing / tool_completed carry tool_name + input/result', () => {
		const exec = mapRunToStreamEvent({
			type: 'tool_executing',
			runId: RID,
			toolName: 'read_file',
			input: { path: '/a' },
		})
		expect(exec?.wire).toBe('tool.executing')
		expect(exec?.data).toMatchObject({ tool_name: 'read_file', input: { path: '/a' } })

		const done = mapRunToStreamEvent({
			type: 'tool_completed',
			runId: RID,
			toolName: 'read_file',
			result: 'ok',
		})
		expect(done?.wire).toBe('tool.completed')
		expect(done?.data).toMatchObject({ tool_name: 'read_file', result: 'ok' })
	})

	it('tool_review_requested / tool_review_completed carry review fields', () => {
		const a = mapRunToStreamEvent({
			type: 'tool_review_requested',
			runId: RID,
			requestId: 'dreq_test',
			checkpointId: 'cp_test',
			iteration: 1,
			toolCalls: [{ id: 'tc1', name: 'write_file', input: {}, isDestructive: true }],
		})
		expect(a?.wire).toBe('review.requested')
		expect(a?.data.iteration).toBe(1)

		const b = mapRunToStreamEvent({
			type: 'tool_review_completed',
			runId: RID,
			decision: 'modified',
		})
		expect(b).toEqual({ wire: 'review.completed', data: { run_id: RID, decision: 'modified' } })
	})

	it('checkpoint_created → checkpoint.created', () => {
		const r = mapRunToStreamEvent({
			type: 'checkpoint_created',
			runId: RID,
			checkpointId: 'ckpt_1' as CheckpointId,
			iteration: 1,
		})
		expect(r?.wire).toBe('checkpoint.created')
		expect(r?.data).toMatchObject({ checkpoint_id: 'ckpt_1', iteration: 1 })
	})

	it('run_paused / run_resuming carry checkpoint fields', () => {
		const p = mapRunToStreamEvent({
			type: 'run_paused',
			runId: RID,
			checkpointId: 'ckpt_2' as CheckpointId,
			reason: 'input required',
		})
		expect(p?.wire).toBe('run.paused')
		expect(p?.data).toMatchObject({ checkpoint_id: 'ckpt_2', reason: 'input required' })

		const r = mapRunToStreamEvent({
			type: 'run_resuming',
			runId: RID,
			fromCheckpointId: 'ckpt_2' as CheckpointId,
		})
		expect(r).toEqual({
			wire: 'run.resuming',
			data: { run_id: RID, from_checkpoint_id: 'ckpt_2' },
		})
	})

	it('plan_* events carry plan_id', () => {
		const ready = mapRunToStreamEvent({
			type: 'plan_ready',
			runId: RID,
			planId: 'plan_1' as PlanId,
			title: 't',
			summary: 's',
			steps: [],
		})
		expect(ready?.wire).toBe('plan.ready')

		expect(
			mapRunToStreamEvent({ type: 'plan_approved', runId: RID, planId: 'plan_1' as PlanId })?.wire,
		).toBe('plan.approved')

		expect(
			mapRunToStreamEvent({
				type: 'plan_rejected',
				runId: RID,
				planId: 'plan_1' as PlanId,
				reason: 'nope',
			})?.wire,
		).toBe('plan.rejected')

		expect(
			mapRunToStreamEvent({
				type: 'plan_step_updated',
				runId: RID,
				planId: 'plan_1' as PlanId,
				stepId: 's1',
				status: 'completed',
			})?.wire,
		).toBe('plan.step_updated')
	})

	it('agent_* events carry task_id', () => {
		const pending = mapRunToStreamEvent({
			type: 'agent_pending',
			runId: RID,
			taskId: 'task_1' as TaskId,
			parentAgentId: 'a',
			childAgentId: 'b',
			depth: 1,
		})
		expect(pending?.wire).toBe('agent.pending')
		expect(pending?.data).toMatchObject({ task_id: 'task_1', depth: 1 })

		expect(
			mapRunToStreamEvent({
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
			})?.wire,
		).toBe('agent.completed')

		expect(
			mapRunToStreamEvent({
				type: 'agent_failed',
				runId: RID,
				taskId: 'task_1' as TaskId,
				error: 'e',
			})?.wire,
		).toBe('agent.failed')

		expect(
			mapRunToStreamEvent({ type: 'agent_canceled', runId: RID, taskId: 'task_1' as TaskId })?.wire,
		).toBe('agent.canceled')
	})

	it('task_created / task_updated map cleanly', () => {
		const a = mapRunToStreamEvent({
			type: 'task_created',
			runId: RID,
			taskId: 'task_1' as TaskId,
			subject: 's',
			status: 'pending',
		})
		expect(a?.wire).toBe('task.created')

		const b = mapRunToStreamEvent({
			type: 'task_updated',
			runId: RID,
			taskId: 'task_1' as TaskId,
			subject: 's',
			status: 'completed',
		})
		expect(b?.wire).toBe('task.updated')
		expect(b?.data.owner).toBe(null) // undefined owner → null
	})

	it('plugin_hook_* + sandbox_* + activity_* events map cleanly', () => {
		expect(
			mapRunToStreamEvent({
				type: 'plugin_hook_executing',
				runId: RID,
				pluginId: 'plugin_x' as PluginId,
				hookEvent: 'pre_tool_use',
			})?.wire,
		).toBe('plugin.hook_executing')

		expect(
			mapRunToStreamEvent({
				type: 'plugin_hook_completed',
				runId: RID,
				pluginId: 'plugin_x' as PluginId,
				hookEvent: 'pre_tool_use',
				result: { action: 'continue' },
			})?.wire,
		).toBe('plugin.hook_completed')

		expect(
			mapRunToStreamEvent({
				type: 'sandbox_created',
				runId: RID,
				sandboxId: 'sbx_1' as SandboxId,
				environment: 'basic',
			})?.wire,
		).toBe('sandbox.created')

		expect(
			mapRunToStreamEvent({
				type: 'sandbox_exec',
				runId: RID,
				sandboxId: 'sbx_1' as SandboxId,
				command: 'ls',
				exitCode: 0,
				durationMs: 10,
			})?.wire,
		).toBe('sandbox.exec')

		expect(
			mapRunToStreamEvent({
				type: 'sandbox_destroyed',
				runId: RID,
				sandboxId: 'sbx_1' as SandboxId,
			})?.wire,
		).toBe('sandbox.destroyed')

		expect(
			mapRunToStreamEvent({
				type: 'activity_created',
				runId: RID,
				activityId: 'act_1' as ActivityId,
				activityType: 'tool_call',
				description: 'd',
			})?.wire,
		).toBe('activity.created')

		expect(
			mapRunToStreamEvent({
				type: 'activity_updated',
				runId: RID,
				activityId: 'act_1' as ActivityId,
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
		}
		const r = mapRunToStreamEvent({ type: 'token_usage_updated', runId: RID, usage, cost })
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
		const r = mapRunToStreamEvent(event)
		expect(r?.data).toMatchObject({ source_agent_id: 'sub_agent_1', parent_task_id: 'task_42' })
	})
})

describe('mapRunToStreamEvent — explicit null set', () => {
	it.each([
		[{ type: 'run_completed' as const, runId: RID, result: 'ok' }],
		[{ type: 'run_failed' as const, runId: RID, error: 'boom' }],
	])('%o returns null', (event) => {
		expect(mapRunToStreamEvent(event)).toBeNull()
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

/**
 * Current-code invariants asserted (2026-07-12, ses_017 P3):
 *
 *   - Every mapped variant puts the EVENT's own `runId` on `data.run_id`.
 *     There is no second argument and no substitution: the mapper cannot
 *     relabel an event as belonging to a different run.
 *   - A sub-agent's event keeps the CHILD's run id (it does not get rewritten
 *     to the parent's) even though it arrives on the parent's listener.
 */
describe('mapRunToStreamEvent — run_id comes off the event (ses_017 P3)', () => {
	const CHILD = 'run_child' as RunId

	it('every mapped variant reports the event‑borne runId', () => {
		const events: RunEvent[] = [
			{ type: 'run_started', runId: CHILD },
			{ type: 'iteration_started', runId: CHILD, iteration: 1 },
			{ type: 'llm_response', runId: CHILD, content: 'hi', hasToolCalls: false },
			{ type: 'tool_executing', runId: CHILD, toolName: 'read_file', input: {} },
			{
				type: 'checkpoint_created',
				runId: CHILD,
				checkpointId: 'cp_1' as CheckpointId,
				iteration: 1,
			},
			{ type: 'run_paused', runId: CHILD, checkpointId: 'cp_1' as CheckpointId, reason: 'review' },
		]

		for (const event of events) {
			const mapped = mapRunToStreamEvent(event)
			expect(mapped, `${event.type} must map`).not.toBeNull()
			expect(mapped?.data.run_id, `${event.type} must carry its own runId`).toBe(CHILD)
		}
	})

	it("a child's event is not relabelled as the parent's run", () => {
		// This is the shape that reaches an SSE listener from a spawned sub-agent:
		// the child's own runId, stamped with lineage. Before P3 the mapper
		// overwrote run_id with the PARENT's id, so a client could not tell the
		// two runs apart — and the parent/child split was invisible.
		const childEvent: RunEvent = {
			type: 'tool_completed',
			runId: CHILD,
			toolName: 'write_file',
			result: 'ok',
			schemaVersion: 2,
		}

		const mapped = mapRunToStreamEvent(childEvent)

		expect(mapped?.data.run_id).toBe(CHILD)
		expect(mapped?.data.run_id).not.toBe(RID)
	})
})

/**
 * Current-code invariants asserted (2026-07-13, ses_017):
 *
 *   - `run_cancelled` maps to the `run.cancelled` wire event, carrying the run's
 *     own id. It is NOT in the null set: `run_completed` / `run_failed` are null
 *     because the HOST emits those terminals from the finished Run (with usage,
 *     iterations, duration — none of which this mapper can see), while a
 *     cancellation's whole payload is the run id. `run.cancelled` had been in
 *     `StreamEventType` from the start with nothing emitting it.
 *   - No cancelled run can reach `run.completed` through this mapper, because the
 *     kernel no longer emits `run_completed` for one (ses_017 P4).
 */
describe('a cancelled run on the SSE wire', () => {
	it('run_cancelled → run.cancelled, carrying the run id', () => {
		const mapped = mapRunToStreamEvent({ type: 'run_cancelled', runId: RID })

		expect(mapped).toEqual({ wire: 'run.cancelled', data: { run_id: RID } })
	})

	it('is not in the null set, and is not run.completed', () => {
		const mapped = mapRunToStreamEvent({ type: 'run_cancelled', runId: RID })

		// Both halves are load-bearing. A null here would be the "the host emits the
		// terminals" reflex applied to the one terminal the host cannot reconstruct from
		// the Run's shape, and it would leave the SSE bridge silent about a cancellation
		// — which is the same absence of truth as saying "completed", one layer down.
		expect(mapped).not.toBeNull()
		expect(mapped?.wire).not.toBe('run.completed')
		expect(mapped?.wire).not.toBe('run.failed')
	})
})
