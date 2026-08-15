import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import {
	ProjectClosedError,
	ProjectNotEmptyError,
	StaleProjectError,
} from '../../../session/errors.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { DiskSessionStore } from '../../../store/session/disk.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore as InMemoryThreadStore } from '../../../store/topic/memory.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { AgentId, TenantId } from '../../../types/ids/index.js'
import type { SummaryId } from '../../../types/session/ids.js'
import type { SessionStore } from '../../../types/session/store.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { AgentManager } from '../../agent/lifecycle.js'
import { TopicManager as ThreadManager } from '../../topic/lifecycle.js'
import { ProjectManager } from '../lifecycle.js'

/**
 * Archiving a workspace meant nothing to the code.
 *
 * `Thread` carried a status and a gate; `Project` — the thing a tenant owns,
 * configures, gives an environment, and actually closes — carried neither. So
 * a host could archive a workspace and the kernel would keep spawning agents
 * into it, because there was no state for the spawn path to read.
 *
 * The spawn case drives the real `AgentManager` rather than calling the gate
 * directly. A test that calls `requireOpenProject` proves the function throws;
 * what has to hold is that the spawn path reaches it, and the only assertion
 * that cannot pass with the call deleted is one made through the front door.
 */

const TENANT = 'tnt_close' as TenantId

function silentAgent(): Agent<BaseAgentConfig, BaseAgentResult> {
	return {
		type: 'reactive',
		metadata: {
			id: 'worker',
			name: 'worker',
			version: '1.0.0',
			category: 'general',
			description: 'does nothing',
			type: 'reactive',
			capabilities: {},
		},
		async run(): Promise<BaseAgentResult> {
			return {
				runId: 'run_child',
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

function definition(): AgentDefinition {
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
		typedAgent: silentAgent(),
	} as AgentDefinition
}

/** A parent session in a real workspace, plus the manager that spawns into it. */
async function harness() {
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryThreadStore()
	const project = await store.createProject({ tenantId: TENANT, name: 'w' }, TENANT)
	const thread = await threadStore.createTopic({ projectId: project.id, title: 't' }, TENANT)
	const parentActor = { kind: 'agent', agentId: 'sup' as AgentId, tenantId: TENANT } as const
	const parentSession = await store.createSession(
		{ threadId: thread.id, projectId: project.id, currentActor: parentActor },
		TENANT,
	)

	const registry = new AgentRegistry()
	registry.register(definition())

	let n = 0
	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		threadManager: new ThreadManager({ topicStore: threadStore, sessionStore: store }),
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => `sum_${++n}` as SummaryId,
		}),
	})

	const context = {
		parentRunId: 'run_parent' as never,
		parentAgentId: 'sup',
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 100_000, remaining: 100_000 },
		tenantId: TENANT,
		threadId: thread.id,
		sessionId: parentSession.id,
		projectId: project.id,
		parentActor,
	} as AgentTaskContext

	const spawn = () =>
		manager.sendMessage(
			{
				agentId: 'worker',
				input: { messages: [], workingDirectory: '/tmp' } as never,
				parentSessionId: parentSession.id,
				tenantId: TENANT,
			} as never,
			context,
		)

	return { store, project, parentSession, projects: new ProjectManager({ store }), spawn }
}

describe('a closed workspace takes no new work', () => {
	it('spawns while the workspace is open', async () => {
		// The control. Without it, every assertion below could be passing
		// because the harness cannot spawn at all.
		const h = await harness()

		await expect(h.spawn()).resolves.toBeDefined()
	})

	it('refuses a spawn into an archived workspace, through the real spawn path', async () => {
		const h = await harness()
		await h.projects.archive(h.project.id, TENANT)

		await expect(h.spawn()).rejects.toBeInstanceOf(ProjectClosedError)
	})

	it('names the operation it refused', async () => {
		// "Archived" alone does not tell a caller what they were denied.
		const h = await harness()
		await h.projects.archive(h.project.id, TENANT)

		const error = await h.spawn().then(
			() => null,
			(e: unknown) => e,
		)

		expect((error as ProjectClosedError).details).toEqual({
			projectId: h.project.id,
			op: 'spawn',
		})
	})

	it('spawns again after the workspace is reopened', async () => {
		// Closing has to be reversible, or a mistaken archive is permanent.
		const h = await harness()
		await h.projects.archive(h.project.id, TENANT)
		await h.projects.reopen(h.project.id, TENANT)

		await expect(h.spawn()).resolves.toBeDefined()
	})

	it('refuses to close a workspace with a live session, and says which', async () => {
		// Archival does not cascade and does not kill: a live session is a
		// running agent whose owner is still watching.
		const h = await harness()
		await h.store.updateSession({ ...h.parentSession, status: 'active' }, TENANT)

		const error = await h.projects.archive(h.project.id, TENANT).then(
			() => null,
			(e: unknown) => e,
		)

		expect(error).toBeInstanceOf(ProjectNotEmptyError)
		const details = (error as ProjectNotEmptyError).details
		expect(details.totalBlockingSessions).toBe(1)
		expect(details.blockingSessions).toEqual([{ sessionId: h.parentSession.id, status: 'active' }])
	})

	it('closes a workspace whose sessions have settled', async () => {
		const h = await harness()

		const archived = await h.projects.archive(h.project.id, TENANT)

		expect(archived.status).toBe('archived')
		expect((await h.store.getProject(h.project.id, TENANT))?.status).toBe('archived')
	})

	it('re-archiving is a no-op that does not burn a version', async () => {
		// An idempotent call that bumped the counter would invalidate a version
		// a concurrent caller is holding, turning a retry into a conflict.
		const h = await harness()
		const first = await h.projects.archive(h.project.id, TENANT)

		const second = await h.projects.archive(h.project.id, TENANT)

		expect(second.ownerVersion).toBe(first.ownerVersion)
	})

	it('loses the second of two writes that read the same version', async () => {
		// The store compares against what it holds, not against the caller's
		// copy of it — the mistake the session CAS was written with first.
		const h = await harness()
		const read = await h.store.getProject(h.project.id, TENANT)
		if (!read) throw new Error('project vanished')

		await h.store.setProjectStatus?.(h.project.id, 'archived', TENANT, read.ownerVersion)

		await expect(
			h.store.setProjectStatus?.(h.project.id, 'open', TENANT, read.ownerVersion),
		).rejects.toBeInstanceOf(StaleProjectError)
	})
})

describe('a workspace stored before it had a status', () => {
	const dirs: string[] = []
	afterEach(async () => {
		await removeTempDirs(dirs)
		dirs.length = 0
	})

	it('reads as open at version 0, and can still be closed', async () => {
		// Every project.json on disk today lacks both fields. Reading them as
		// `undefined` would be worse than a wrong default: the compare-and-set
		// would never match, so an existing workspace could never be closed.
		const root = await mkdtemp(join(tmpdir(), 'namzu-oldproj-'))
		dirs.push(root)
		const store = new DiskSessionStore({ rootDir: root })
		const project = await store.createProject({ tenantId: TENANT, name: 'w' }, TENANT)

		const file = join(root, 'projects', project.id, 'project.json')
		const raw = JSON.parse(await readFile(file, 'utf-8'))
		raw.status = undefined
		raw.ownerVersion = undefined
		await writeFile(file, JSON.stringify(raw), 'utf-8')

		const reloaded = await store.getProject(project.id, TENANT)
		expect(reloaded?.status).toBe('open')
		expect(reloaded?.ownerVersion).toBe(0)

		const archived = await new ProjectManager({ store }).archive(project.id, TENANT)
		expect(archived.status).toBe('archived')
	})
})

describe('a store that cannot answer the precondition', () => {
	/**
	 * `listSessionsByProject` is optional on `SessionStore` so a host's own
	 * store keeps compiling. The archive path read it as
	 * `(await store.listSessionsByProject?.(...)) ?? []`, which turned "this
	 * store cannot tell me what is running here" into "nothing is running
	 * here" — so a host with such a store closed a workspace over live
	 * sessions and got a success back. The refusal that the whole feature is
	 * about was skippable by not implementing one method.
	 */
	function storeWithoutTheListing(inner: SessionStore): SessionStore {
		const partial: Record<string, unknown> = {}
		for (const key of [
			'getProject',
			'createProject',
			'createSession',
			'getSession',
			'updateSession',
			'setProjectStatus',
		]) {
			const fn = (inner as unknown as Record<string, unknown>)[key]
			if (typeof fn === 'function') partial[key] = (fn as (...a: unknown[]) => unknown).bind(inner)
		}
		return partial as unknown as SessionStore
	}

	it('refuses to archive rather than assuming the workspace is empty', async () => {
		const h = await harness()
		await h.store.updateSession({ ...h.parentSession, status: 'active' }, TENANT)
		const blind = new ProjectManager({ store: storeWithoutTheListing(h.store) })

		await expect(blind.archive(h.project.id, TENANT)).rejects.toThrow(/listSessionsByProject/)
	})

	it('leaves the workspace open after refusing', async () => {
		// The refusal has to happen before the write, or it is only a message.
		const h = await harness()
		const blind = new ProjectManager({ store: storeWithoutTheListing(h.store) })

		await blind.archive(h.project.id, TENANT).catch(() => undefined)

		expect((await h.store.getProject(h.project.id, TENANT))?.status).toBe('open')
	})
})
