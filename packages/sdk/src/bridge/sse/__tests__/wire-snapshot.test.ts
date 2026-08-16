import { describe, expect, it } from 'vitest'

import type {
	ActivityId,
	AgentId,
	CheckpointId,
	MessageId,
	RunId,
	SessionId,
	SubSessionId,
	TaskId,
	TenantId,
	ToolUseId,
} from '../../../types/ids/index.js'
import type { PlanId, PluginId, SandboxId } from '../../../types/ids/index.js'
import type { RunEvent } from '../../../types/run/events.js'
import { RUN_EVENT_SCHEMA_VERSION } from '../../../types/run/schema-version.js'
import { mapRunToStreamEvent } from '../mapper.js'

/**
 * The SSE wire, pinned by shape rather than by memory.
 *
 * Coverage here was a 27-line hand-maintained doc comment listing the
 * expected wire names, plus hand-written assertions for the events
 * somebody thought to write one for. A mapper could rename `run_id` to
 * `runId`, or drop a field from a payload, and nothing would notice unless
 * that event happened to be one of the few with an assertion.
 *
 * The load-bearing part is NOT the snapshot. It is the type of `FIXTURES`:
 * `Record<RunEvent['type'], ...>` means adding a member to the union stops
 * this file compiling until somebody writes a fixture for it — so a new
 * event cannot reach the wire unexamined, and cannot be omitted from the
 * wire silently either.
 *
 * The fixtures are minimal by construction: required fields only, at their
 * least interesting values. A payload here is a SHAPE, and filling it with
 * plausible-looking data would make a review of the snapshot a review of
 * the fixture instead.
 */

const RID = 'run_wire' as RunId
/** Fixed, so a snapshot is a record of shape and not of the clock. */
const AT = new Date(0)
/** Zeroed, for the same reason the date is fixed: a shape, not a reading. */
const USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
const COST = {
	inputCostPer1M: 0,
	outputCostPer1M: 0,
	totalCost: 0,
	cacheDiscount: 0,
	unpricedTokens: 0,
}
const LINEAGE = {
	parentSessionId: 'ses_wire' as SessionId,
	rootSessionId: 'ses_wire' as SessionId,
	depth: 1,
}

const AGENT_RESULT = {
	runId: RID,
	status: 'completed' as const,
	usage: USAGE,
	cost: COST,
	iterations: 1,
	durationMs: 0,
	messages: [],
}

const FIXTURES: Record<RunEvent['type'], () => RunEvent> = {
	run_started: () => ({ type: 'run_started', runId: RID }),
	iteration_started: () => ({ type: 'iteration_started', runId: RID, iteration: 1 }),
	iteration_completed: () => ({
		type: 'iteration_completed',
		runId: RID,
		iteration: 1,
		hasToolCalls: true,
	}),
	compaction_completed: () => ({
		type: 'compaction_completed',
		runId: RID,
		iteration: 1,
		messagesBefore: 1,
		messagesAfter: 1,
		tokensBefore: 1,
		tokensAfter: 1,
		measuredBy: 'provider',
		contextWindowTokens: 1,
		windowSource: 'config',
	}),
	compaction_tool_results_cleared: () => ({
		type: 'compaction_tool_results_cleared',
		runId: RID,
		iteration: 1,
		clearedCount: 1,
		charsReclaimed: 1,
		reclaimedTokens: 1,
		reliefWasEnough: true,
	}),
	compaction_failed: () => ({
		type: 'compaction_failed',
		runId: RID,
		iteration: 1,
		cause: 'reducer_threw',
		messages: 1,
	}),
	tool_executing: () => ({
		type: 'tool_executing',
		runId: RID,
		toolUseId: 'tu_wire' as ToolUseId,
		toolName: 'x',
		input: {},
	}),
	tool_progress: () => ({
		type: 'tool_progress',
		runId: RID,
		toolUseId: 'tu_wire' as ToolUseId,
		toolName: 'x',
		message: 'x',
	}),
	provider_retry: () => ({
		type: 'provider_retry',
		runId: RID,
		iteration: 1,
		attempt: 1,
		maxRetries: 1,
		delayMs: 1,
		code: 'x',
		serverDirected: true,
	}),
	provider_fallback: () => ({
		type: 'provider_fallback',
		runId: RID,
		iteration: 1,
		fromIndex: 1,
		fromProviderId: 'x',
		toIndex: 1,
		toProviderId: 'x',
		code: 'x',
		reason: 'x',
	}),
	tool_completed: () => ({
		type: 'tool_completed',
		runId: RID,
		toolUseId: 'tu_wire' as ToolUseId,
		toolName: 'x',
		result: 'x',
		isError: true,
	}),
	user_question_asked: () => ({
		type: 'user_question_asked',
		runId: RID,
		checkpointId: 'cp_wire' as CheckpointId,
		questionId: 'x',
		question: 'x',
	}),
	user_question_answered: () => ({
		type: 'user_question_answered',
		runId: RID,
		checkpointId: 'cp_wire' as CheckpointId,
		answered: true,
	}),
	tool_review_requested: () => ({
		type: 'tool_review_requested',
		runId: RID,
		toolCalls: [],
		iteration: 1,
	}),
	tool_review_completed: () => ({
		type: 'tool_review_completed',
		runId: RID,
		decision: 'approved',
	}),
	checkpoint_created: () => ({
		type: 'checkpoint_created',
		runId: RID,
		checkpointId: 'cp_wire' as CheckpointId,
		iteration: 1,
	}),
	run_paused: () => ({
		type: 'run_paused',
		runId: RID,
		checkpointId: 'cp_wire' as CheckpointId,
		reason: 'x',
	}),
	run_resuming: () => ({
		type: 'run_resuming',
		runId: RID,
		fromCheckpointId: 'cp_wire' as CheckpointId,
	}),
	guardrail_triggered: () => ({
		type: 'guardrail_triggered',
		runId: RID,
		stage: 'input',
		action: 'block',
	}),
	run_completed: () => ({ type: 'run_completed', runId: RID, result: 'x' }),
	run_failed: () => ({
		type: 'run_failed',
		runId: RID,
		error: 'x',
		id: 'x',
		message: 'x',
		hint: 'x',
	}),
	capability_warning: () => ({
		type: 'capability_warning',
		runId: RID,
		capability: 'tools',
		providerId: 'x',
		message: 'x',
	}),
	token_usage_updated: () => ({
		type: 'token_usage_updated',
		runId: RID,
		usage: USAGE,
		cost: COST,
	}),
	activity_created: () => ({
		type: 'activity_created',
		runId: RID,
		activityId: 'act_wire' as ActivityId,
		activityType: 'tool_call',
		description: 'x',
	}),
	activity_updated: () => ({
		type: 'activity_updated',
		runId: RID,
		activityId: 'act_wire' as ActivityId,
		status: 'running',
	}),
	plan_ready: () => ({
		type: 'plan_ready',
		runId: RID,
		planId: 'pln_wire' as PlanId,
		title: 'x',
		steps: [],
	}),
	plan_approved: () => ({ type: 'plan_approved', runId: RID, planId: 'pln_wire' as PlanId }),
	plan_rejected: () => ({ type: 'plan_rejected', runId: RID, planId: 'pln_wire' as PlanId }),
	plan_step_updated: () => ({
		type: 'plan_step_updated',
		runId: RID,
		planId: 'pln_wire' as PlanId,
		stepId: 'x',
		status: 'completed',
	}),
	plan_completed: () => ({ type: 'plan_completed', runId: RID, planId: 'pln_wire' as PlanId }),
	plan_failed: () => ({ type: 'plan_failed', runId: RID, planId: 'pln_wire' as PlanId }),
	agent_pending: () => ({
		type: 'agent_pending',
		runId: RID,
		taskId: 'tsk_wire' as TaskId,
		parentAgentId: 'x',
		childAgentId: 'x',
		depth: 1,
	}),
	agent_completed: () => ({
		type: 'agent_completed',
		runId: RID,
		taskId: 'tsk_wire' as TaskId,
		result: AGENT_RESULT,
	}),
	agent_failed: () => ({
		type: 'agent_failed',
		runId: RID,
		taskId: 'tsk_wire' as TaskId,
		error: 'x',
	}),
	agent_canceled: () => ({ type: 'agent_canceled', runId: RID, taskId: 'tsk_wire' as TaskId }),
	task_created: () => ({
		type: 'task_created',
		runId: RID,
		taskId: 'tsk_wire' as TaskId,
		subject: 'x',
		status: 'pending',
	}),
	task_updated: () => ({
		type: 'task_updated',
		runId: RID,
		taskId: 'tsk_wire' as TaskId,
		subject: 'x',
		status: 'pending',
	}),
	plugin_hook_executing: () => ({
		type: 'plugin_hook_executing',
		runId: RID,
		pluginId: 'plg_wire' as PluginId,
		hookEvent: 'run_start',
	}),
	plugin_hook_completed: () => ({
		type: 'plugin_hook_completed',
		runId: RID,
		pluginId: 'plg_wire' as PluginId,
		hookEvent: 'run_start',
		result: { action: 'continue' },
	}),
	sandbox_created: () => ({
		type: 'sandbox_created',
		runId: RID,
		sandboxId: 'sbx_wire' as SandboxId,
		environment: 'x',
	}),
	sandbox_exec: () => ({
		type: 'sandbox_exec',
		runId: RID,
		sandboxId: 'sbx_wire' as SandboxId,
		command: 'x',
		exitCode: 1,
		durationMs: 1,
	}),
	sandbox_destroyed: () => ({
		type: 'sandbox_destroyed',
		runId: RID,
		sandboxId: 'sbx_wire' as SandboxId,
	}),
	message_started: () => ({
		type: 'message_started',
		runId: RID,
		iteration: 1,
		messageId: 'msg_wire' as MessageId,
	}),
	reasoning_started: () => ({
		type: 'reasoning_started',
		runId: RID,
		iteration: 1,
		messageId: 'msg_wire' as MessageId,
		blockIndex: 1,
		reasoningType: 'thinking',
	}),
	reasoning_delta: () => ({
		type: 'reasoning_delta',
		runId: RID,
		iteration: 1,
		messageId: 'msg_wire' as MessageId,
		blockIndex: 1,
		text: 'x',
	}),
	reasoning_completed: () => ({
		type: 'reasoning_completed',
		runId: RID,
		iteration: 1,
		messageId: 'msg_wire' as MessageId,
		blockIndex: 1,
		signed: true,
	}),
	text_delta: () => ({
		type: 'text_delta',
		runId: RID,
		iteration: 1,
		messageId: 'msg_wire' as MessageId,
		text: 'x',
	}),
	message_completed: () => ({
		type: 'message_completed',
		runId: RID,
		iteration: 1,
		messageId: 'msg_wire' as MessageId,
		stopReason: 'end_turn',
	}),
	tool_input_started: () => ({
		type: 'tool_input_started',
		runId: RID,
		iteration: 1,
		messageId: 'msg_wire' as MessageId,
		toolUseId: 'tu_wire' as ToolUseId,
		toolName: 'x',
	}),
	tool_input_delta: () => ({
		type: 'tool_input_delta',
		runId: RID,
		toolUseId: 'tu_wire' as ToolUseId,
		partialJson: 'x',
	}),
	tool_input_completed: () => ({
		type: 'tool_input_completed',
		runId: RID,
		toolUseId: 'tu_wire' as ToolUseId,
		input: {},
	}),
	// The three the crude scan missed and the Record type did not. They are
	// intersected into `RunEvent` separately because they carry no `seq` —
	// emitted straight to a host's listener, never into a run's durable log.
	subsession_spawned: () => ({
		type: 'subsession_spawned',
		runId: RID,
		subSessionId: 'sub_wire' as SubSessionId,
		parentSessionId: 'ses_wire' as SessionId,
		spawnedBy: { kind: 'agent', agentId: 'agt_wire' as AgentId, tenantId: 'tnt_wire' as TenantId },
		lineage: LINEAGE,
		schemaVersion: RUN_EVENT_SCHEMA_VERSION,
		at: AT,
	}),
	subsession_messaged: () => ({
		type: 'subsession_messaged',
		runId: RID,
		subSessionId: 'sub_wire' as SubSessionId,
		parentSessionId: 'ses_wire' as SessionId,
		messageId: 'msg_wire' as MessageId,
		lineage: LINEAGE,
		schemaVersion: RUN_EVENT_SCHEMA_VERSION,
		at: AT,
	}),
	subsession_idled: () => ({
		type: 'subsession_idled',
		runId: RID,
		subSessionId: 'sub_wire' as SubSessionId,
		parentSessionId: 'ses_wire' as SessionId,
		lineage: LINEAGE,
		schemaVersion: RUN_EVENT_SCHEMA_VERSION,
		at: AT,
	}),
}

describe('every RunEvent has a decided place on the SSE wire', () => {
	it('maps or declines each one, and never throws', () => {
		// The exhaustiveness half. A member added to the union without a
		// mapper entry fails `tsc` at the mapper's own table; a member added
		// WITH one but never exercised reaches the wire untested, which is
		// what this closes.
		for (const [type, build] of Object.entries(FIXTURES)) {
			expect(() => mapRunToStreamEvent(build(), RID), type).not.toThrow()
		}
	})

	it('pins the wire name and payload keys of everything it maps', () => {
		// Keys, not values: values are fixture artefacts, and asserting them
		// would make this snapshot a record of what the fixtures happen to
		// say. Keys are the contract a consumer parses.
		const shape: Record<string, { wire: string; keys: string[] } | null> = {}
		for (const [type, build] of Object.entries(FIXTURES)) {
			const mapped = mapRunToStreamEvent(build(), RID)
			shape[type] = mapped
				? { wire: mapped.wire, keys: Object.keys(mapped.data as object).sort() }
				: null
		}

		expect(shape).toMatchSnapshot()
	})

	it('declines nothing by accident: every null is a decision with a name', () => {
		// A `null` from the mapper means "this runtime's business, not the
		// wire's". Listed explicitly so ADDING one shows up in review — an
		// event silently dropped from the wire looks exactly like an event
		// nobody has needed yet.
		const declined = Object.entries(FIXTURES)
			.filter(([, build]) => mapRunToStreamEvent(build(), RID) === null)
			.map(([type]) => type)
			.sort()

		expect(declined).toMatchSnapshot()
	})
})
