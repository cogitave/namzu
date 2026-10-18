import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	MockLLMProvider,
	type ToolContext,
	type Toolset,
	TurnCancelled,
	cancelCauseOf,
	createUserMessage,
	defineTool,
	drainQuery,
	generateTurnId,
	mcpJsonSchemaToZod,
	toolset,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

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
async function backgroundTurn() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-background-message-'))
	workdirs.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const foreignTurnId = generateTurnId()
	const childStarted = deferred<AbortSignal>()
	const childRelease = deferred<void>()
	const childUnwound = deferred<void>()
	const childRequests: ChatCompletionParams[] = []
	const parentRequests: ChatCompletionParams[] = []
	const fourthParentRequest = deferred<void>()
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
		resolveParent: (turnId) =>
			parent.resolveParent(turnId === foreignTurnId ? parent.scope.turnId : turnId),
		cwd,
		model: 'mock-model',
		tokenBudget: 1_000_000,
		resolveResumeHandler: () => async (request) =>
			request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' },
		buildTools: (): readonly Toolset[] => [
			toolset('test', [
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
			]),
		],
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
	const gateway = await runtime.gatewayForTurn(parent.scope.turnId)
	const completionInbox = await runtime.completionInboxForTurn(parent.scope.turnId)
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
			if (parentRequests.length === 4) fourthParentRequest.resolve()
			return parentScript.chatStream(params)
		},
	}
	const toolsets: Toolset[] = [
		toolset('test', [
			runtime.agentTool,
			runtime.sendMessageTool,
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
		]),
	]
	const caller = new AbortController()
	const pending = drainQuery({
		provider,
		toolsets,
		taskScheduler: gateway,
		completionInbox,
		// No operator inbox or waiter: background progress must not need input.
		turnConfig: {
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
	// A premature parent completion must wake the assertion too. Neither
	// path measures how quickly a shared CI machine runs the child.
	const fourthRequestOrStop = Promise.race([
		fourthParentRequest.promise,
		pending.then(
			() => {},
			() => {},
		),
	])
	const context: ToolContext = {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
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
		foreignTurnId,
		context,
		runtime,
		gateway,
		completionInbox,
		parentRequests,
		fourthRequestOrStop,
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
			caller.abort(new TurnCancelled('user'))
			release()
			await pending.catch(() => {})
			await runtime.close()
			if (childRequests.length > 0) await childUnwound.promise
		},
	}
}

it('does independent work, delivers one correction at the next child boundary, and receives one completion', async () => {
	const turn = await backgroundTurn()
	try {
		await turn.fourthRequestOrStop
		expect(turn.parentRequests).toHaveLength(4)
		expect(turn.independentWhileHeld()).toBe(true)
		expect(turn.order).toEqual(['child started', 'parent independent work'])
		expect(turn.childCount()).toBe(1)
		expect(turn.childRequests).toHaveLength(1)
		const taskId = turn.taskId()
		expect(taskId).toBeDefined()
		const receipt = turn.parentRequests[1]?.messages.find(
			(message) => message.role === 'tool' && message.toolCallId === 'launch',
		)
		expect(String(receipt?.content)).toContain('Continue independent work')
		expect(String(receipt?.content)).toContain('has not completed')
		const acknowledgement = turn.parentRequests[3]?.messages.find(
			(message) => message.role === 'tool' && message.toolCallId === 'correction',
		)
		expect(acknowledgement).not.toMatchObject({ isError: true })
		expect(String(acknowledgement?.content)).toContain('Message queued')
		expect(turn.childRequests[0]?.messages.some((message) => message.content === CORRECTION)).toBe(
			false,
		)
		const delivered = turn.runtime.activity.getSnapshot().find((entry) => entry.taskId === taskId)
		expect(delivered?.transcript).toContainEqual(
			expect.objectContaining({ kind: 'system', direction: 'to-child', text: CORRECTION }),
		)

		const foreign = await turn.runtime.sendMessageTool.execute(
			{ task_id: taskId, message: 'FOREIGN_CORRECTION_MUST_NOT_ARRIVE' },
			{ ...turn.context, turnId: turn.foreignTurnId },
		)
		expect(foreign.success).toBe(false)
		expect(foreign.error).toContain('does not belong to this parent turn')
		const afterForeign = turn.runtime.activity
			.getSnapshot()
			.find((entry) => entry.taskId === taskId)
		expect(afterForeign?.transcript).toEqual(delivered?.transcript)

		turn.release()
		const result = await turn.pending
		expect(result.status).toBe('completed')
		expect(result.result).toBe('I have now incorporated the delegated result.')
		expect(turn.childRequests).toHaveLength(3)
		for (const request of turn.childRequests.slice(1)) {
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
		expect(turn.completionInbox.drain()).toEqual([])
		expect(turn.gateway.listTasks()).toHaveLength(1)
		expect(turn.gateway.listTasks()[0]?.state).toBe('completed')
		const finished = await turn.runtime.sendMessageTool.execute(
			{ task_id: taskId, message: 'Now check the second branch too.' },
			turn.context,
		)
		// A finished agent is resumed from its own transcript with the message.
		expect(finished.success).toBe(true)
		expect(finished.output).toContain('Resuming agent general-purpose')
		expect(
			turn.runtime.activity
				.getSnapshot()
				.some((entry) =>
					entry.transcript.some(
						(row) => row.kind === 'system' && row.text === 'Now check the second branch too.',
					),
				),
		).toBe(true)
	} finally {
		await turn.close()
	}
}, 30_000)

it('a refused send leaves no transcript row', async () => {
	const turn = await backgroundTurn()
	try {
		await turn.fourthRequestOrStop
		expect(turn.parentRequests).toHaveLength(4)
		const taskId = turn.taskId()
		expect(taskId).toBeDefined()
		const before = turn.runtime.activity
			.getSnapshot()
			.find((entry) => entry.taskId === taskId)?.transcript

		const unowned = await turn.runtime.sendMessageTool.execute(
			{ task_id: taskId, message: 'UNOWNED_REFUSAL_MUST_NOT_RENDER' },
			{ ...turn.context, turnId: turn.foreignTurnId },
		)
		expect(unowned.success).toBe(false)
		const afterUnowned = turn.runtime.activity
			.getSnapshot()
			.find((entry) => entry.taskId === taskId)?.transcript
		expect(afterUnowned).toEqual(before)
		expect(
			afterUnowned?.some(
				(row) => row.kind === 'system' && row.text.includes('UNOWNED_REFUSAL_MUST_NOT_RENDER'),
			),
		).toBe(false)

		turn.release()
		const result = await turn.pending
		expect(result.status).toBe('completed')

		// A finished agent takes the message and is resumed; it is not refused.
		const terminal = await turn.runtime.sendMessageTool.execute(
			{ task_id: taskId, message: 'RESUME_ME' },
			turn.context,
		)
		expect(terminal.success).toBe(true)
	} finally {
		await turn.close()
	}
}, 30_000)

it('a correction is rendered once', async () => {
	const turn = await backgroundTurn()
	try {
		await turn.fourthRequestOrStop
		expect(turn.parentRequests).toHaveLength(4)
		const taskId = turn.taskId()
		const deliveredRows = () =>
			turn.runtime.activity
				.getSnapshot()
				.find((entry) => entry.taskId === taskId)
				?.transcript.filter((row) => row.kind === 'system' && row.direction === 'to-child')

		const first = deliveredRows()
		expect(first).toHaveLength(1)
		expect(first?.[0]).toMatchObject({ text: CORRECTION })

		// Re-reading the projection is not a write: a second snapshot must
		// read back the same single row, never a duplicate from re-rendering.
		const second = deliveredRows()
		expect(second).toEqual(first)

		turn.release()
		await turn.pending
	} finally {
		await turn.close()
	}
}, 30_000)

it('cancels a background child with its parent after the launch call has already returned', async () => {
	const turn = await backgroundTurn()
	try {
		await turn.fourthRequestOrStop
		expect(turn.parentRequests).toHaveLength(4)
		const signal = await turn.childStarted.promise
		expect(turn.independentWhileHeld()).toBe(true)
		expect(signal.aborted).toBe(false)
		turn.caller.abort(new TurnCancelled('user'))
		const result = await turn.pending.finally(() =>
			turn.runtime.releaseTurn(turn.parent.scope.turnId),
		)
		expect(result.status).toBe('cancelled')
		expect(signal.aborted).toBe(true)
		expect(cancelCauseOf(signal.reason)).toBe('parent')
		expect(turn.childRequests).toHaveLength(1)
		expect(result.messages.some((message) => String(message.content).includes(CHILD_RESULT))).toBe(
			false,
		)
	} finally {
		await turn.close()
	}
}, 30_000)

it('stops one running child from the agents rail with the operator as the cause, and refuses a row it does not own', async () => {
	const turn = await backgroundTurn()
	try {
		await turn.fourthRequestOrStop
		const signal = await turn.childStarted.promise
		const [row] = turn.runtime.activity.getSnapshot()
		if (!row) throw new Error('the launched child never reached the monitor')
		expect(turn.runtime.stopChild('not-a-row')).toBe(false)
		expect(signal.aborted).toBe(false)
		expect(turn.runtime.stopChild(row.viewId)).toBe(true)
		expect(signal.aborted).toBe(true)
		expect(cancelCauseOf(signal.reason)).toBe('user')
		// The line that closes the row can say it was the operator who stopped it.
		expect(
			turn.runtime.activity.getSnapshot().find((e) => e.viewId === row.viewId)?.stoppedBy,
		).toBe('user')
	} finally {
		await turn.close()
	}
}, 30_000)

it('refuses a message to an agent the user stopped, in plain words, and writes no row', async () => {
	const turn = await backgroundTurn()
	try {
		await turn.fourthRequestOrStop
		const shown = turn.runtime.activity
			.getSnapshot()
			.find((entry) => entry.taskId === turn.taskId())
		expect(shown).toBeDefined()
		expect(turn.runtime.stopChild(String(shown?.viewId))).toBe(true)
		turn.release()
		await turn.pending
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (
				turn.runtime.activity.getSnapshot().find((entry) => entry.viewId === shown?.viewId)
					?.status === 'cancelled'
			)
				break
			await new Promise<void>((resolve) => setImmediate(resolve))
		}
		const refused = await turn.runtime.sendMessageTool.execute(
			{ task_id: turn.taskId(), message: 'STOPPED_MUST_NOT_RENDER' },
			turn.context,
		)
		expect(refused.success).toBe(false)
		expect(refused.error).toBe(
			'Agent "general-purpose" was stopped by the user and was not resumed. Treat its work as cancelled; only start a new agent for it if the user explicitly asks.',
		)
		await expect(
			turn.runtime.messageChild(
				String(shown?.viewId),
				'typed by the user',
				turn.parent.scope.turnId,
				turn.caller.signal,
			),
		).rejects.toThrow('was stopped, so it cannot take a message')
		const rows = turn.runtime.activity
			.getSnapshot()
			.find((entry) => entry.viewId === shown?.viewId)?.transcript
		expect(rows?.some((row) => row.kind === 'system' && row.text.includes('MUST_NOT'))).toBe(false)
	} finally {
		await turn.close()
	}
}, 30_000)
