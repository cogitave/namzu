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
} from '../../types/ids/index.js'
import type { PlanId, PluginId, SandboxId } from '../../types/ids/index.js'
import type { RunEvent } from '../../types/run/events.js'
import { RUN_EVENT_SCHEMA_VERSION } from '../../types/run/schema-version.js'

/**
 * One fixture per `RunEvent` member, shared by every wire test.
 *
 * The load-bearing part is NOT any individual fixture. It is the type of
 * this map: `Record<RunEvent['type'], () => RunEvent>` means adding a
 * member to the union stops every wire test compiling until a fixture
 * exists — so a new event can neither reach a wire unexamined nor be left
 * off one silently.
 *
 * Shared rather than copied per wire. Two lists of fifty-one fixtures
 * drift, and the drift is invisible: each file still compiles, each still
 * passes, and the two wires are quietly tested against different events.
 *
 * Minimal by construction — required fields only, at their least
 * interesting values, with a fixed `new Date(0)`. A payload here is a
 * SHAPE, and filling it with plausible data would make reviewing a wire
 * change a review of the fixtures instead.
 */

export const FIXTURE_RUN_ID = '6b329af9-e3f1-48a6-b7d9-b65487ac303c' as RunId
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
	parentSessionId: '6236066f-d999-44cd-a338-a744d20baf0b' as SessionId,
	rootSessionId: '6236066f-d999-44cd-a338-a744d20baf0b' as SessionId,
	depth: 1,
}

const AGENT_RESULT = {
	runId: FIXTURE_RUN_ID,
	status: 'completed' as const,
	usage: USAGE,
	cost: COST,
	iterations: 1,
	durationMs: 0,
	messages: [],
}

export const RUN_EVENT_FIXTURES: Record<RunEvent['type'], () => RunEvent> = {
	hosted_tool: () => ({
		type: 'hosted_tool',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		tool: { id: 'search-1', name: 'web_search', status: 'completed' },
	}),
	tool_calls_admitted: () => ({
		type: 'tool_calls_admitted',
		runId: FIXTURE_RUN_ID,
		kind: 'batch',
		count: 1,
		used: 1,
		limit: 5,
	}),
	run_started: () => ({ type: 'run_started', runId: FIXTURE_RUN_ID }),
	iteration_started: () => ({
		type: 'iteration_started',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
	}),
	approval_policy_changed: () => ({
		type: 'approval_policy_changed',
		runId: FIXTURE_RUN_ID,
		from: 'operator-tui',
		to: 'auto-approve',
		reason: 'operator stepped away',
	}),
	request_envelope: () => ({
		type: 'request_envelope',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		model: 'x',
		systemPrompt: 'x',
		toolNames: [],
		toolSchemaDigest: 'x',
	}),
	iteration_completed: () => ({
		type: 'iteration_completed',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		hasToolCalls: true,
	}),
	compaction_shed: () => ({
		type: 'compaction_shed',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		messages: [],
		reason: 'threshold',
	}),
	compaction_completed: () => ({
		type: 'compaction_completed',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		messagesBefore: 1,
		messagesAfter: 1,
		tokensBefore: 1,
		tokensAfter: 1,
		measuredBy: 'provider',
		contextWindowTokens: 1,
		windowSource: 'config',
	}),
	background_job_exited: () => ({
		type: 'background_job_exited',
		runId: FIXTURE_RUN_ID,
		jobId: 'job_1',
		command: 'npm test',
		status: 'exited',
		exitCode: 0,
	}),
	memory_consolidated: () => ({
		type: 'memory_consolidated',
		runId: FIXTURE_RUN_ID,
		memoryId: 'aaca7ad3-d28c-4d6b-b455-53b07ebfb807',
		title: 'Learned: a fixture',
		decisions: 1,
		discoveries: 0,
		failures: 0,
	}),
	compaction_tool_results_cleared: () => ({
		type: 'compaction_tool_results_cleared',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		clearedCount: 1,
		charsReclaimed: 1,
		reclaimedTokens: 1,
		reliefWasEnough: true,
	}),
	compaction_failed: () => ({
		type: 'compaction_failed',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		cause: 'reducer_threw',
		messages: 1,
	}),
	tool_executing: () => ({
		type: 'tool_executing',
		runId: FIXTURE_RUN_ID,
		toolUseId: 'tu_wire' as ToolUseId,
		toolName: 'x',
		input: {},
	}),
	tool_progress: () => ({
		type: 'tool_progress',
		runId: FIXTURE_RUN_ID,
		toolUseId: 'tu_wire' as ToolUseId,
		toolName: 'x',
		message: 'x',
	}),
	provider_retry: () => ({
		type: 'provider_retry',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		attempt: 1,
		maxRetries: 1,
		delayMs: 1,
		code: 'x',
		serverDirected: true,
	}),
	provider_fallback: () => ({
		type: 'provider_fallback',
		runId: FIXTURE_RUN_ID,
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
		runId: FIXTURE_RUN_ID,
		toolUseId: 'tu_wire' as ToolUseId,
		toolName: 'x',
		result: 'x',
		isError: true,
	}),
	user_question_asked: () => ({
		type: 'user_question_asked',
		runId: FIXTURE_RUN_ID,
		checkpointId: '027e45d5-59a6-49ea-a81c-97d8cea3be4c' as CheckpointId,
		questionId: 'x',
		question: 'x',
	}),
	user_question_answered: () => ({
		type: 'user_question_answered',
		runId: FIXTURE_RUN_ID,
		checkpointId: '027e45d5-59a6-49ea-a81c-97d8cea3be4c' as CheckpointId,
		answered: true,
	}),
	tool_review_requested: () => ({
		type: 'tool_review_requested',
		runId: FIXTURE_RUN_ID,
		toolCalls: [],
		iteration: 1,
	}),
	tool_review_completed: () => ({
		type: 'tool_review_completed',
		runId: FIXTURE_RUN_ID,
		decision: 'approved',
	}),
	checkpoint_created: () => ({
		type: 'checkpoint_created',
		runId: FIXTURE_RUN_ID,
		checkpointId: '027e45d5-59a6-49ea-a81c-97d8cea3be4c' as CheckpointId,
		iteration: 1,
	}),
	run_paused: () => ({
		type: 'run_paused',
		runId: FIXTURE_RUN_ID,
		checkpointId: '027e45d5-59a6-49ea-a81c-97d8cea3be4c' as CheckpointId,
		reason: 'x',
	}),
	run_resuming: () => ({
		type: 'run_resuming',
		runId: FIXTURE_RUN_ID,
		fromCheckpointId: '027e45d5-59a6-49ea-a81c-97d8cea3be4c' as CheckpointId,
	}),
	guardrail_triggered: () => ({
		type: 'guardrail_triggered',
		runId: FIXTURE_RUN_ID,
		stage: 'input',
		action: 'block',
	}),
	run_completed: () => ({
		type: 'run_completed',
		runId: FIXTURE_RUN_ID,
		result: 'x',
	}),
	run_failed: () => ({
		type: 'run_failed',
		runId: FIXTURE_RUN_ID,
		error: 'x',
		id: 'x',
		message: 'x',
		hint: 'x',
	}),
	capability_warning: () => ({
		type: 'capability_warning',
		runId: FIXTURE_RUN_ID,
		capability: 'tools',
		providerId: 'x',
		message: 'x',
	}),
	message_history_repaired: () => ({
		type: 'message_history_repaired',
		runId: FIXTURE_RUN_ID,
		source: 'fresh-history',
		duplicateToolResultsRemoved: 1,
		orphanedToolResultsRemoved: 2,
		syntheticToolResultsInserted: 3,
	}),
	token_usage_updated: () => ({
		type: 'token_usage_updated',
		runId: FIXTURE_RUN_ID,
		usage: USAGE,
		cost: COST,
	}),
	activity_created: () => ({
		type: 'activity_created',
		runId: FIXTURE_RUN_ID,
		activityId: 'ca1aedb3-1a59-4e4a-80c1-596a9bc9609e' as ActivityId,
		activityType: 'tool_call',
		description: 'x',
	}),
	activity_updated: () => ({
		type: 'activity_updated',
		runId: FIXTURE_RUN_ID,
		activityId: 'ca1aedb3-1a59-4e4a-80c1-596a9bc9609e' as ActivityId,
		status: 'running',
	}),
	plan_ready: () => ({
		type: 'plan_ready',
		runId: FIXTURE_RUN_ID,
		planId: 'pln_wire' as PlanId,
		title: 'x',
		steps: [],
	}),
	plan_approved: () => ({
		type: 'plan_approved',
		runId: FIXTURE_RUN_ID,
		planId: 'pln_wire' as PlanId,
	}),
	plan_rejected: () => ({
		type: 'plan_rejected',
		runId: FIXTURE_RUN_ID,
		planId: 'pln_wire' as PlanId,
	}),
	plan_step_updated: () => ({
		type: 'plan_step_updated',
		runId: FIXTURE_RUN_ID,
		planId: 'pln_wire' as PlanId,
		stepId: 'x',
		status: 'completed',
	}),
	plan_completed: () => ({
		type: 'plan_completed',
		runId: FIXTURE_RUN_ID,
		planId: 'pln_wire' as PlanId,
	}),
	plan_failed: () => ({
		type: 'plan_failed',
		runId: FIXTURE_RUN_ID,
		planId: 'pln_wire' as PlanId,
	}),
	agent_pending: () => ({
		type: 'agent_pending',
		runId: FIXTURE_RUN_ID,
		taskId: 'tsk_wire' as TaskId,
		parentAgentId: 'x',
		childAgentId: 'x',
		depth: 1,
	}),
	agent_completed: () => ({
		type: 'agent_completed',
		runId: FIXTURE_RUN_ID,
		taskId: 'tsk_wire' as TaskId,
		result: AGENT_RESULT,
	}),
	agent_failed: () => ({
		type: 'agent_failed',
		runId: FIXTURE_RUN_ID,
		taskId: 'tsk_wire' as TaskId,
		error: 'x',
	}),
	agent_canceled: () => ({
		type: 'agent_canceled',
		runId: FIXTURE_RUN_ID,
		taskId: 'tsk_wire' as TaskId,
	}),
	task_created: () => ({
		type: 'task_created',
		runId: FIXTURE_RUN_ID,
		taskId: 'tsk_wire' as TaskId,
		subject: 'x',
		status: 'pending',
	}),
	task_updated: () => ({
		type: 'task_updated',
		runId: FIXTURE_RUN_ID,
		taskId: 'tsk_wire' as TaskId,
		subject: 'x',
		status: 'pending',
	}),
	plugin_hook_executing: () => ({
		type: 'plugin_hook_executing',
		runId: FIXTURE_RUN_ID,
		pluginId: '2b413dac-730d-4158-b1fd-3623065bfd85' as PluginId,
		hookEvent: 'run_start',
	}),
	plugin_hook_completed: () => ({
		type: 'plugin_hook_completed',
		runId: FIXTURE_RUN_ID,
		pluginId: '2b413dac-730d-4158-b1fd-3623065bfd85' as PluginId,
		hookEvent: 'run_start',
		result: { action: 'continue' },
	}),
	sandbox_created: () => ({
		type: 'sandbox_created',
		runId: FIXTURE_RUN_ID,
		sandboxId: '4c9dcaf9-303f-448b-87fc-55db01d0d284' as SandboxId,
		environment: 'x',
	}),
	sandbox_exec: () => ({
		type: 'sandbox_exec',
		runId: FIXTURE_RUN_ID,
		sandboxId: '4c9dcaf9-303f-448b-87fc-55db01d0d284' as SandboxId,
		command: 'x',
		exitCode: 1,
		durationMs: 1,
	}),
	sandbox_destroyed: () => ({
		type: 'sandbox_destroyed',
		runId: FIXTURE_RUN_ID,
		sandboxId: '4c9dcaf9-303f-448b-87fc-55db01d0d284' as SandboxId,
	}),
	message_started: () => ({
		type: 'message_started',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		messageId: '39ae8e96-8dfb-45f1-a24e-3d61b152497b' as MessageId,
	}),
	reasoning_started: () => ({
		type: 'reasoning_started',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		messageId: '39ae8e96-8dfb-45f1-a24e-3d61b152497b' as MessageId,
		blockIndex: 1,
		reasoningType: 'thinking',
	}),
	reasoning_delta: () => ({
		type: 'reasoning_delta',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		messageId: '39ae8e96-8dfb-45f1-a24e-3d61b152497b' as MessageId,
		blockIndex: 1,
		text: 'x',
	}),
	reasoning_completed: () => ({
		type: 'reasoning_completed',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		messageId: '39ae8e96-8dfb-45f1-a24e-3d61b152497b' as MessageId,
		blockIndex: 1,
		signed: true,
	}),
	text_delta: () => ({
		type: 'text_delta',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		messageId: '39ae8e96-8dfb-45f1-a24e-3d61b152497b' as MessageId,
		text: 'x',
	}),
	message_completed: () => ({
		type: 'message_completed',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		messageId: '39ae8e96-8dfb-45f1-a24e-3d61b152497b' as MessageId,
		stopReason: 'end_turn',
	}),
	tool_input_started: () => ({
		type: 'tool_input_started',
		runId: FIXTURE_RUN_ID,
		iteration: 1,
		messageId: '39ae8e96-8dfb-45f1-a24e-3d61b152497b' as MessageId,
		toolUseId: 'tu_wire' as ToolUseId,
		toolName: 'x',
	}),
	tool_input_delta: () => ({
		type: 'tool_input_delta',
		runId: FIXTURE_RUN_ID,
		toolUseId: 'tu_wire' as ToolUseId,
		partialJson: 'x',
	}),
	tool_input_completed: () => ({
		type: 'tool_input_completed',
		runId: FIXTURE_RUN_ID,
		toolUseId: 'tu_wire' as ToolUseId,
		input: {},
	}),
	// The three the crude scan missed and the Record type did not. They are
	// intersected into `RunEvent` separately because they carry no `seq` —
	// emitted straight to a host's listener, never into a run's durable log.
	subsession_spawned: () => ({
		type: 'subsession_spawned',
		runId: FIXTURE_RUN_ID,
		subSessionId: 'fb4a9e32-99e6-4139-98ac-b4de03504eda' as SubSessionId,
		parentSessionId: '6236066f-d999-44cd-a338-a744d20baf0b' as SessionId,
		spawnedBy: {
			kind: 'agent',
			agentId: '17e40896-6845-45bc-82e4-584ca3823ff6' as AgentId,
			tenantId: '59238230-027a-4fd4-a378-9b85e37b3ec0' as TenantId,
		},
		lineage: LINEAGE,
		schemaVersion: RUN_EVENT_SCHEMA_VERSION,
		at: AT,
	}),
	subsession_messaged: () => ({
		type: 'subsession_messaged',
		runId: FIXTURE_RUN_ID,
		subSessionId: 'fb4a9e32-99e6-4139-98ac-b4de03504eda' as SubSessionId,
		parentSessionId: '6236066f-d999-44cd-a338-a744d20baf0b' as SessionId,
		messageId: '39ae8e96-8dfb-45f1-a24e-3d61b152497b' as MessageId,
		lineage: LINEAGE,
		schemaVersion: RUN_EVENT_SCHEMA_VERSION,
		at: AT,
	}),
	subsession_idled: () => ({
		type: 'subsession_idled',
		runId: FIXTURE_RUN_ID,
		subSessionId: 'fb4a9e32-99e6-4139-98ac-b4de03504eda' as SubSessionId,
		parentSessionId: '6236066f-d999-44cd-a338-a744d20baf0b' as SessionId,
		lineage: LINEAGE,
		schemaVersion: RUN_EVENT_SCHEMA_VERSION,
		at: AT,
	}),
}
