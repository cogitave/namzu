import { generateTurnId } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { endChild, logHome, parentSession, spawnChild } from '../__fixtures__/session-logs.js'
import { createSubagentRuntime } from '../runtime.js'
import { createSavedAgentHistory } from '../saved-agents.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('answers agent_task_list history from the logs without launching or listing a live task', async () => {
	const fixture = await logHome()
	roots.push(fixture.root)
	const parent = await parentSession(fixture)
	const child = await spawnChild(fixture, parent, { description: 'saved child' })
	const childTurn = generateTurnId()
	await child.writer.beginTurn(childTurn, 'return proof')
	await child.writer.completeTurn(childTurn, 'SAVED_CHILD_RESULT_712', 10)
	await endChild(parent, child.sessionId, 'completed', 10)
	const index = await fixture.index()

	const scope = await subagentParentFixture(fixture.root)
	let providers = 0
	const runtime = await createSubagentRuntime({
		cwd: fixture.root,
		model: 'mock',
		resolveParent: scope.resolveParent,
		savedAgents: () =>
			createSavedAgentHistory({
				index,
				paths: fixture.paths,
				session: { sessionId: parent.sessionId },
			}),
		buildTools: () => [],
		buildProvider: () => {
			providers++
			throw new Error('no child is launched by a history read')
		},
	})
	const context = {
		sessionId: scope.scope.sessionId,
		turnId: scope.scope.turnId,
		workingDirectory: fixture.root,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	}
	try {
		const listed = await runtime.agentTaskListTool.execute({ history: true }, context as never)
		expect(listed.success).toBe(true)
		expect(listed.output).toContain(child.sessionId)
		const result = await runtime.agentTaskListTool.execute(
			{ history: true, session_id: child.sessionId },
			context as never,
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('SAVED_CHILD_RESULT_712')
		expect(result.output).toContain('historical evidence from earlier turns')
		expect((await runtime.gatewayForTurn(scope.scope.turnId)).listTasks()).toEqual([])
		expect(providers).toBe(0)
	} finally {
		await runtime.close()
	}
})
