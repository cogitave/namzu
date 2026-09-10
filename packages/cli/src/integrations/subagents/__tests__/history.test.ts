import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	MockLLMProvider,
	ToolRegistry,
	generateRunId,
	generateSessionId,
	generateTaskId,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { DelegationHistory, createDelegationHistoryStep } from '../history.js'
import { createSubagentRuntime } from '../runtime.js'

const directories: string[] = []
function directory() {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-agent-history-'))
	directories.push(dir)
	return dir
}
afterEach(() => {
	for (const dir of directories.splice(0)) removeTempDir(dir)
})

it('reopens unresolved evidence without claiming a live or completed task, and isolates sessions', () => {
	const root = directory()
	const sessionId = generateSessionId()
	const taskId = generateTaskId()
	new DelegationHistory(root, sessionId).write({
		taskId,
		parentRunId: generateRunId(),
		description: 'check effects',
		status: 'unresolved',
	})
	expect(new DelegationHistory(root, sessionId).read(taskId).status).toBe('unresolved')
	expect(new DelegationHistory(root, generateSessionId()).list().tasks).toEqual([])
	expect(() => new DelegationHistory(root, sessionId).read('../outside')).toThrow()
})

it('retains bounded partial results and refuses corrupt receipts instead of an empty archive', () => {
	const root = directory()
	const sessionId = generateSessionId()
	const taskId = generateTaskId()
	const history = new DelegationHistory(root, sessionId)
	history.write({
		taskId,
		parentRunId: generateRunId(),
		description: 'partial',
		status: 'incomplete',
		output: 'x'.repeat(17_000),
	})
	expect(history.read(taskId)).toMatchObject({ status: 'incomplete', outputTruncated: true })
	expect(history.read(taskId).output).toHaveLength(16_000)
	writeFileSync(join(root, 'delegation-history', sessionId, `${taskId}.json`), '{}')
	expect(() => history.list()).toThrow('Invalid delegation receipt')
})

it('retrieves a real completed child after recreating the runtime, without launching another provider', async () => {
	const cwd = directory()
	const parent = await subagentParentFixture(cwd)
	const nextRun = generateRunId()
	let providers = 0
	const options = {
		cwd,
		historyRoot: cwd,
		model: 'mock',
		resolveParent: (runId: ReturnType<typeof generateRunId>) =>
			parent.resolveParent(runId === nextRun ? parent.scope.runId : runId),
		buildTools: () => new ToolRegistry(),
		buildProvider: () => {
			providers++
			return new MockLLMProvider({ turns: [{ text: 'SAVED_CHILD_RESULT_712' }] })
		},
	}
	const context = {
		runId: parent.scope.runId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	}
	const first = await createSubagentRuntime(options)
	let taskId: string
	try {
		await first.agentTool.execute({ description: 'saved child', prompt: 'return proof' }, context)
		taskId = (await first.gatewayForRun(context.runId)).listTasks()[0]!.taskId
	} finally {
		await first.close()
	}
	const reopened = await createSubagentRuntime(options)
	try {
		const result = await reopened.agentTaskListTool.execute(
			{ history: true, task_id: taskId! },
			{ ...context, runId: nextRun },
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('SAVED_CHILD_RESULT_712')
		expect(result.output).toContain('historical evidence, not live tasks')
		expect((await reopened.gatewayForRun(nextRun)).listTasks()).toEqual([])
		expect(providers).toBe(1)
	} finally {
		await reopened.close()
	}
})

it('places earlier task status in resumed model context while excluding this run and respecting pressure', async () => {
	const root = directory()
	const sessionId = generateSessionId()
	const earlier = generateRunId()
	const current = generateRunId()
	const history = new DelegationHistory(root, sessionId)
	history.write({
		taskId: generateTaskId(),
		parentRunId: earlier,
		description: 'previous check',
		status: 'unresolved',
	})
	history.write({
		taskId: generateTaskId(),
		parentRunId: current,
		description: 'current check',
		status: 'unresolved',
	})
	const step = createDelegationHistoryStep(root, sessionId)
	const context = {
		runId: current,
		prepared: { system: 'existing rules' },
		messages: [],
		steps: [],
		stepNumber: 1,
	}
	const result = await step(context)
	expect(result?.system).toContain('existing rules')
	expect(result?.system).toContain('previous check')
	expect(result?.system).toContain('unresolved')
	expect(result?.system).not.toContain('current check')
	expect(
		await step({ ...context, contextBudget: { remainingTokens: 100, windowTokens: 1000 } }),
	).toBeUndefined()
})
