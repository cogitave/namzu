import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionPaths } from '../../../session/paths.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import {
	DiskSessionLog,
	type SessionLog,
	type SessionRecordDraft,
} from '../../../store/session-log/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { SessionId, TenantId, TurnId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { ZERO_COST } from '../../../utils/cost.js'
import {
	generateMessageId,
	generateSessionId,
	generateSummaryId,
	generateTurnId,
} from '../../../utils/id.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { childSessionEnded, childSessionLog, readChildSessionMeta } from '../child-session.js'
import { AgentManager } from '../lifecycle.js'

/**
 * A delegation is a tree of child sessions (spec §1.1 decision 1, §3.1): each
 * child's log lives under its parent's session directory, at
 * `<parent>/subagents/<child-id>.jsonl`, with `<child-id>.meta.json` beside
 * it, recursively. Three levels deep here: root → child → grandchild →
 * great-grandchild.
 *
 * The agent below stands in for a turn: it writes its session's log the way
 * the turn recorder does (session_started, turn_started, turn_completed) and
 * delegates one level further until it reaches the bottom.
 */

const tenant = '0f7c5f1e-6a57-4d0b-9f2e-3d8b0a3c9e11' as TenantId
const actor: ActorRef = {
	kind: 'user',
	userId: '5d2a8a94-8a0c-4c61-a3a4-8f5c1c2e7b10',
	tenantId: tenant,
} as unknown as ActorRef

const dirs: string[] = []
afterEach(async () => {
	for (const dir of dirs.splice(0)) await removeTempDirAsync(dir)
})

/** Write one settled turn into `log`, as the recorder would. */
async function recordTurn(
	log: SessionLog,
	config: BaseAgentConfig,
	turnId: TurnId,
	usage: number,
	delegate: () => Promise<void>,
): Promise<void> {
	const lease = await log.claim({ holder: 'test', ttlMs: 60_000 })
	if (!lease) throw new Error('claim failed')
	await log.append(lease, {
		type: 'session_started',
		projectId: config.projectId,
		cwd: '/work',
		agent: { id: 'nester', name: 'Nester' },
	} as SessionRecordDraft)
	await log.beginTurn(lease, {
		turnId,
		userMessageId: generateMessageId(),
		config: { model: 'test', tokenBudget: 1_000, timeoutMs: 1_000 },
	})
	await delegate()
	await log.append(lease, {
		type: 'turn_completed',
		turnId,
		result: 'done',
		stopReason: 'end_turn',
		settlement: {
			status: 'completed',
			iterations: 1,
			usage: { ...EMPTY_TOKEN_USAGE, totalTokens: usage, completionTokens: usage },
			cost: { ...ZERO_COST },
			durationMs: 1,
			resultSource: 'model',
			abandonedTaskIds: [],
			abandonedJobIds: [],
		},
	} as SessionRecordDraft)
	await log.release(lease)
}

async function harness(maxDepth: number) {
	const home = await mkdtemp(join(tmpdir(), 'namzu-child-sessions-'))
	dirs.push(home)
	const paths = new SessionPaths({ home, slug: '-work' })
	const store = new InMemorySessionStore()
	const topicStore = new InMemoryTopicStore()
	const project = await store.createProject({ tenantId: tenant, name: 'p' }, tenant)
	const topic = await topicStore.createTopic({ projectId: project.id, title: 't' }, tenant)
	const root = await store.createSession(
		{ topicId: topic.id, projectId: project.id, currentActor: actor },
		tenant,
	)
	await store.updateSession({ ...root, status: 'active' }, tenant)

	const events: SessionEvent[] = []
	const configs: BaseAgentConfig[] = []
	const registry = new AgentRegistry()
	// The agent delegates through the manager that runs it, built below.
	const managerRef: { current?: AgentManager } = {}

	const agent = {
		metadata: {
			type: 'reactive',
			id: 'nester',
			name: 'Nester',
			version: '1',
			category: 'test',
			description: 'delegates one level further',
			capabilities: {
				supportsTools: false,
				supportsStreaming: false,
				supportsConcurrency: true,
				supportsSubAgents: true,
			},
		},
		async run(_input: unknown, config: BaseAgentConfig): Promise<BaseAgentResult> {
			configs.push(config)
			const sessionId = config.sessionId as SessionId
			const turnId = generateTurnId()
			const depth = config.depth ?? 0
			const log = config.sessionLog
			if (!log) throw new Error('the manager placed no log for this child')
			await recordTurn(log, config, turnId, 10 * depth, async () => {
				if (depth >= maxDepth) return
				const manager = managerRef.current
				if (!manager) throw new Error('no manager')
				const task = await manager.sendMessage(
					{
						agentId: 'nester',
						input: {
							messages: [{ role: 'user', content: `level ${depth + 1}` }],
							workingDirectory: '/work',
						},
						parentSessionId: sessionId,
						tenantId: tenant,
						projectId: config.projectId!,
						parentActor: actor,
					},
					{
						parentSessionId: sessionId,
						parentTurnId: turnId,
						parentAgentId: 'nester',
						parentAbortController: new AbortController(),
						depth,
						budget: config.budget!,
						tenantId: tenant,
						topicId: config.topicId!,
						sessionId,
						projectId: config.projectId!,
						parentActor: actor,
					},
					(event) => {
						events.push(event)
					},
				)
				await manager.waitForCompletion(task.taskId)
			})
			return {
				sessionId,
				turnId,
				status: 'completed',
				usage: { ...EMPTY_TOKEN_USAGE, totalTokens: 10 * depth, completionTokens: 10 * depth },
				cost: { ...ZERO_COST },
				iterations: 1,
				durationMs: 1,
				messages: [],
				result: 'done',
			}
		},
	} as unknown as Agent<BaseAgentConfig, BaseAgentResult>

	registry.register({
		info: {
			id: 'nester',
			name: 'Nester',
			version: '1',
			category: 'test',
			description: 'delegates',
			tools: [],
			defaults: { model: 'test', tokenBudget: 1_000 },
		},
		typedAgent: agent,
	} as never)

	const manager = new AgentManager(
		registry,
		{ maxDepth: 8 },
		{
			sessionStore: store,
			summaryMaterializer: new SessionSummaryMaterializer({ store, generateSummaryId }),
			workspaceRegistry: new WorkspaceBackendRegistry(),
			capacity: new DefaultCapacityValidator(store),
			topicManager: new TopicManager({ topicStore, sessionStore: store }),
			paths,
		},
	)

	managerRef.current = manager

	const rootTurn = generateTurnId()
	const context: AgentTaskContext = {
		parentSessionId: root.id,
		parentTurnId: rootTurn,
		parentAgentId: 'root',
		parentAbortController: new AbortController(),
		depth: 0,
		budget: SessionTokenBudget.create(100_000, { rootSessionId: root.id, rootTurnId: rootTurn }),
		tenantId: tenant,
		topicId: topic.id,
		sessionId: root.id,
		projectId: project.id,
		parentActor: actor,
	}
	return { manager, paths, root, rootTurn, context, events, configs, project }
}

describe('a delegation three levels deep', () => {
	it('writes each child log and meta document under its parent', async () => {
		const h = await harness(3)
		const task = await h.manager.sendMessage(
			{
				agentId: 'nester',
				input: {
					messages: [{ role: 'user', content: 'level 1\nwith detail' }],
					workingDirectory: '/work',
				},
				parentSessionId: h.root.id,
				tenantId: tenant,
				projectId: h.project.id,
				parentActor: actor,
			},
			h.context,
			(event) => {
				h.events.push(event)
			},
		)
		await h.manager.waitForCompletion(task.taskId)
		expect(task.state).toBe('completed')

		const chain = h.configs.map((config) => config.sessionId as SessionId)
		expect(chain).toHaveLength(3)
		const [child, grandchild, great] = chain as [SessionId, SessionId, SessionId]

		// Nested, one `subagents/` level per ancestor.
		const rootDir = h.paths.sessionDir({ sessionId: h.root.id })
		expect(await readdir(join(rootDir, 'subagents'))).toEqual(
			[`${child}.jsonl`, `${child}.meta.json`, child].sort(),
		)
		const childLocator = { sessionId: child, ancestors: [h.root.id] }
		const grandLocator = { sessionId: grandchild, ancestors: [h.root.id, child] }
		const greatLocator = { sessionId: great, ancestors: [h.root.id, child, grandchild] }
		expect(h.paths.sessionLog(greatLocator)).toBe(
			join(rootDir, 'subagents', child, 'subagents', grandchild, 'subagents', `${great}.jsonl`),
		)
		for (const locator of [childLocator, grandLocator, greatLocator]) {
			const log = DiskSessionLog.at(h.paths, locator)
			const read = await log.readAll()
			expect(read.intact).toBe(true)
			expect(read.entries.map((e) => e.record.type)).toEqual([
				'session_started',
				'turn_started',
				'turn_completed',
			])
		}

		// Each meta document names its parent, root, depth and outcome.
		const parents = [h.root.id, child, grandchild]
		for (const [index, locator] of [childLocator, grandLocator, greatLocator].entries()) {
			const parent = { sessionId: parents[index]!, ancestors: locator.ancestors.slice(0, -1) }
			const meta = await readChildSessionMeta(h.paths.subagentMeta(parent, locator.sessionId))
			expect(meta).toMatchObject({
				v: 1,
				kind: 'child-session',
				sessionId: locator.sessionId,
				parentSessionId: parents[index],
				rootSessionId: h.root.id,
				depth: index + 1,
				agentType: 'nester',
				status: 'completed',
			})
			expect(meta?.endedAt).toBeTypeOf('string')
		}
		const top = await readChildSessionMeta(h.paths.subagentMeta({ sessionId: h.root.id }, child))
		expect(top).toMatchObject({ parentTurnId: h.rootTurn, description: 'level 1' })
	})

	it("announces each child to its parent and derives the parent's ended record from the child's terminal record", async () => {
		const h = await harness(1)
		const task = await h.manager.sendMessage(
			{
				agentId: 'nester',
				input: { messages: [{ role: 'user', content: 'go' }], workingDirectory: '/work' },
				parentSessionId: h.root.id,
				tenantId: tenant,
				projectId: h.project.id,
				parentActor: actor,
			},
			h.context,
			(event) => {
				h.events.push(event)
			},
		)
		const childId = h.manager.getSpawnRecord(task.taskId)?.childSessionId as SessionId
		// Live while its spawn record is held.
		expect(childSessionLog(childId)?.sessionId).toBe(childId)
		await h.manager.waitForCompletion(task.taskId)

		const toRoot = h.events.filter((e) => e.sessionId === h.root.id)
		expect(toRoot.map((e) => e.type)).toEqual([
			'agent_pending',
			'child_session_spawned',
			'child_session_idled',
			'agent_completed',
		])
		expect(toRoot[1]).toMatchObject({
			turnId: h.rootTurn,
			childSessionId: childId,
			path: `subagents/${childId}.jsonl`,
			lineage: { parentSessionId: h.root.id, rootSessionId: h.root.id, depth: 1 },
		})

		const childLog = DiskSessionLog.at(h.paths, { sessionId: childId, ancestors: [h.root.id] })
		const terminal = (await childLog.readAll()).entries.at(-1)?.record
		if (terminal?.type !== 'turn_completed') throw new Error('child did not settle')
		expect(await childSessionEnded(childLog)).toEqual({
			type: 'child_session_ended',
			childSessionId: childId,
			status: terminal.settlement.status,
			stopReason: terminal.stopReason,
			usage: terminal.settlement.usage,
			cost: terminal.settlement.cost,
		})
	})

	it('releases a settled child from the live lookup once its record is gone', async () => {
		const h = await harness(1)
		const task = await h.manager.sendMessage(
			{
				agentId: 'nester',
				input: { messages: [{ role: 'user', content: 'go' }], workingDirectory: '/work' },
				parentSessionId: h.root.id,
				tenantId: tenant,
				projectId: h.project.id,
				parentActor: actor,
			},
			h.context,
		)
		const childId = h.manager.getSpawnRecord(task.taskId)?.childSessionId as SessionId
		await h.manager.waitForCompletion(task.taskId)
		// The invocation's own cleanup runs just after the task settles.
		await vi.waitFor(() => {
			h.manager.cleanup()
			expect(h.manager.getSpawnRecord(task.taskId)).toBeUndefined()
		})
		expect(childSessionLog(childId)).toBeUndefined()
		expect(childSessionLog(generateSessionId())).toBeUndefined()
	})
})
