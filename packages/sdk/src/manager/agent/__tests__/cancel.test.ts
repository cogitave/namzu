// Current-code invariants asserted (2026-07-12, ses_017 P4):
// - A child stopped by the PARENT's abort cascade is recorded `canceled`, not
//   `completed`. Only the explicit `cancel(taskId)` path used to reach
//   `markCanceled`; a child that came back from its own run with
//   `status: 'cancelled'` fell through to `markCompleted`, so the parent was told
//   its child had FINISHED and `agent_completed` — not `agent_canceled` — went out
//   on the run stream.
// - `dispose()` actually cancels the tasks that are still running. It called
//   `cancelAll('' as RunId)`, and `cancelAll` filters by
//   `context.parentRunId === parentRunId` — no task has an empty parent run id, so
//   dispose cancelled NOTHING and dropped its instance map with every child still
//   executing.
// - The child's abort signal is the parent's, derived: aborting the parent's
//   controller aborts the child's `AgentInput.signal` (pre-existing wiring via
//   `createChildAbortController`; asserted here because P4's supervisor change is
//   what finally puts a live per-run controller at the top of that chain).
import { describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryThreadStore } from '../../../store/thread/memory.js'
import type {
	AgentCapabilities,
	AgentInput,
	AgentMetadata,
	BaseAgentConfig,
	BaseAgentResult,
} from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext, SendMessageOptions } from '../../../types/agent/task.js'
import type { AgentId, RunId, SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import type { RunEvent } from '../../../types/run/events.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { ProjectId, SummaryId, ThreadId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { ThreadManager } from '../../thread/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

const tenant = 'tnt_alpha' as TenantId

const capabilities: AgentCapabilities = {
	supportsTools: false,
	supportsStreaming: false,
	supportsConcurrency: false,
	supportsSubAgents: false,
}

function user(): ActorRef {
	return { kind: 'user', userId: 'usr_root' as UserId, tenantId: tenant }
}

/**
 * A child that behaves like a real agent under cancellation: it watches the
 * `AgentInput.signal` the manager hands it and, when that aborts, ENDS with
 * `status: 'cancelled'` (it does not throw — that is what `runLoop` does).
 */
class CancellableChild implements Agent<BaseAgentConfig, BaseAgentResult> {
	readonly type = 'reactive' as const
	readonly metadata: AgentMetadata
	/** The signal the manager handed this child. */
	signal?: AbortSignal
	/** Resolves once the child's run has started. */
	readonly entered: Promise<void>
	private enteredResolve!: () => void

	constructor(id: string) {
		this.metadata = {
			type: 'reactive',
			id,
			name: id,
			version: '1.0.0',
			category: 'test',
			description: id,
			capabilities,
		}
		this.entered = new Promise<void>((r) => {
			this.enteredResolve = r
		})
	}

	async run(input: AgentInput): Promise<BaseAgentResult> {
		this.signal = input.signal
		this.enteredResolve()

		await new Promise<void>((resolve) => {
			if (input.signal?.aborted) return resolve()
			input.signal?.addEventListener('abort', () => resolve(), { once: true })
		})

		return {
			runId: 'run_child' as RunId,
			status: 'cancelled',
			stopReason: 'cancelled',
			usage: { ...EMPTY_TOKEN_USAGE },
			cost: { ...ZERO_COST },
			iterations: 0,
			durationMs: 1,
			messages: [],
		}
	}

	async cancel(): Promise<void> {}
	getCapabilities(): AgentCapabilities {
		return capabilities
	}
}

function makeDefinition(agent: Agent<BaseAgentConfig, BaseAgentResult>): AgentDefinition {
	return {
		info: {
			id: agent.metadata.id,
			name: agent.metadata.name,
			version: agent.metadata.version,
			category: agent.metadata.category,
			description: agent.metadata.description,
			tools: [],
			defaults: { model: 'test', tokenBudget: 1_000 },
		},
		typedAgent: agent,
	}
}

interface Harness {
	manager: AgentManager
	context: AgentTaskContext
	options: SendMessageOptions
	events: RunEvent[]
}

async function buildHarness(child: Agent<BaseAgentConfig, BaseAgentResult>): Promise<Harness> {
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryThreadStore()
	const threadManager = new ThreadManager({ threadStore, sessionStore: store })
	const project = await store.createProject({ tenantId: tenant, name: 'p1' }, tenant)
	const thread = await threadStore.createThread(
		{ projectId: project.id, title: 'cancel-test' },
		tenant,
	)
	const parentSession = await store.createSession(
		{ threadId: thread.id, projectId: project.id, currentActor: user() },
		tenant,
	)
	await store.updateSession({ ...parentSession, status: 'active' }, tenant)

	let counter = 0
	const materializer = new SessionSummaryMaterializer({
		store,
		generateSummaryId: () => `sum_test_${++counter}` as SummaryId,
	})

	const registry = new AgentRegistry()
	registry.register(makeDefinition(child))

	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: materializer,
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		threadManager,
	})

	const context: AgentTaskContext = {
		parentRunId: 'run_parent' as RunId,
		parentAgentId: 'parent-agent' as AgentId,
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 100_000, remaining: 100_000 },
		tenantId: tenant,
		threadId: thread.id as ThreadId,
		sessionId: parentSession.id as SessionId,
		projectId: project.id as ProjectId,
		parentActor: user(),
	}

	const options: SendMessageOptions = {
		agentId: child.metadata.id,
		input: { messages: [], workingDirectory: '/tmp' },
		parentSessionId: parentSession.id,
		tenantId: tenant,
		projectId: project.id,
		parentActor: user(),
	}

	return { manager, context, options, events: [] }
}

describe('AgentManager — a child cancelled by the parent cascade', () => {
	it('is recorded `canceled`, not `completed`', async () => {
		const child = new CancellableChild('child-1')
		const h = await buildHarness(child)
		const events: RunEvent[] = []

		const task = await h.manager.sendMessage(h.options, h.context, (e) => {
			events.push(e)
		})

		await child.entered

		// The child received the parent's derived signal.
		expect(child.signal).toBeInstanceOf(AbortSignal)
		expect(child.signal?.aborted).toBe(false)

		// The parent's run is cancelled. This is the cascade the API now drives:
		// per-run controller → supervisor's run signal → parentAbortController → here.
		h.context.parentAbortController.abort('canceled')
		expect(child.signal?.aborted).toBe(true)

		await h.manager.waitForCompletion(task.taskId)

		expect(h.manager.getState(task.taskId)).toBe('canceled')
		expect(h.manager.getInstance(task.taskId)?.result?.status).toBe('cancelled')

		// And the parent is told the truth on the run stream.
		const types = events.map((e) => e.type)
		expect(types).toContain('agent_canceled')
		expect(types).not.toContain('agent_completed')
	})
})

describe('AgentManager.dispose', () => {
	it('cancels the children that are still running', async () => {
		const child = new CancellableChild('child-1')
		const h = await buildHarness(child)

		await h.manager.sendMessage(h.options, h.context)
		await child.entered
		expect(child.signal?.aborted).toBe(false)

		h.manager.dispose()

		// `cancelAll('' as RunId)` matched no task, so this signal never fired and the
		// instance map was dropped with the child still burning tokens.
		expect(child.signal?.aborted).toBe(true)
	})
})
