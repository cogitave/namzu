import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	MockLLMProvider,
	type PrepareStepContext,
	type Toolset,
	createUserMessage,
	drainQuery,
	generateSessionId,
	generateTurnId,
	toolset,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { logHome, parentSession, spawnChild } from '../__fixtures__/session-logs.js'
import { createSubagentRuntime } from '../runtime.js'
import {
	type SavedAgent,
	type SavedAgentHistory,
	createSavedAgentHistory,
	createSavedAgentsStep,
} from '../saved-agents.js'

/**
 * The parent's log has no ending for a child that is still running, so a
 * reader of that log alone calls it `unresolved`. While the child's run is
 * live the live task answers for it: it is listed once, as running, and it is
 * not offered a second time as a saved agent. `unresolved` keeps its meaning
 * for a child with no ending and nothing live.
 *
 * Nothing here measures time: the child is held on a promise the test resolves.
 */

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

it('lists one running agent once, leaves no unresolved twin when it ends, and keeps unresolved for an orphan', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-live-twin-'))
	dirs.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const childStarted = deferred<void>()
	const childRelease = deferred<void>()
	const childScript = new MockLLMProvider({ turns: [{ text: 'done' }] })
	// The recorded view of the same child, as the parent's log shows it while it runs.
	let recorded: SavedAgent[] = []
	const orphanId = generateSessionId()
	const orphan: SavedAgent = {
		sessionId: orphanId,
		parentTurnId: 'earlier',
		description: 'crashed work',
		status: 'unresolved',
		spawnedAt: '2026-01-01T00:00:00.000Z',
	}
	const history: SavedAgentHistory = {
		async list() {
			return { agents: recorded, omitted: 0 }
		},
		async read(id) {
			const found = recorded.find((agent) => agent.sessionId === id)
			if (!found) throw new Error('none')
			return found
		},
	}
	const runtime = await createSubagentRuntime({
		resolveParent: (turnId) => parent.resolveParent(turnId),
		cwd,
		model: 'mock-model',
		tokenBudget: 1_000_000,
		backgroundByDefault: true,
		savedAgents: () => history,
		resolveResumeHandler: () => async () => ({ action: 'continue' }),
		buildTools: (): readonly Toolset[] => [],
		buildProvider: () =>
			({
				id: 'held-child',
				name: 'Held child',
				async *chatStream(params: ChatCompletionParams) {
					childStarted.resolve()
					await childRelease.promise
					yield* childScript.chatStream(params)
				},
			}) satisfies LLMProvider,
	})
	const gateway = await runtime.gatewayForTurn(parent.scope.turnId)
	const parentScript = new MockLLMProvider({
		nextTurn: (_params, index) =>
			index === 0
				? {
						toolCalls: [
							{
								id: 'launch',
								name: 'Agent',
								args: { description: 'beta lookup', prompt: 'Find the beta branch id.' },
							},
						],
					}
				: { text: 'Started.' },
	})
	const provider: LLMProvider = {
		id: 'parent',
		name: 'Parent',
		chatStream: (params) => parentScript.chatStream(params),
	}
	const context = {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	}
	try {
		await drainQuery({
			provider,
			toolsets: [toolset('test', [runtime.agentTool])],
			taskScheduler: gateway,
			completionInbox: await runtime.completionInboxForTurn(parent.scope.turnId),
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 10_000,
				tokenBudget: 1_000_000,
				maxIterations: 10,
				permissionMode: 'auto',
			},
			agentId: 'namzu',
			agentName: 'namzu',
			messages: [createUserMessage('Look up the beta branch.')],
			workingDirectory: cwd,
			...parent.scope,
		})
		await childStarted.promise
		const [task] = gateway.listTasks()
		const childSessionId = task?.childSessionId
		expect(childSessionId).toBeDefined()
		recorded = [
			{
				sessionId: childSessionId as never,
				parentTurnId: String(parent.scope.turnId),
				description: 'beta lookup',
				status: 'unresolved',
				spawnedAt: '2026-01-01T00:00:01.000Z',
			},
			orphan,
		]
		expect(runtime.liveChildSessionIds().has(String(childSessionId))).toBe(true)

		// Running: one live item, and the saved view does not repeat it.
		const live = JSON.parse(
			(await runtime.agentTaskListTool.execute({}, context as never)).output,
		) as { tasks: { state: string }[] }
		expect(live.tasks).toHaveLength(1)
		const saved = JSON.parse(
			(await runtime.agentTaskListTool.execute({ history: true }, context as never)).output,
		) as { agents: { sessionId: string; status: string }[] }
		expect(saved.agents.map((agent) => agent.sessionId)).toEqual([orphanId])
		const one = await runtime.agentTaskListTool.execute(
			{ history: true, session_id: String(childSessionId) },
			context as never,
		)
		expect(one.success).toBe(false)
		expect(one.error).toContain('still running')

		// The prompted view leaves it out too.
		const step = createSavedAgentsStep(history, () => runtime.liveChildSessionIds())
		const prompted = await step({
			sessionId: parent.scope.sessionId,
			turnId: generateTurnId(),
			prepared: { system: 'rules' },
			messages: [],
			steps: [],
			stepNumber: 1,
		} as unknown as PrepareStepContext)
		const text = prompted?.recordedContext?.[0]?.text ?? ''
		expect(text).toContain('crashed work')
		expect(text).not.toContain('beta lookup')

		// Ended: no live task, and the recorded entry carries its real ending.
		childRelease.resolve()
		await gateway.waitForTask(task?.taskId as never)
		expect(runtime.liveChildSessionIds().size).toBe(0)
		recorded = [
			{ ...(recorded[0] as SavedAgent), status: 'completed', endedAt: '2026-01-01T00:00:02.000Z' },
			orphan,
		]
		const after = JSON.parse(
			(await runtime.agentTaskListTool.execute({ history: true }, context as never)).output,
		) as { agents: { sessionId: string; status: string }[] }
		expect(after.agents.filter((agent) => agent.status === 'unresolved')).toEqual([
			expect.objectContaining({ sessionId: orphanId }),
		])
	} finally {
		childRelease.resolve()
		await runtime.close()
	}
})

it('still reads a recorded child with no ending and nothing live as unresolved', async () => {
	const fixture = await logHome()
	dirs.push(fixture.root)
	const parentLog = await parentSession(fixture)
	const child = await spawnChild(fixture, parentLog, { description: 'after a crash' })
	const history = createSavedAgentHistory({
		index: await fixture.index(),
		paths: fixture.paths,
		session: { sessionId: parentLog.sessionId },
	})
	expect((await history.list()).agents).toMatchObject([
		{ sessionId: child.sessionId, status: 'unresolved' },
	])
	const step = createSavedAgentsStep(history, () => new Set())
	const prompted = await step({
		sessionId: parentLog.sessionId,
		turnId: generateTurnId(),
		prepared: { system: 'rules' },
		messages: [],
		steps: [],
		stepNumber: 1,
	} as unknown as PrepareStepContext)
	expect(prompted?.recordedContext?.[0]?.text).toContain('unresolved')
})
