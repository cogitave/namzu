import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChatCompletionParams, type LLMProvider, MockLLMProvider } from '@namzu/sdk'
import { expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { type SubagentMessage, createSubagentRuntime } from '../runtime.js'

// A sub-agent can address `main`; the text is queued for the main
// conversation's next turn.

async function launch(options: { listen: boolean; calls: readonly Record<string, unknown>[] }) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-message-'))
	const parent = await subagentParentFixture(cwd)
	const requests: ChatCompletionParams[] = []
	const messages: SubagentMessage[] = []
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		resolveParent: parent.resolveParent,
		buildTools: () => [],
		// This bare runtime has no authorization gate, so every call is reviewed; the
		// real host's read-only rule lets this tool through without a prompt.
		resolveResumeHandler: () => async () => ({ action: 'approve_tools' }),
		buildProvider: () => {
			const script = new MockLLMProvider({
				turns: [
					...options.calls.map((args, index) => ({
						toolCalls: [{ id: `msg-${index}`, name: 'send_message', args }],
					})),
					{ text: 'all done' },
				],
			})
			return {
				id: 'worker',
				name: 'Worker',
				async *chatStream(params) {
					requests.push(params)
					yield* script.chatStream(params)
				},
			} satisfies LLMProvider
		},
	})
	if (options.listen) runtime.onChildMessage((message) => messages.push(message))
	const context = {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	} as never
	const result = await runtime.agentTool.execute(
		{ description: 'Count words', prompt: 'count the words', run_in_background: true },
		context,
	)
	const taskId = (result.data as { task_id: string }).task_id
	const waited = await runtime.waitForTaskTool.execute({ task_id: taskId }, context)
	return {
		requests,
		messages,
		waited,
		runtime,
		taskId,
		close: async () => {
			await runtime.close()
			removeTempDir(cwd)
		},
	}
}

const toolNames = (params: ChatCompletionParams | undefined) =>
	(params?.tools ?? []).map((tool) => tool.function.name)

it('lets a running child send the main conversation a message while somebody listens', async () => {
	const run = await launch({
		listen: true,
		calls: [{ to: 'main', message: 'Found the bug in a.txt' }],
	})
	try {
		expect(toolNames(run.requests[0])).toContain('send_message')
		expect(run.messages).toHaveLength(1)
		expect(run.messages[0]).toMatchObject({
			agentId: 'general-purpose',
			description: 'Count words',
			text: 'Found the bug in a.txt',
			taskId: run.taskId,
		})
		// The child is told what it was sent, and finishes normally.
		const answered = JSON.stringify(run.requests[1]?.messages)
		expect(answered).toContain("Message queued for the main conversation's next turn.")
		expect(run.waited.success).toBe(true)
	} finally {
		await run.close()
	}
})

it('gives a child no such tool when nobody could show its message', async () => {
	const run = await launch({ listen: false, calls: [] })
	try {
		expect(toolNames(run.requests[0])).not.toContain('send_message')
	} finally {
		await run.close()
	}
})

it('refuses another recipient and a blank message in plain words, and sends nothing', async () => {
	const run = await launch({
		listen: true,
		calls: [
			{ to: 'someone-else', message: 'hi' },
			{ to: 'main', message: '   ' },
		],
	})
	try {
		expect(run.messages).toEqual([])
		const seen = JSON.stringify(run.requests.at(-1)?.messages)
		expect(seen).toContain("No agent named 'someone-else' is currently addressable")
		expect(seen).toContain('Message must not be blank.')
	} finally {
		await run.close()
	}
})
