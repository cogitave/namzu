import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	MockLLMProvider,
	RunCancelled,
	type ToolContext,
	ToolRegistry,
	cancelCauseOf,
	createUserMessage,
	defineTool,
	drainQuery,
	generateRunId,
	mcpJsonSchemaToZod,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

const workdirs: string[] = []
afterEach(() => {
	for (const cwd of workdirs.splice(0)) removeTempDir(cwd)
})

const CORRECTION = 'CORRECTION: inspect the beta branch and retain the exact identifier.'
const CHILD_RESULT = 'BACKGROUND_CHILD_EVIDENCE: beta branch identifier 719.'

/** Real parent and child queries, with only the child's first model response held. */
async function backgroundRun() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-background-message-'))
	workdirs.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const foreignRunId = generateRunId()
	const childStarted = deferred<AbortSignal>()
	const childRelease = deferred<void>()
	const childUnwound = deferred<void>()
	const childRequests: ChatCompletionParams[] = []
	const parentRequests: ChatCompletionParams[] = []
	const order: string[] = []
	let childReleased = false
	let childCount = 0
	let independentWhileHeld = false
	let taskId: string | undefined
	const childScript = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'child_probe_1', name: 'child_probe', args: {} }] },
			{ toolCalls: [{ id: 'child_probe_2', name: 'child_probe', args: {} }] },
			{ text: CHILD_RESULT },
		],
	})
	const runtime = await createSubagentRuntime({
		resolveParent: (runId) =>
			parent.resolveParent(runId === foreignRunId ? parent.scope.runId : runId),
		cwd,
		model: 'mock-model',
		tokenBudget: 1_000_000,
		resolveResumeHandler: () => async (request) =>
			request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' },
		buildTools: () => {
			const tools = new ToolRegistry()
			tools.register(
				defineTool({
					name: 'child_probe',
					description: 'An independent read-only child observation.',
					inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
					category: 'custom',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: true,
					execute: async () => ({ success: true, output: 'child observation' }),
				}),
			)
			return tools
		},
		buildProvider: () => {
			childCount++
			return {
				id: 'held-background-child',
				name: 'Held background child',
				async *chatStream(params) {
					const index = childRequests.length
					childRequests.push(params)
					if (index === 0) {
						order.push('child started')
						childStarted.resolve(params.signal as AbortSignal)
						try {
							// Ignore cancellation until explicitly released: the runtime
							// must fence late output as well as abort the transport signal.
							await childRelease.promise
							order.push('child released')
							yield* childScript.chatStream(params)
						} finally {
							childUnwound.resolve()
						}
					} else yield* childScript.chatStream(params)
				},
			} satisfies LLMProvider
		},
	})
	const gateway = await runtime.gatewayForRun(parent.scope.runId)
	const completionInbox = await runtime.completionInboxForRun(parent.scope.runId)
	const parentScript = new MockLLMProvider({
		nextTurn: (params, index) => {
			if (index === 0) {
				return {
					toolCalls: [
						{
							id: 'launch',
							name: 'Agent',
							args: {
								description: 'background investigation',
								prompt: 'Inspect the branch identifier.',
								run_in_background: true,
							},
						},
					],
				}
			}
			if (index === 1) {
				const receipt = params.messages.find(
					(message) => message.role === 'tool' && message.toolCallId === 'launch',
				)
				taskId = String(receipt?.content).match(/as task ([0-9a-f-]+);/)?.[1]
				return { toolCalls: [{ id: 'independent', name: 'parent_work', args: {} }] }
			}
			if (index === 2) {
				return {
					toolCalls: [
						{
							id: 'correction',
							name: 'send_message',
							args: { task_id: taskId, message: CORRECTION },
						},
					],
				}
			}
			return {
				text:
					index === 3
						? 'My independent work is complete; the delegate remains tracked.'
						: 'I have now incorporated the delegated result.',
			}
		},
	})
	const provider: LLMProvider = {
		id: 'background-parent',
		name: 'Background parent',
		chatStream(params) {
			parentRequests.push(params)
			return parentScript.chatStream(params)
		},
	}
	const tools = new ToolRegistry()
	tools.register(runtime.agentTool)
	tools.register(runtime.sendMessageTool)
	tools.register(
		defineTool({
			name: 'parent_work',
			description: 'Work the parent can do independently of its delegate.',
			inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute() {
				const signal = await childStarted.promise
				independentWhileHeld = !childReleased && !signal.aborted
				order.push('parent independent work')
				return { success: true, output: 'Independent parent work completed.' }
			},
		}),
	)
	const caller = new AbortController()
	const pending = drainQuery({
		provider,
		tools,
		taskScheduler: gateway,
		completionInbox,
		// No operator inbox or waiter: background progress must not need input.
		runConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 1_000_000,
			maxIterations: 10,
			permissionMode: 'auto',
		},
		agentId: 'namzu',
		agentName: 'namzu',
		messages: [createUserMessage('Investigate while continuing independent work.')],
		workingDirectory: cwd,
		...parent.scope,
		signal: caller.signal,
	})
	pending.catch(() => {})
	const context: ToolContext = {
		runId: parent.scope.runId,
		workingDirectory: cwd,
		abortSignal: caller.signal,
		env: {},
		log() {},
	}
	const release = () => {
		childReleased = true
		childRelease.resolve()
	}
	return {
		parent,
		foreignRunId,
		context,
		runtime,
		gateway,
		completionInbox,
		parentRequests,
		childRequests,
		childStarted,
		order,
		caller,
		pending,
		taskId: () => taskId,
		childCount: () => childCount,
		independentWhileHeld: () => independentWhileHeld,
		release,
		async close() {
			caller.abort(new RunCancelled('user'))
			release()
			await pending.catch(() => {})
			await runtime.close()
			if (childRequests.length > 0) await childUnwound.promise
		},
	}
}

it('does independent work, delivers one correction at the next child boundary, and receives one completion', async () => {
	const run = await backgroundRun()
	try {
		await vi.waitFor(() => expect(run.parentRequests).toHaveLength(4), { timeout: 2_500 })
		expect(run.independentWhileHeld()).toBe(true)
		expect(run.order).toEqual(['child started', 'parent independent work'])
		expect(run.childCount()).toBe(1)
		expect(run.childRequests).toHaveLength(1)
		const taskId = run.taskId()
		expect(taskId).toBeDefined()
		const receipt = run.parentRequests[1]?.messages.find(
			(message) => message.role === 'tool' && message.toolCallId === 'launch',
		)
		expect(String(receipt?.content)).toContain('Continue independent work')
		expect(String(receipt?.content)).toContain('has not completed')
		const acknowledgement = run.parentRequests[3]?.messages.find(
			(message) => message.role === 'tool' && message.toolCallId === 'correction',
		)
		expect(acknowledgement).not.toMatchObject({ isError: true })
		expect(String(acknowledgement?.content)).toContain('Message queued')
		expect(run.childRequests[0]?.messages.some((message) => message.content === CORRECTION)).toBe(
			false,
		)

		const foreign = await run.runtime.sendMessageTool.execute(
			{ task_id: taskId, message: 'FOREIGN_CORRECTION_MUST_NOT_ARRIVE' },
			{ ...run.context, runId: run.foreignRunId },
		)
		expect(foreign.success).toBe(false)
		expect(foreign.error).toContain('does not belong to this parent run')

		run.release()
		const result = await run.pending
		expect(result.status).toBe('completed')
		expect(result.result).toBe('I have now incorporated the delegated result.')
		expect(run.childRequests).toHaveLength(3)
		for (const request of run.childRequests.slice(1)) {
			expect(request.messages.filter((message) => message.content === CORRECTION)).toHaveLength(1)
			expect(
				request.messages.some((message) =>
					String(message.content).includes('FOREIGN_CORRECTION_MUST_NOT_ARRIVE'),
				),
			).toBe(false)
		}
		const notifications = result.messages.filter((message) =>
			String(message.content).includes('<task-notification>'),
		)
		expect(notifications).toHaveLength(1)
		expect(String(notifications[0]?.content)).toContain(CHILD_RESULT)
		expect(String(notifications[0]?.content)).toContain(taskId)
		expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(3)
		expect(run.completionInbox.drain()).toEqual([])
		expect(run.gateway.listTasks()).toHaveLength(1)
		expect(run.gateway.listTasks()[0]?.state).toBe('completed')
		const finished = await run.runtime.sendMessageTool.execute(
			{ task_id: taskId, message: 'Do not restart the finished child.' },
			run.context,
		)
		expect(finished.success).toBe(false)
		expect(finished.error).toContain('finished')
		expect(run.childCount()).toBe(1)
	} finally {
		await run.close()
	}
})

it('cancels a background child with its parent after the launch call has already returned', async () => {
	const run = await backgroundRun()
	try {
		await vi.waitFor(() => expect(run.parentRequests).toHaveLength(4), { timeout: 2_500 })
		const signal = await run.childStarted.promise
		expect(run.independentWhileHeld()).toBe(true)
		expect(signal.aborted).toBe(false)
		run.caller.abort(new RunCancelled('user'))
		const result = await run.pending.finally(() => run.runtime.releaseRun(run.parent.scope.runId))
		expect(result.status).toBe('cancelled')
		expect(signal.aborted).toBe(true)
		expect(cancelCauseOf(signal.reason)).toBe('parent')
		expect(run.childRequests).toHaveLength(1)
		expect(result.messages.some((message) => String(message.content).includes(CHILD_RESULT))).toBe(
			false,
		)
	} finally {
		await run.close()
	}
})
