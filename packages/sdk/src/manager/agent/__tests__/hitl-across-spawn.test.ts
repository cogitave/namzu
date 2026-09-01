import { describe, expect, it, vi } from 'vitest'

import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentTaskContext, SendMessageOptions } from '../../../types/agent/task.js'
import type { ResumeHandler } from '../../../types/hitl/index.js'
import type { TenantId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * A human's approval did not cross the spawn boundary.
 *
 * `BaseAgentConfig` carried no resume handler, and
 * `SendMessageOptions.configOverrides` is a `Partial` of it — so a parent
 * could not hand its channel to a child AT THE TYPE LEVEL. Every delegated
 * child fell through to `autoApproveHandler` however carefully its parent
 * had been wired.
 *
 * The cost is narrower than "no gate in children", and worth stating
 * exactly. A `AuthorizationGate` DENY still bites inside a child, because
 * denials are threaded into the executor and no later approval releases
 * them. What was lost is the REVIEW tier — every call the gate left
 * undecided reached the resume handler, and for a child that handler
 * auto-approved. A host running "ask before acting" had a human review
 * `write` at the top level and never see the same `write` one hop down.
 */

const tenant = 'tnt_hitl' as TenantId
const actor = (tenantId: TenantId): ActorRef =>
	({ kind: 'user', userId: 'usr_root', tenantId }) as unknown as ActorRef

/** Records the config the child was actually handed. */
function recordingAgent(seen: BaseAgentConfig[]): Agent<BaseAgentConfig, BaseAgentResult> {
	return {
		metadata: {
			type: 'reactive',
			id: 'worker',
			name: 'Worker',
			version: '1',
			category: 'test',
			description: 'records its config',
			capabilities: {
				supportsTools: true,
				supportsStreaming: true,
				supportsConcurrency: true,
				supportsSubAgents: false,
			},
		},
		async run(_input: unknown, config: BaseAgentConfig) {
			seen.push(config)
			return {
				runId: 'run_child' as never,
				status: 'completed',
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
				cost: { totalCost: 0 },
				iterations: 1,
				durationMs: 1,
				messages: [],
				result: 'done',
			} as unknown as BaseAgentResult
		},
	} as unknown as Agent<BaseAgentConfig, BaseAgentResult>
}

async function harness() {
	const seen: BaseAgentConfig[] = []
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryTopicStore()
	const threadManager = new TopicManager({ topicStore: threadStore, sessionStore: store })
	const project = await store.createProject({ tenantId: tenant, name: 'p' }, tenant)
	const thread = await threadStore.createTopic({ projectId: project.id, title: 'hitl' }, tenant)
	const parent = await store.createSession(
		{ topicId: thread.id, projectId: project.id, currentActor: actor(tenant) },
		tenant,
	)
	await store.updateSession({ ...parent, status: 'active' }, tenant)

	const registry = new AgentRegistry()
	const agent = recordingAgent(seen)
	registry.register({
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
	} as never)

	// A second registration WITH a configBuilder. That is the branch a real
	// registered agent takes, and the first version of these tests covered
	// only the bare one — so three mutations of the branch that matters
	// survived untouched.
	registry.register({
		info: {
			id: 'built-worker',
			name: 'Built Worker',
			version: '1',
			category: 'test',
			description: 'has a configBuilder',
			tools: [],
			defaults: { model: 'test', tokenBudget: 1_000 },
		},
		typedAgent: agent,
		configBuilder: (opts: Record<string, unknown>) => ({
			model: 'test',
			tokenBudget: (opts.tokenBudget as number) ?? 1_000,
			timeoutMs: (opts.timeoutMs as number) ?? 30_000,
		}),
	} as never)

	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => 'sum_1' as never,
		}),
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		threadManager,
	})

	const context = (over: Partial<AgentTaskContext> = {}): AgentTaskContext =>
		({
			parentRunId: 'run_parent',
			parentAgentId: 'supervisor',
			parentAbortController: new AbortController(),
			depth: 0,
			budgetTracker: { total: 100_000, remaining: 100_000 },
			tenantId: tenant,
			topicId: thread.id,
			sessionId: parent.id,
			projectId: project.id,
			parentActor: actor(tenant),
			...over,
		}) as AgentTaskContext

	const options = (over: Partial<SendMessageOptions> = {}): SendMessageOptions =>
		({
			agentId: 'worker',
			input: { messages: [], workingDirectory: '/tmp' },
			parentSessionId: parent.id,
			tenantId: tenant,
			projectId: project.id,
			parentActor: actor(tenant),
			...over,
		}) as SendMessageOptions

	const spawn = async (ctx: AgentTaskContext, opts?: Partial<SendMessageOptions>) => {
		await manager.sendMessage(options(opts), ctx)
		// The child runs detached; give it a tick to reach `agent.run`.
		await new Promise((r) => setTimeout(r, 20))
	}

	return { seen, context, spawn }
}

describe('a child is reviewed by the same person as its parent', () => {
	it('inherits the parent channel', async () => {
		const h = await harness()
		const handler = vi.fn(async () => ({ action: 'approve_tools' })) as unknown as ResumeHandler

		await h.spawn(h.context({ resumeHandler: handler }))

		expect(h.seen[0]?.resumeHandler).toBe(handler)
	})

	it('leaves a child without one when the parent has none', async () => {
		const h = await harness()

		await h.spawn(h.context())

		// Absent still means auto-approve, so a host that never wired a
		// handler is unaffected by any of this.
		expect(h.seen[0]?.resumeHandler).toBeUndefined()
	})

	it('lets an explicit override win, so one child can be given a different channel', async () => {
		const h = await harness()
		const parentHandler = vi.fn() as unknown as ResumeHandler
		const childHandler = vi.fn() as unknown as ResumeHandler

		await h.spawn(h.context({ resumeHandler: parentHandler }), {
			configOverrides: { resumeHandler: childHandler },
		})

		expect(h.seen[0]?.resumeHandler).toBe(childHandler)
	})

	it('does not disturb the scoping the manager already stamps', async () => {
		const h = await harness()
		const handler = vi.fn() as unknown as ResumeHandler

		await h.spawn(h.context({ resumeHandler: handler }))

		// The handler is stamped beside the trace parent and the tenant
		// triple, for the same reason: a configBuilder cannot be trusted to
		// forward something it was never told about.
		const config = h.seen[0]
		expect(config?.tenantId).toBe(tenant)
		expect(config?.depth).toBe(1)
	})
})

describe('the type allows what the spawn path needs', () => {
	it('accepts a handler through configOverrides', () => {
		const handler = vi.fn() as unknown as ResumeHandler

		// The assertion the whole change exists for. The field lived on
		// `ReactiveAgentConfig`, not on `BaseAgentConfig`, and
		// `configOverrides` is `Partial<BaseAgentConfig>` — so this line did
		// not compile, which is why no runtime path could ever have carried
		// one.
		const overrides: Partial<BaseAgentConfig> = { resumeHandler: handler }

		expect(overrides.resumeHandler).toBe(handler)
	})
})

/**
 * The same three questions against the branch a REAL registered agent
 * takes. `configBuilder` is written by whoever registered the agent and
 * cannot be trusted to forward something it was never told about, so the
 * manager stamps the handler afterwards — exactly as it does the trace
 * parent and the tenant triple.
 *
 * These exist because the first version of this file covered only the
 * bare-config branch, and three mutations of this one survived unnoticed.
 */
describe('a child built by a configBuilder inherits it too', () => {
	it('inherits the parent channel', async () => {
		const h = await harness()
		const handler = vi.fn() as unknown as ResumeHandler

		await h.spawn(h.context({ resumeHandler: handler }), { agentId: 'built-worker' })

		expect(h.seen[0]?.resumeHandler).toBe(handler)
	})

	it('cannot discard or forge the lineage owned by the manager', async () => {
		const h = await harness()

		await h.spawn(h.context(), {
			agentId: 'built-worker',
			// These are configuration hints, not authority. A child cannot turn
			// itself back into the root or attach to an unrelated parent run.
			configOverrides: { depth: 0, parentRunId: 'run_forged' as never },
		})

		expect(h.seen[0]?.depth).toBe(1)
		expect(h.seen[0]?.parentRunId).toBe('run_parent')
	})

	it('is left without one when the parent has none', async () => {
		const h = await harness()

		await h.spawn(h.context(), { agentId: 'built-worker' })

		// Nothing is invented. A host that never wired a handler still gets
		// the auto-approving default, which is what every child got before.
		expect(h.seen[0]?.resumeHandler).toBeUndefined()
	})

	it('lets an explicit override win over the parent', async () => {
		const h = await harness()
		const parentHandler = vi.fn() as unknown as ResumeHandler
		const childHandler = vi.fn() as unknown as ResumeHandler

		await h.spawn(h.context({ resumeHandler: parentHandler }), {
			agentId: 'built-worker',
			configOverrides: { resumeHandler: childHandler },
		})

		expect(h.seen[0]?.resumeHandler).toBe(childHandler)
	})

	it('cannot discard an explicit workspace boundary', async () => {
		const h = await harness()

		await h.spawn(h.context(), {
			agentId: 'built-worker',
			configOverrides: { sandbox: { workspace: 'working-directory' } },
		})

		expect(h.seen[0]?.sandbox).toEqual({ workspace: 'working-directory' })
	})
})
