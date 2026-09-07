import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionStore,
	MockLLMProvider,
	type RunEvent,
	type RunId,
	type ToolContext,
	ToolRegistry,
	generateRunId,
	generateSessionId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { SubagentPathBuilder, resolveSubagentParent } from '../parent.js'
import { type SubagentParent, createSubagentRuntime } from '../runtime.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})
function directory() {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-parent-scope-'))
	dirs.push(dir)
	return dir
}
function context(runId: RunId, cwd: string): ToolContext {
	return {
		runId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	}
}

describe('delegation belongs to the actual parent', () => {
	it('keeps concurrent parent runs and conversations distinct inside one project', async () => {
		const cwd = directory()
		const fixture = await subagentParentFixture(cwd)
		const first = await fixture.resolveParent(fixture.scope.runId)
		const secondRunId = generateRunId()
		const second = { ...first, sessionId: generateSessionId() }
		const parents = new Map([
			[fixture.scope.runId, first],
			[secondRunId, second],
		])
		const projectStateRoot = join(cwd, 'state', 'projects', first.project.id)
		const events: RunEvent[] = []
		const providerSessions: (string | undefined)[] = []
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'mock',
			pathBuilder: new SubagentPathBuilder(projectStateRoot, first.project.id),
			resolveParent: async (runId) => {
				const parent = parents.get(runId)
				if (!parent) throw new Error('Parent no longer active')
				return parent
			},
			buildProvider: (sessionId) => {
				providerSessions.push(sessionId)
				return new MockLLMProvider({ turns: [{ text: 'done' }] })
			},
			buildTools: () => new ToolRegistry(),
			onEvent: (event) => {
				events.push(event)
			},
		})
		try {
			const results = await Promise.all(
				[fixture.scope.runId, secondRunId].flatMap((runId) =>
					[1, 2].map(() =>
						runtime.agentTool.execute(
							{ description: 'inspect', prompt: 'report' },
							context(runId, cwd),
						),
					),
				),
			)
			expect(results.every((result) => result.success)).toBe(true)
			expect(providerSessions).toHaveLength(4)
			expect(providerSessions.filter((id) => id === first.sessionId)).toHaveLength(2)
			expect(providerSessions.filter((id) => id === second.sessionId)).toHaveLength(2)
			const spawned = events.filter((event) => event.type === 'subsession_spawned')
			expect(spawned).toHaveLength(4)
			for (const event of spawned) {
				const parent = parents.get(event.runId)
				expect(parent).toBeDefined()
				expect(event.parentSessionId).toBe(parent?.sessionId)
				expect(event.lineage.rootSessionId).toBe(parent?.sessionId)
				expect(event.spawnedBy).toEqual({
					kind: 'agent',
					agentId: 'namzu',
					tenantId: first.project.tenantId,
				})
			}
			expect(existsSync(join(projectStateRoot, 'subagents', 'projects'))).toBe(false)
			const files = readdirSync(projectStateRoot, { recursive: true, encoding: 'utf8' })
			const runs = files.filter((file) => file.endsWith('/run.json'))
			expect(runs).toHaveLength(4)
			for (const file of runs) {
				const meta = JSON.parse(readFileSync(join(projectStateRoot, file), 'utf8'))
				expect(parents.has(meta.parentRunId)).toBe(true)
				expect(meta.depth).toBe(1)
				expect(file).toContain(`/runs/${meta.parentRunId}/children/${meta.id}/`)
			}
			parents.delete(fixture.scope.runId)
			await runtime.releaseRun(fixture.scope.runId)
			await expect(runtime.gatewayForRun(fixture.scope.runId)).rejects.toThrow(
				'Parent no longer active',
			)
			expect((await runtime.gatewayForRun(secondRunId)).listTasks()).toHaveLength(2)
		} finally {
			await runtime.close()
		}
	})

	it('refuses a gateway released while its parent metadata is still loading', async () => {
		const cwd = directory()
		const fixture = await subagentParentFixture(cwd)
		const parent = await fixture.resolveParent(fixture.scope.runId)
		let resolve!: (parent: SubagentParent) => void
		const waiting = new Promise<SubagentParent>((done) => {
			resolve = done
		})
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'mock',
			resolveParent: () => waiting,
			buildProvider: () => new MockLLMProvider({ turns: [] }),
			buildTools: () => new ToolRegistry(),
		})
		const pending = runtime.gatewayForRun(fixture.scope.runId)
		const rejected = expect(pending).rejects.toThrow('released')
		const releasing = runtime.releaseRun(fixture.scope.runId)
		resolve(parent)
		await Promise.all([rejected, releasing])
		await runtime.close()
	})

	it('loads real project limits and the durable session topic on resume', async () => {
		const cwd = directory()
		const fixture = await subagentParentFixture(cwd)
		const store = new DiskSessionStore({ rootDir: join(cwd, 'state') })
		await expect(resolveSubagentParent(fixture.scope, cwd, join(cwd, 'state'))).rejects.toThrow(
			'missing',
		)
		const project = await store.createProject(
			{
				tenantId: fixture.scope.tenantId,
				name: 'real',
				rootPath: cwd,
				config: { maxDelegationWidth: 2 },
			},
			fixture.scope.tenantId,
		)
		const session = await store.createSession(
			{ projectId: project.id, topicId: fixture.scope.topicId, currentActor: null },
			fixture.scope.tenantId,
		)
		const parent = await resolveSubagentParent(
			{ ...fixture.scope, projectId: project.id, sessionId: session.id },
			cwd,
			join(cwd, 'state'),
		)
		expect(parent.project.id).toBe(project.id)
		expect(parent.project.config.maxDelegationWidth).toBe(2)
		expect(parent.topic.id).toBe(session.topicId)
		await store.updateSession({ ...session, status: 'archived' }, fixture.scope.tenantId)
		await expect(
			resolveSubagentParent(
				{ ...fixture.scope, projectId: project.id, sessionId: session.id },
				cwd,
				join(cwd, 'state'),
			),
		).rejects.toThrow('archived')
		const current = await store.getSession(session.id, fixture.scope.tenantId)
		if (!current) throw new Error('session disappeared')
		await store.updateSession({ ...current, status: 'idle' }, fixture.scope.tenantId)
		await store.setProjectStatus(
			project.id,
			'archived',
			fixture.scope.tenantId,
			project.ownerVersion,
		)
		const archived = await resolveSubagentParent(
			{ ...fixture.scope, projectId: project.id, sessionId: session.id },
			cwd,
			join(cwd, 'state'),
		)
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'mock',
			resolveParent: async () => archived,
			buildProvider: () => new MockLLMProvider({ turns: [] }),
			buildTools: () => new ToolRegistry(),
		})
		try {
			await expect(runtime.gatewayForRun(fixture.scope.runId)).rejects.toThrow()
		} finally {
			await runtime.close()
		}
	})
})
