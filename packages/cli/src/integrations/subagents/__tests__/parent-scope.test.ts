import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	InMemorySessionStore,
	MockLLMProvider,
	type SessionEvent,
	SessionPaths,
	ToolRegistry,
	createUserMessage,
	drainQuery,
	generateSessionId,
	generateTurnId,
	openSessionIndex,
	readSessionLog,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { resolveSubagentParent } from '../parent.js'
import { listSavedChildren } from '../replay.js'
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

describe('delegation belongs to the actual parent', () => {
	it('keeps concurrent parent turns and conversations distinct inside one project', async () => {
		const cwd = directory()
		const fixture = await subagentParentFixture(cwd)
		const first = await fixture.resolveParent(fixture.scope.turnId)
		const secondTurnId = generateTurnId()
		const second = { ...first, sessionId: generateSessionId() }
		const parents = new Map([
			[fixture.scope.turnId, first],
			[secondTurnId, second],
		])
		const home = join(cwd, 'state')
		const paths = new SessionPaths({ home, slug: '-work-parent-scope' })
		const events: SessionEvent[] = []
		const providerSessions: (string | undefined)[] = []
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'mock',
			paths,
			resolveParent: async (turnId) => {
				const parent = parents.get(turnId)
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
			// Each parent is a real turn, run the way the TUI runs one: its own
			// session log under the layout, the delegation gateway for that turn,
			// and a model that launches two agents in one step. The parent's log
			// is what records its children, so the children are listed from it
			// below rather than from anything this process remembers.
			const turns = await Promise.all(
				[fixture.scope.turnId, secondTurnId].map(async (turnId) => {
					const parent = parents.get(turnId) as SubagentParent
					const tools = new ToolRegistry()
					tools.register(runtime.agentTool)
					const call = (id: string) => ({
						id,
						name: runtime.agentTool.name,
						rawArguments: JSON.stringify({ description: 'inspect', prompt: 'report' }),
					})
					return drainQuery({
						provider: new MockLLMProvider({
							turns: [
								{ toolCalls: [call(`${turnId}-a`), call(`${turnId}-b`)] },
								{ text: 'both reported' },
							],
						}),
						tools,
						turnConfig: {
							model: 'mock',
							timeoutMs: 30_000,
							tokenBudget: 0,
							maxIterations: 4,
							maxResponseTokens: 256,
						},
						agentId: 'namzu',
						agentName: 'Namzu',
						workingDirectory: cwd,
						sessionId: parent.sessionId,
						turnId,
						topicId: parent.topic.id,
						projectId: parent.project.id,
						tenantId: parent.project.tenantId,
						paths,
						taskScheduler: await runtime.gatewayForTurn(turnId),
						messages: [createUserMessage('delegate')],
					})
				}),
			)
			expect(turns.map((turn) => turn.status)).toEqual(['completed', 'completed'])
			expect(providerSessions).toHaveLength(4)
			expect(providerSessions.filter((id) => id === first.sessionId)).toHaveLength(2)
			expect(providerSessions.filter((id) => id === second.sessionId)).toHaveLength(2)
			const spawned = events.filter((event) => event.type === 'child_session_spawned')
			expect(spawned).toHaveLength(4)
			for (const event of spawned) {
				const parent = parents.get(event.turnId)
				expect(parent).toBeDefined()
				expect(event.sessionId).toBe(parent?.sessionId)
			}
			// Everything the delegation wrote is under the layout's home, and
			// nothing is written into the working directory beside it.
			expect(readdirSync(cwd)).toEqual(['state'])
			const index = await openSessionIndex({ home, backend: 'scan' })
			for (const [turnId, parent] of parents) {
				const children = await listSavedChildren({
					index,
					paths,
					session: { sessionId: parent.sessionId },
				})
				expect(children).toHaveLength(2)
				for (const child of children) {
					expect(child.parentTurnId).toBe(turnId)
					// The child's own log and its meta file, where the layout puts
					// them. Pinned rather than assumed, because opening a finished
					// child reads this log: a change that stopped writing it would
					// leave the parent's records intact and every replay empty.
					expect(child.logPath).toBe(
						paths.subagentLog({ sessionId: parent.sessionId }, child.sessionId),
					)
					expect(
						existsSync(paths.subagentMeta({ sessionId: parent.sessionId }, child.sessionId)),
					).toBe(true)
					const log = await readSessionLog(child.logPath, { sessionId: child.sessionId })
					const records = log.entries.map((entry) => entry.record)
					const started = records.find((record) => record.type === 'session_started')
					expect(started?.type === 'session_started' && started.parent).toMatchObject({
						sessionId: parent.sessionId,
						turnId,
						rootSessionId: parent.sessionId,
						depth: 1,
					})
					const types = records.map((record) => record.type)
					expect(types).toContain('turn_started')
					expect(types).toContain('turn_completed')
				}
			}
			parents.delete(fixture.scope.turnId)
			await runtime.releaseTurn(fixture.scope.turnId)
			await expect(runtime.gatewayForTurn(fixture.scope.turnId)).rejects.toThrow(
				'Parent no longer active',
			)
			expect((await runtime.gatewayForTurn(secondTurnId)).listTasks()).toHaveLength(2)
		} finally {
			await runtime.close()
		}
	})

	it('refuses a gateway released while its parent metadata is still loading', async () => {
		const cwd = directory()
		const fixture = await subagentParentFixture(cwd)
		const parent = await fixture.resolveParent(fixture.scope.turnId)
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
		const pending = runtime.gatewayForTurn(fixture.scope.turnId)
		const rejected = expect(pending).rejects.toThrow('released')
		const releasing = runtime.releaseTurn(fixture.scope.turnId)
		resolve(parent)
		await Promise.all([rejected, releasing])
		await runtime.close()
	})

	it('loads real project limits and the durable session topic on resume', async () => {
		const cwd = directory()
		const fixture = await subagentParentFixture(cwd)
		const store = new InMemorySessionStore()
		await expect(resolveSubagentParent(fixture.scope, cwd, store)).rejects.toThrow('missing')
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
			store,
		)
		expect(parent.project.id).toBe(project.id)
		expect(parent.project.config.maxDelegationWidth).toBe(2)
		expect(parent.topic.id).toBe(session.topicId)
		await store.updateSession({ ...session, status: 'archived' }, fixture.scope.tenantId)
		await expect(
			resolveSubagentParent(
				{ ...fixture.scope, projectId: project.id, sessionId: session.id },
				cwd,
				store,
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
			store,
		)
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'mock',
			resolveParent: async () => archived,
			buildProvider: () => new MockLLMProvider({ turns: [] }),
			buildTools: () => new ToolRegistry(),
		})
		try {
			await expect(runtime.gatewayForTurn(fixture.scope.turnId)).rejects.toThrow()
		} finally {
			await runtime.close()
		}
	})
})
