import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import { fixtureId, fixtureUuid } from '../../../test-support/ids.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { AgentId, TenantId } from '../../../types/ids/index.js'
import type { SummaryId } from '../../../types/session/ids.js'
import type { FileReadTracker, ToolContext } from '../../../types/tool/index.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * What an agent has read is its own. A write or an edit is refused when the
 * file on disk is no longer what THIS reader last read; a ledger shared by
 * a parent and its children, or by two siblings, let one agent's write stand in
 * for another's read, so the later of two writers replaced the first one's
 * edit without a word. Children are made here the way the Agent tool makes
 * them: through the manager, from the parent's tracker in `configOverrides`.
 */
const TENANT = '33fc383e-e313-4cb9-b631-111dd8ebaa3f' as TenantId

/** Records the config it is run with, so the assertion is on what shipped. */
function recordingAgent(seen: { config?: BaseAgentConfig }) {
	return {
		type: 'reactive',
		metadata: {
			id: 'worker',
			name: 'worker',
			version: '1.0.0',
			category: 'general',
			description: 'records its config',
			type: 'reactive',
			capabilities: {},
		},
		async run(_input: unknown, config: BaseAgentConfig): Promise<BaseAgentResult> {
			seen.config = config
			return {
				sessionId: fixtureId.session('child'),
				turnId: fixtureId.turn('child'),
				status: 'completed',
				result: 'ok',
				usage: { ...EMPTY_TOKEN_USAGE },
				cost: { ...ZERO_COST },
				iterations: 1,
				durationMs: 0,
				messages: [],
			} as BaseAgentResult
		},
		async cancel() {},
		getCapabilities() {
			return {} as never
		},
	} as unknown as Agent<BaseAgentConfig, BaseAgentResult>
}

/** A definition WITH a configBuilder — the shape every real host registers. */
function definitionWithBuilder(agent: Agent<BaseAgentConfig, BaseAgentResult>): AgentDefinition {
	return {
		info: {
			id: 'worker',
			name: 'worker',
			version: '1.0.0',
			category: 'general',
			description: 'a worker',
			tools: [],
			defaults: { model: 'test', tokenBudget: 1_000 },
		},
		typedAgent: agent,
		configBuilder: () =>
			({
				model: 'test',
				tokenBudget: 1_000,
				timeoutMs: 10_000,
			}) as BaseAgentConfig,
	} as AgentDefinition
}

async function childrenOf(parent: FileReadTracker, count: number): Promise<FileReadTracker[]> {
	const seen: { config?: BaseAgentConfig } = {}
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryTopicStore()
	const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
	const thread = await threadStore.createTopic({ projectId: project.id, title: 't' }, TENANT)
	const parentActor = { kind: 'agent', agentId: 'sup' as AgentId, tenantId: TENANT } as const
	const parentSession = await store.createSession(
		{ topicId: thread.id, projectId: project.id, currentActor: parentActor },
		TENANT,
	)
	await store.updateSession({ ...parentSession, status: 'active' }, TENANT)
	const registry = new AgentRegistry()
	registry.register(definitionWithBuilder(recordingAgent(seen)))
	let n = 0
	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		threadManager: new TopicManager({ topicStore: threadStore, sessionStore: store }),
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => fixtureUuid(`sum_${++n}`) as SummaryId,
		}),
	})
	const context = {
		parentSessionId: 'c0250b29-330b-445f-b11d-2926ffd9059c' as never,
		parentTurnId: '0199a3c2-7c1e-7b4a-9d2f-5e6a7b8c9d0e' as never,
		parentAgentId: 'sup',
		parentAbortController: new AbortController(),
		depth: 0,
		budget: SessionTokenBudget.create(100_000, {
			rootSessionId: generateSessionId(),
			rootTurnId: generateTurnId(),
		}),
		tenantId: TENANT,
		topicId: thread.id,
		sessionId: parentSession.id,
		projectId: project.id,
		parentActor,
	} as AgentTaskContext
	const out: FileReadTracker[] = []
	for (let i = 0; i < count; i++) {
		const task = await manager.sendMessage(
			{
				agentId: 'worker',
				input: { messages: [], workingDirectory: '/tmp' } as never,
				parentSessionId: parentSession.id,
				tenantId: TENANT,
				projectId: project.id,
				parentActor,
				configOverrides: { fileReadTracker: parent },
			} as never,
			context,
		)
		await manager.waitForCompletion(task.taskId)
		const tracker = seen.config?.fileReadTracker
		if (!tracker) throw new Error('the child carried no file tracker')
		out.push(tracker)
	}
	return out
}

let call = 0
function contextOf(dir: string, tracker: FileReadTracker): ToolContext {
	call += 1
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: '9bf74d42-964f-4a93-aabb-d20245d81daf' as ToolContext['turnId'],
		toolUseId: `call-${call}`,
		workingDirectory: dir,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		fileReadTracker: tracker,
	}
}

function fixture(): { dir: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-sibling-'))
	const file = join(dir, 'plan.txt')
	writeFileSync(file, 'one\ntwo\n')
	return { dir, file }
}

describe('what each agent has read is its own', () => {
	for (const [name, mutate] of [
		[
			'a write',
			(file: string, dir: string, t: FileReadTracker, text: string) =>
				WriteFileTool.execute({ path: file, content: text }, contextOf(dir, t)),
		],
		[
			'an edit',
			(file: string, dir: string, t: FileReadTracker, text: string) =>
				EditTool.execute(
					{ path: file, old_string: 'one', new_string: text, replace_all: false },
					contextOf(dir, t),
				),
		],
	] as const) {
		it(`refuses ${name} by a sibling that read before the other sibling wrote`, async () => {
			const { dir, file } = fixture()
			const [a, b] = await childrenOf(createFileReadTracker(), 2)
			expect(
				(await ReadFileTool.execute({ path: file }, contextOf(dir, a as FileReadTracker))).success,
			).toBe(true)
			expect(
				(await ReadFileTool.execute({ path: file }, contextOf(dir, b as FileReadTracker))).success,
			).toBe(true)
			const first = await EditTool.execute(
				{ path: file, old_string: 'two', new_string: 'A WAS HERE', replace_all: false },
				contextOf(dir, a as FileReadTracker),
			)
			expect(first.success).toBe(true)
			const second = await mutate(file, dir, b as FileReadTracker, 'B')
			expect(second.success).toBe(false)
			expect(second.error).toContain('changed on disk')
			expect(readFileSync(file, 'utf8')).toBe('one\nA WAS HERE\n')
		})

		it(`refuses ${name} by a child that read before its parent wrote`, async () => {
			const { dir, file } = fixture()
			const parent = createFileReadTracker()
			const [child] = await childrenOf(parent, 1)
			expect(
				(await ReadFileTool.execute({ path: file }, contextOf(dir, child as FileReadTracker)))
					.success,
			).toBe(true)
			expect((await ReadFileTool.execute({ path: file }, contextOf(dir, parent))).success).toBe(
				true,
			)
			const first = await EditTool.execute(
				{ path: file, old_string: 'two', new_string: 'PARENT WAS HERE', replace_all: false },
				contextOf(dir, parent),
			)
			expect(first.success).toBe(true)
			const second = await mutate(file, dir, child as FileReadTracker, 'CHILD')
			expect(second.success).toBe(false)
			expect(readFileSync(file, 'utf8')).toBe('one\nPARENT WAS HERE\n')
		})

		it(`refuses ${name} by a parent that read before its child wrote`, async () => {
			const { dir, file } = fixture()
			const parent = createFileReadTracker()
			const [child] = await childrenOf(parent, 1)
			expect((await ReadFileTool.execute({ path: file }, contextOf(dir, parent))).success).toBe(
				true,
			)
			expect(
				(await ReadFileTool.execute({ path: file }, contextOf(dir, child as FileReadTracker)))
					.success,
			).toBe(true)
			const first = await EditTool.execute(
				{ path: file, old_string: 'two', new_string: 'CHILD WAS HERE', replace_all: false },
				contextOf(dir, child as FileReadTracker),
			)
			expect(first.success).toBe(true)
			const second = await mutate(file, dir, parent, 'PARENT')
			expect(second.success).toBe(false)
			expect(readFileSync(file, 'utf8')).toBe('one\nCHILD WAS HERE\n')
		})
	}

	it('still lets the family see what any of them wrote', async () => {
		const { dir, file } = fixture()
		const parent = createFileReadTracker()
		const [a, b] = (await childrenOf(parent, 2)) as [FileReadTracker, FileReadTracker]
		await ReadFileTool.execute({ path: file }, contextOf(dir, a))
		await WriteFileTool.execute({ path: file, content: 'made by a\n' }, contextOf(dir, a))
		const fp = a.authoredFingerprint?.(file)
		expect(fp).toBeDefined()
		expect(b.authoredFingerprint?.(file)).toBe(fp)
		expect(parent.authoredFingerprint?.(file)).toBe(fp)
		expect(b.startedAt).toBe(parent.startedAt)
		// ...without b having read it.
		expect(b.hasRead(file)).toBe(false)
	})
})
