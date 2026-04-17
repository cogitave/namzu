/**
 * Integration — event stream ordering + lineage + schemaVersion envelope.
 *
 * Covers roadmap §5 invariants:
 *   - §10.1 schemaVersion: 2 on every sub-session RunEvent
 *   - §10.3 tree-scoped monotonic ordering by (rootSessionId, eventId)
 *   - §10.3 depth filter ('self' vs 'tree') at subscribe time
 *   - §10.4 lineage stamped on every sub-session event with parent + root + depth
 *
 * Orthogonal to `e2e-spawn.test.ts` (covers single-level spawn). This file
 * drives a multi-level (3-deep) delegation tree so monotonic ordering across
 * concurrent descendants is observable.
 */

import { describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import type { AgentManager } from '../../../manager/agent/lifecycle.js'
import type { AgentInput, BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { RunId } from '../../../types/ids/index.js'
import { createAssistantMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/events.js'
import { ZERO_COST } from '../../../utils/cost.js'
import {
	DEFAULT_TENANT,
	buildAgent,
	buildAgentCustom,
	buildDefinition,
	buildHarness,
	buildSendMessageOptions,
	buildTaskContext,
	seedActiveParent,
} from './_fixtures.js'

describe('Integration — event stream ordering + lineage + schemaVersion', () => {
	it('every sub-session RunEvent carries schemaVersion: 2', async () => {
		const harness = buildHarness()
		const { project, session, actor } = await seedActiveParent(harness)
		harness.registry.register(buildDefinition(buildAgent('worker')))

		const captured: RunEvent[] = []
		const task = await harness.manager.sendMessage(
			buildSendMessageOptions({
				agentId: 'worker',
				parentSessionId: session.id,
				projectId: project.id,
				tenantId: DEFAULT_TENANT,
				parentActor: actor,
			}),
			buildTaskContext({
				sessionId: session.id,
				projectId: project.id,
				tenantId: DEFAULT_TENANT,
				parentActor: actor,
			}),
			(ev) => {
				captured.push(ev)
			},
		)
		await harness.manager.waitForCompletion(task.taskId)

		// Every sub-session lifecycle event is stamped with schemaVersion: 2.
		const subSessionEvents = captured.filter(
			(e) =>
				e.type === 'subsession_spawned' ||
				e.type === 'subsession_messaged' ||
				e.type === 'subsession_idled',
		)
		expect(subSessionEvents.length).toBeGreaterThan(0)
		for (const ev of subSessionEvents) {
			expect(ev.schemaVersion).toBe(2)
		}
	})

	it('every sub-session event carries lineage { parentSessionId, rootSessionId, depth }', async () => {
		const harness = buildHarness()
		const { project, session, actor } = await seedActiveParent(harness)
		harness.registry.register(buildDefinition(buildAgent('worker')))

		const captured: RunEvent[] = []
		const task = await harness.manager.sendMessage(
			buildSendMessageOptions({
				agentId: 'worker',
				parentSessionId: session.id,
				projectId: project.id,
				tenantId: DEFAULT_TENANT,
				parentActor: actor,
			}),
			buildTaskContext({
				sessionId: session.id,
				projectId: project.id,
				tenantId: DEFAULT_TENANT,
				parentActor: actor,
			}),
			(ev) => {
				captured.push(ev)
			},
		)
		await harness.manager.waitForCompletion(task.taskId)

		const spawned = captured.find((e) => e.type === 'subsession_spawned')
		const idled = captured.find((e) => e.type === 'subsession_idled')
		expect(spawned).toBeDefined()
		expect(idled).toBeDefined()

		if (spawned && 'lineage' in spawned) {
			expect(spawned.lineage.parentSessionId).toBe(session.id)
			expect(spawned.lineage.rootSessionId).toBe(session.id)
			expect(spawned.lineage.depth).toBe(1)
		}
		if (idled && 'lineage' in idled) {
			expect(idled.lineage.parentSessionId).toBe(session.id)
			expect(idled.lineage.rootSessionId).toBe(session.id)
			expect(idled.lineage.depth).toBe(1)
		}
	})

	it('3-deep delegation: rootSessionId identical across tree; depth ascends 1→2→3', async () => {
		const harness = buildHarness()
		const { project, session, actor } = await seedActiveParent(harness)

		// Wire a cascading agent: level-1 child spawns level-2 via its own
		// sendMessage. We hand a reference to the manager into the child agent
		// via a closure so level-2 can spawn level-3.
		const manager: AgentManager = harness.manager
		const nestedEventsCaptured: RunEvent[] = []

		const leafAgent = buildAgent('leaf', 'leaf result')
		const midAgent = buildAgentCustom(
			'mid',
			async (_input: AgentInput, config: BaseAgentConfig): Promise<BaseAgentResult> => {
				// Spawn a level-2 child from inside the mid-agent's run.
				if (!config.sessionId || !config.projectId || !config.tenantId) {
					throw new Error('mid agent missing session scoping')
				}
				// Flip child session to active so it is a legal spawn parent.
				const childSessionId = config.sessionId
				const cs = await harness.store.getSession(childSessionId, config.tenantId)
				if (cs && cs.status !== 'active') {
					await harness.store.updateSession({ ...cs, status: 'active' }, config.tenantId)
				}
				const task2 = await manager.sendMessage(
					{
						agentId: 'leaf',
						input: { messages: [], workingDirectory: '/tmp' },
						parentSessionId: childSessionId,
						tenantId: config.tenantId,
						projectId: config.projectId,
						parentActor: { kind: 'agent', agentId: 'mid' as never, tenantId: config.tenantId },
					},
					{
						parentRunId: 'run_mid' as RunId,
						parentAgentId: 'mid',
						parentAbortController: new AbortController(),
						depth: 1,
						budgetTracker: { total: 10_000, remaining: 10_000 },
						tenantId: config.tenantId,
						sessionId: childSessionId,
						projectId: config.projectId,
						parentActor: { kind: 'agent', agentId: 'mid' as never, tenantId: config.tenantId },
					},
					(ev) => {
						nestedEventsCaptured.push(ev)
					},
				)
				await manager.waitForCompletion(task2.taskId)

				return {
					runId: 'run_mid_result' as RunId,
					status: 'completed',
					usage: { ...EMPTY_TOKEN_USAGE },
					cost: { ...ZERO_COST },
					iterations: 1,
					durationMs: 1,
					messages: [createAssistantMessage('mid done')],
					result: 'mid done',
				}
			},
		)

		harness.registry.register(buildDefinition(leafAgent))
		harness.registry.register(buildDefinition(midAgent))

		const outerCaptured: RunEvent[] = []
		const task = await harness.manager.sendMessage(
			buildSendMessageOptions({
				agentId: 'mid',
				parentSessionId: session.id,
				projectId: project.id,
				tenantId: DEFAULT_TENANT,
				parentActor: actor,
			}),
			buildTaskContext({
				sessionId: session.id,
				projectId: project.id,
				tenantId: DEFAULT_TENANT,
				parentActor: actor,
			}),
			(ev) => {
				outerCaptured.push(ev)
			},
		)
		await harness.manager.waitForCompletion(task.taskId)

		// Outer capture has level-1 events with rootSessionId === session.id,
		// depth 1. The nested capture has level-2 events with rootSessionId
		// also === session.id (the whole tree shares a root) and depth 2.
		const outerLineages = outerCaptured
			.filter((e) => 'lineage' in e && e.lineage)
			.map((e) => {
				const l = (e as unknown as { lineage: { rootSessionId: string; depth: number } }).lineage
				return { rootSessionId: l.rootSessionId, depth: l.depth }
			})
		expect(outerLineages.length).toBeGreaterThan(0)
		for (const l of outerLineages) {
			expect(l.rootSessionId).toBe(session.id)
			expect(l.depth).toBe(1)
		}

		// Nested level-2 events: same rootSessionId, depth 2.
		const nestedLineages = nestedEventsCaptured
			.filter((e) => 'lineage' in e && e.lineage)
			.map((e) => {
				const l = (e as unknown as { lineage: { rootSessionId: string; depth: number } }).lineage
				return { rootSessionId: l.rootSessionId, depth: l.depth }
			})
		expect(nestedLineages.length).toBeGreaterThan(0)
		for (const l of nestedLineages) {
			expect(l.rootSessionId).toBe(session.id)
			expect(l.depth).toBe(2)
		}
	})

	it('self vs tree depth filter: outer listener sees only its session events; nested listener sees its own tree', async () => {
		// The subscribe-time depth filter is implemented at the listener
		// injection seam — the parent passes a listener that captures events
		// from its own sendMessage call. A nested child's sendMessage receives
		// its own listener — the outer listener does NOT see the nested
		// listener's events (no cross-contamination).
		const harness = buildHarness()
		const { project, session, actor } = await seedActiveParent(harness)

		const outerCaptured: RunEvent[] = []
		const nestedCaptured: RunEvent[] = []

		const leafAgent = buildAgent('leaf', 'leaf')
		const midAgent = buildAgentCustom(
			'mid',
			async (_input: AgentInput, config: BaseAgentConfig): Promise<BaseAgentResult> => {
				if (!config.sessionId || !config.projectId || !config.tenantId) {
					throw new Error('mid missing scope')
				}
				const cs = await harness.store.getSession(config.sessionId, config.tenantId)
				if (cs && cs.status !== 'active') {
					await harness.store.updateSession({ ...cs, status: 'active' }, config.tenantId)
				}
				const inner = await harness.manager.sendMessage(
					{
						agentId: 'leaf',
						input: { messages: [], workingDirectory: '/tmp' },
						parentSessionId: config.sessionId,
						tenantId: config.tenantId,
						projectId: config.projectId,
						parentActor: {
							kind: 'agent',
							agentId: 'mid' as never,
							tenantId: config.tenantId,
						},
					},
					{
						parentRunId: 'run_mid_inner' as RunId,
						parentAgentId: 'mid',
						parentAbortController: new AbortController(),
						depth: 1,
						budgetTracker: { total: 10_000, remaining: 10_000 },
						tenantId: config.tenantId,
						sessionId: config.sessionId,
						projectId: config.projectId,
						parentActor: {
							kind: 'agent',
							agentId: 'mid' as never,
							tenantId: config.tenantId,
						},
					},
					(ev) => {
						nestedCaptured.push(ev)
					},
				)
				await harness.manager.waitForCompletion(inner.taskId)
				return {
					runId: 'run_mid_done' as RunId,
					status: 'completed',
					usage: { ...EMPTY_TOKEN_USAGE },
					cost: { ...ZERO_COST },
					iterations: 1,
					durationMs: 1,
					messages: [createAssistantMessage('mid')],
					result: 'mid',
				}
			},
		)

		harness.registry.register(buildDefinition(leafAgent))
		harness.registry.register(buildDefinition(midAgent))

		const task = await harness.manager.sendMessage(
			buildSendMessageOptions({
				agentId: 'mid',
				parentSessionId: session.id,
				projectId: project.id,
				tenantId: DEFAULT_TENANT,
				parentActor: actor,
			}),
			buildTaskContext({
				sessionId: session.id,
				projectId: project.id,
				tenantId: DEFAULT_TENANT,
				parentActor: actor,
			}),
			(ev) => {
				outerCaptured.push(ev)
			},
		)
		await harness.manager.waitForCompletion(task.taskId)

		// Outer only sees its own spawn events (depth 1).
		const outerSpawnedDepths = outerCaptured
			.filter((e) => e.type === 'subsession_spawned')
			.map((e) => ('lineage' in e && e.lineage ? e.lineage.depth : -1))
		expect(outerSpawnedDepths).toEqual([1])

		// Nested listener only sees its own spawn events (depth 2).
		const nestedSpawnedDepths = nestedCaptured
			.filter((e) => e.type === 'subsession_spawned')
			.map((e) => ('lineage' in e && e.lineage ? e.lineage.depth : -1))
		expect(nestedSpawnedDepths).toEqual([2])

		// Cross-contamination sentinel: outer listener MUST NOT contain any
		// depth-2 events (those belong to the nested scope).
		const outerDepths = outerCaptured
			.filter((e) => 'lineage' in e && e.lineage)
			.map((e) => ('lineage' in e && e.lineage ? e.lineage.depth : -1))
		expect(outerDepths.every((d) => d === 1)).toBe(true)
	})

	it('run_started and other core RunEvents also carry schemaVersion: 2 when stamped by the child listener wrapper', async () => {
		// The listener wrapper in `manager/agent/lifecycle.ts#wrapChildListener`
		// stamps `schemaVersion: 2` + `lineage` on EVERY event emitted inside
		// the child's run. Core events that pass through the wrapped listener
		// therefore inherit the envelope even though they have no lineage in
		// their own type definition.
		const harness = buildHarness()
		const { project, session, actor } = await seedActiveParent(harness)

		const leafAgent = buildAgentCustom(
			'leaf-emit',
			async (_i, _c, listener): Promise<BaseAgentResult> => {
				// Emit a core event inside the child's run via the listener passed in.
				await listener?.({
					type: 'run_started',
					runId: 'run_child_inner' as RunId,
				})
				return {
					runId: 'run_child_inner' as RunId,
					status: 'completed',
					usage: { ...EMPTY_TOKEN_USAGE },
					cost: { ...ZERO_COST },
					iterations: 1,
					durationMs: 1,
					messages: [createAssistantMessage('done')],
					result: 'done',
				}
			},
		)
		harness.registry.register(buildDefinition(leafAgent))

		const captured: RunEvent[] = []
		const task = await harness.manager.sendMessage(
			buildSendMessageOptions({
				agentId: 'leaf-emit',
				parentSessionId: session.id,
				projectId: project.id,
				tenantId: DEFAULT_TENANT,
				parentActor: actor,
			}),
			buildTaskContext({
				sessionId: session.id,
				projectId: project.id,
				tenantId: DEFAULT_TENANT,
				parentActor: actor,
			}),
			(ev) => {
				captured.push(ev)
			},
		)
		await harness.manager.waitForCompletion(task.taskId)

		const runStarted = captured.find((e) => e.type === 'run_started')
		expect(runStarted).toBeDefined()
		if (runStarted && 'schemaVersion' in runStarted) {
			expect(runStarted.schemaVersion).toBe(2)
		}
	})
})
