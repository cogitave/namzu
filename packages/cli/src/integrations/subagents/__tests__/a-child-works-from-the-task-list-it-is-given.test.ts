import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTaskStore, type LLMProvider, MockLLMProvider, type TaskStore } from '@namzu/sdk'
import { expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

// A child has no task tools unless the host hands the runtime a list. With a list, the child's
// task_create writes into it, so a team can share one list across members.

async function run(childTaskStore: (() => TaskStore | undefined) | undefined) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-task-list-'))
	const parent = await subagentParentFixture(cwd)
	const results: string[] = []
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		resolveParent: parent.resolveParent,
		buildTools: () => [],
		resolveResumeHandler: () => async () => ({ action: 'approve_tools' }),
		...(childTaskStore ? { childTaskStore } : {}),
		buildProvider: () => {
			const script = new MockLLMProvider({
				turns: [
					// Task tools are deferred: the child loads them by name first.
					{
						toolCalls: [{ id: 'ld', name: 'search_tools', args: { query: 'select:task_create' } }],
					},
					{
						toolCalls: [{ id: 'mk', name: 'task_create', args: { subject: 'Write the parser' } }],
					},
					{ text: 'all done' },
				],
			})
			return {
				id: 'worker',
				name: 'Worker',
				async *chatStream(params) {
					results.push(JSON.stringify(params.messages))
					yield* script.chatStream(params)
				},
			} satisfies LLMProvider
		},
	})
	const context = {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	} as never
	const started = await runtime.agentTool.execute(
		{ description: 'Plan', prompt: 'plan it', run_in_background: true },
		context,
	)
	const taskId = (started.data as { task_id: string }).task_id
	await runtime.waitForTaskTool.execute({ task_id: taskId }, context)
	return {
		results,
		cwd,
		close: async () => {
			await runtime.close()
			removeTempDir(cwd)
		},
	}
}

it('a child writes into the task list the host gave the runtime', async () => {
	const rootDir = mkdtempSync(join(tmpdir(), 'namzu-child-task-root-'))
	const store = new FileTaskStore({ listId: 'team', rootDir })
	const r = await run(() => store)
	try {
		const tasks = await store.list()
		expect(tasks.map((t) => t.subject)).toEqual(['Write the parser'])
	} finally {
		await r.close()
		removeTempDir(rootDir)
	}
})

it('a child with no list given has no task tools, as before', async () => {
	const r = await run(undefined)
	try {
		expect(r.results.join('\n')).not.toContain('Task created')
	} finally {
		await r.close()
	}
})
