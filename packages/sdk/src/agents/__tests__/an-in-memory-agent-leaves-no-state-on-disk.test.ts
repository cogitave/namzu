import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { AgentManager } from '../../manager/agent/lifecycle.js'
import { TopicManager } from '../../manager/topic/lifecycle.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { AgentRegistry } from '../../registry/agent/definitions.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { DefaultCapacityValidator } from '../../session/handoff/capacity.js'
import { resolveNamzuHome } from '../../session/home.js'
import { SessionPaths } from '../../session/paths.js'
import { SessionSummaryMaterializer } from '../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../session/workspace/registry.js'
import { InMemorySessionLog } from '../../store/session-log/index.js'
import { InMemorySessionStore } from '../../store/session/memory.js'
import { InMemoryTopicStore } from '../../store/topic/memory.js'
import { defineTool } from '../../tools/defineTool.js'
import type { AgentTaskContext } from '../../types/agent/task.js'
import type { TenantId } from '../../types/ids/index.js'
import type { ActorRef } from '../../types/session/actor.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../utils/id.js'
import { ReactiveAgent } from '../ReactiveAgent.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

/**
 * An agent whose session log is in memory writes nothing under `NAMZU_HOME`,
 * and neither do the child sessions it delegates to.
 *
 * A delegated child's config never carried its parent's choice, so the child
 * opened a disk log and left its records, checkpoints and ledger there. The
 * choice now travels on `AgentTaskContext.childStorage`, and the manager
 * gives such a child an in-memory log of its own.
 */

const dirs: string[] = []

// A home of this file's own. The suite's shared `NAMZU_HOME` is written by
// every other test file running beside this one, so a snapshot of it could
// never say that THIS agent added nothing.
beforeEach(async () => {
	const home = await mkdtemp(join(realpathSync(tmpdir()), 'namzu-in-memory-home-'))
	dirs.push(home)
	vi.stubEnv('NAMZU_HOME', home)
})

afterEach(async () => {
	vi.unstubAllEnvs()
	await removeTempDirs(dirs)
	dirs.length = 0
})

function echoTools(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(
		defineTool({
			name: 'echo',
			description: 'echoes',
			inputSchema: z.object({ value: z.string() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async (input) => ({ success: true, output: input.value }),
		}),
	)
	return registry
}

/** A tool call, so the turn writes an iteration checkpoint, then an answer. */
function workerProvider(): MockLLMProvider {
	return new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'echo', args: { value: 'x' } }], finishReason: 'tool_calls' as const },
			{ text: 'done' },
		],
	})
}

const workerMetadata = {
	id: 'worker',
	name: 'worker',
	version: '1.0.0',
	category: 'general',
	description: 'a worker',
}

it('a ReactiveAgent with an in-memory session log writes nothing to disk', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-in-memory-agent-'))
	dirs.push(workingDirectory)
	const projectId = generateProjectId()
	const sessionId = generateSessionId()
	const sessionLog = new InMemorySessionLog({ sessionId })
	const before = listHome()

	const result = await new ReactiveAgent(workerMetadata).run(
		{ messages: [{ role: 'user', content: 'go', timestamp: 1 }], workingDirectory },
		{
			model: 'mock',
			tokenBudget: 100_000,
			timeoutMs: 20_000,
			maxIterations: 4,
			provider: workerProvider(),
			tools: echoTools(),
			systemPrompt: 'work',
			sessionLog,
			sessionId,
			topicId: generateTopicId(),
			projectId,
			tenantId: generateTenantId(),
		},
	)

	expect(result.status).toBe('completed')
	expect(JSON.stringify(await sessionLog.messages())).toContain('done')
	expect(listHome()).toEqual(before)
})

async function delegationHarness() {
	const tenantId = generateTenantId() as TenantId
	const store = new InMemorySessionStore()
	const topics = new InMemoryTopicStore()
	const project = await store.createProject({ tenantId, name: 'p' }, tenantId)
	const topic = await topics.createTopic({ projectId: project.id, title: 't' }, tenantId)
	const actor = {
		kind: 'user',
		userId: '4a6f0f5e-2b1c-4d3e-8f9a-0b1c2d3e4f5a',
		tenantId,
	} as unknown as ActorRef
	const session = await store.createSession(
		{ topicId: topic.id, projectId: project.id, currentActor: actor },
		tenantId,
	)
	await store.updateSession({ ...session, status: 'active' }, tenantId)

	const registry = new AgentRegistry()
	const childSessions: string[] = []
	registry.register({
		info: { ...workerMetadata, tools: [], defaults: { model: 'mock', tokenBudget: 0 } },
		typedAgent: new ReactiveAgent(workerMetadata),
		// The shape a host registers: the builder knows nothing about storage.
		configBuilder: (opts: Record<string, unknown>) => ({
			model: 'mock',
			tokenBudget: (opts.tokenBudget as number) ?? 0,
			timeoutMs: 20_000,
			maxIterations: 4,
			provider: workerProvider(),
			tools: echoTools(),
			systemPrompt: 'work',
		}),
	} as never)
	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => '6b1d2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e' as never,
		}),
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		threadManager: new TopicManager({ topicStore: topics, sessionStore: store }),
	})
	manager.on((event) => {
		if (event.type === 'completed') childSessions.push(event.result.sessionId)
	})
	return {
		tenantId,
		projectId: project.id,
		topicId: topic.id,
		sessionId: session.id,
		manager,
		childSessions,
	}
}

type Harness = Awaited<ReturnType<typeof delegationHarness>>

/** Every name under the home the tests run with, so a test can say it added none. */
function listHome(): string[] {
	const home = resolveNamzuHome()
	return existsSync(home) ? readdirSync(home, { recursive: true }).map(String).sort() : []
}

async function runSupervisor(extra: (h: Harness) => Record<string, unknown>) {
	const h = await delegationHarness()
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-in-memory-supervisor-'))
	dirs.push(workingDirectory)
	const result = await new SupervisorAgent({
		id: 'supervisor',
		name: 'Supervisor',
		version: '1',
		category: 'test',
		description: 'coordinates workers',
	}).run({ messages: [{ role: 'user', content: 'go', timestamp: 1 }], workingDirectory }, {
		provider: new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							id: 'c1',
							name: 'create_task',
							rawArguments: JSON.stringify({
								agent_id: 'worker',
								prompt: 'do the thing',
								description: 'a task',
							}),
						},
					],
				},
				{ text: 'all done' },
			],
		}),
		agentIds: ['worker'],
		agentManager: h.manager,
		tools: new ToolRegistry(),
		systemPrompt: 'You coordinate.',
		model: 'mock',
		tokenBudget: 0,
		timeoutMs: 30_000,
		maxIterations: 4,
		sessionId: h.sessionId,
		topicId: h.topicId,
		projectId: h.projectId,
		tenantId: h.tenantId,
		...extra(h),
	} as never)
	return { result, ...h }
}

describe('a supervisor held in memory', () => {
	it('delegates to a child that is held in memory too', async () => {
		const before = listHome()
		const { result, sessionId, childSessions } = await runSupervisor((h) => ({
			sessionLog: new InMemorySessionLog({ sessionId: h.sessionId }),
		}))

		expect(result.status).toBe('completed')
		expect(result.sessionId).toBe(sessionId)
		// The child really ran — through the manager, on a real ReactiveAgent,
		// as a child session of its own.
		expect(childSessions).toHaveLength(1)
		expect(childSessions[0]).not.toBe(sessionId)
		expect(listHome()).toEqual(before)
	})

	it('still writes to disk when the host names paths', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-supervisor-root-'))
		dirs.push(root)
		const paths = new SessionPaths({ home: root, slug: '-supervisor' })
		const { result, childSessions } = await runSupervisor((h) => ({
			sessionLog: new InMemorySessionLog({ sessionId: h.sessionId }),
			paths,
		}))

		expect(result.status).toBe('completed')
		expect(childSessions).toHaveLength(1)
		// The supervisor's ledger goes under the layout it named.
		expect(existsSync(paths.budgets({ sessionId: result.sessionId }))).toBe(true)
	})
})

describe('the spawn context carries the choice', () => {
	function spyManager(contexts: AgentTaskContext[]) {
		return {
			sendMessage: vi.fn(async (_options: unknown, context: AgentTaskContext) => {
				contexts.push(context)
				return {
					taskId: '5f5d0823-8327-45fd-a288-bf8fd5f45f91',
					status: 'completed',
					result: {
						sessionId: '4721e070-5ba2-425a-bf5a-8cc927907e9a',
						turnId: '0199a3c2-7c1e-7b4a-9d2f-5e6a7b8c9d0e',
						status: 'completed',
						usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
						cost: { totalCost: 0 },
						iterations: 1,
						durationMs: 1,
						messages: [],
						result: 'worker done',
					},
				}
			}),
			await: vi.fn(async () => undefined),
			cancel: vi.fn(),
			dispose: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}
	}

	it.each([
		[
			'in memory',
			(h: Harness) => ({ sessionLog: new InMemorySessionLog({ sessionId: h.sessionId }) }),
			{ kind: 'memory' },
		],
		[
			'in memory with paths',
			(h: Harness) => ({
				sessionLog: new InMemorySessionLog({ sessionId: h.sessionId }),
				paths: new SessionPaths({ home: '/tmp/x', slug: '-x' }),
			}),
			undefined,
		],
		['on disk', () => ({}), undefined],
	])('%s', async (_label, extra, expected) => {
		const contexts: AgentTaskContext[] = []
		await runSupervisor((h) => ({ ...extra(h), agentManager: spyManager(contexts) })).catch(
			() => undefined,
		)

		expect(contexts.length).toBeGreaterThan(0)
		expect(contexts[0]?.childStorage).toEqual(expected)
	})
})
