import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	type Message,
	MockLLMProvider,
	RunCancelled,
	type StreamChunk,
	ToolRegistry,
	createUserMessage,
	drainQuery,
	generateRunId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

/** Level-triggered input, including a deterministic witness of an idle hold. */
class InputInbox {
	private readonly messages: Message[] = []
	private readonly waiters = new Set<() => void>()
	private readonly watches: Array<{ count: number; resolve: () => void }> = []

	enqueue(text: string): void {
		this.messages.push(createUserMessage(text))
		for (const wake of [...this.waiters]) wake()
	}

	drain = (): Message[] => this.messages.splice(0)

	wait = (signal: AbortSignal): Promise<void> => {
		signal.throwIfAborted()
		if (this.messages.length > 0) return Promise.resolve()
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.waiters.delete(wake)
				signal.removeEventListener('abort', abort)
			}
			const wake = () => {
				cleanup()
				resolve()
			}
			const abort = () => {
				cleanup()
				reject(signal.reason)
			}
			signal.addEventListener('abort', abort, { once: true })
			this.waiters.add(wake)
			for (const watch of this.watches.splice(0)) {
				if (this.waiters.size >= watch.count) watch.resolve()
				else this.watches.push(watch)
			}
		})
	}

	waiting(count: number): Promise<void> {
		if (this.waiters.size >= count) return Promise.resolve()
		return new Promise((resolve) => this.watches.push({ count, resolve }))
	}

	get pendingWaiters(): number {
		return this.waiters.size
	}
}

describe('operator input releases delegation waits without cancelling children', () => {
	const workdirs: string[] = []
	afterEach(() => {
		for (const workdir of workdirs.splice(0)) removeTempDir(workdir)
	})

	it.each([false, true])(
		'keeps one parent run responsive through a repeated steer (cancel=%s)',
		async (cancel) => {
			const cwd = mkdtempSync(join(tmpdir(), 'namzu-delegation-input-'))
			workdirs.push(cwd)
			const parent = await subagentParentFixture(cwd)
			const inbox = new InputInbox()
			const releases = Array.from({ length: 3 }, () => deferred<void>())
			const started = Array.from({ length: 3 }, () => deferred<AbortSignal>())
			const finished = Array.from({ length: 3 }, () => deferred<void>())
			let childIndex = 0
			const runtime = await createSubagentRuntime({
				resolveParent: parent.resolveParent,
				resolveWaitForInbound: (runId) => (runId === parent.scope.runId ? inbox.wait : undefined),
				cwd,
				model: 'mock-model',
				tokenBudget: 1_000_000,
				buildTools: () => new ToolRegistry(),
				buildProvider: () => {
					const index = childIndex++
					const script = new MockLLMProvider({ turns: [{ text: `child-result-${index}` }] })
					return {
						id: `held-child-${index}`,
						name: 'Held Child',
						async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
							started[index]?.resolve(params.signal as AbortSignal)
							try {
								await releases[index]?.promise
								yield* script.chatStream(params)
							} finally {
								finished[index]?.resolve()
							}
						},
					} satisfies LLMProvider
				},
			})
			const gateway = await runtime.gatewayForRun(parent.scope.runId)
			const completionInbox = await runtime.completionInboxForRun(parent.scope.runId)
			const parentScript = new MockLLMProvider({
				turns: [
					{
						toolCalls: Array.from({ length: 3 }, (_, index) => ({
							id: `call_child_${index}`,
							name: 'Agent',
							args: {
								description: `child ${index}`,
								prompt: `complete task ${index}`,
								role: `Specialist ${index}`,
							},
						})),
					},
					{ text: 'Yes, all three tasks are running.' },
					{ text: 'I received the second message too.' },
					{ text: 'The delegated results have arrived.' },
					{ text: 'The remaining delegated results have arrived.' },
					{ text: 'Every delegated task is complete.' },
				],
			})
			const requests = Array.from({ length: 6 }, () => deferred<ChatCompletionParams>())
			let requestIndex = 0
			const provider: LLMProvider = {
				id: 'parent',
				name: 'Parent',
				chatStream(params) {
					requests[requestIndex++]?.resolve(params)
					return parentScript.chatStream(params)
				},
			}
			const tools = new ToolRegistry()
			tools.register(runtime.agentTool)
			const caller = new AbortController()
			const pending = drainQuery({
				provider,
				tools,
				taskScheduler: gateway,
				completionInbox,
				inboundMessages: inbox.drain,
				waitForInbound: inbox.wait,
				runConfig: {
					model: 'mock-model',
					timeoutMs: 30_000,
					tokenBudget: 1_000_000,
					maxIterations: 10,
					permissionMode: 'auto',
				},
				agentId: 'namzu',
				agentName: 'namzu',
				messages: [createUserMessage('delegate three tasks')],
				workingDirectory: cwd,
				...parent.scope,
				signal: caller.signal,
			}).finally(() => runtime.releaseRun(parent.scope.runId))
			try {
				const signals = await Promise.all(started.map((entry) => entry.promise))
				await inbox.waiting(3)
				inbox.enqueue('Are the agents working?')
				const firstResponse = await requests[1]!.promise
				expect(firstResponse.messages.at(-1)?.content).toBe('Are the agents working?')
				const receipts = firstResponse.messages.filter((message) => message.role === 'tool')
				expect(receipts).toHaveLength(3)
				expect(new Set(receipts.map((message) => message.toolCallId)).size).toBe(3)
				for (const [index, receipt] of receipts.entries()) {
					expect(String(receipt.content)).toContain('still running')
					expect(String(receipt.content)).toContain(`child ${index}`)
				}
				expect(signals.every((signal) => !signal.aborted)).toBe(true)
				expect(gateway.listTasks().every((task) => task.state === 'running')).toBe(true)
				const listing = await runtime.agentTaskListTool.execute(
					{},
					{
						runId: parent.scope.runId,
						workingDirectory: cwd,
						abortSignal: caller.signal,
						env: {},
						log() {},
					},
				)
				const listed = JSON.parse(listing.output)
				expect(listed.total).toBe(3)
				expect(listed.tasks.map((task: { task_id: string }) => task.task_id).sort()).toEqual(
					gateway
						.listTasks()
						.map((task) => task.taskId)
						.sort(),
				)
				expect(listed.tasks.every((task: { status: string }) => task.status === 'running')).toBe(
					true,
				)

				// The parent has answered but remains in its idle completion hold.
				await inbox.waiting(1)
				inbox.enqueue('Please keep those same tasks running.')
				const secondResponse = await requests[2]!.promise
				expect(secondResponse.messages.at(-1)?.content).toBe(
					'Please keep those same tasks running.',
				)
				expect(childIndex).toBe(3)
				expect(signals.every((signal) => !signal.aborted)).toBe(true)
				await inbox.waiting(1)
				if (cancel) caller.abort(new RunCancelled('user'))
				else for (const release of releases) release.resolve()
				const run = await pending
				expect(run.status).toBe(cancel ? 'cancelled' : 'completed')
				expect(inbox.pendingWaiters).toBe(0)
				if (cancel) {
					expect(signals.every((signal) => signal.aborted)).toBe(true)
				} else {
					for (let index = 0; index < 3; index++) {
						const containing = run.messages.filter((message) =>
							String(message.content).includes(`child-result-${index}`),
						)
						expect(containing).toHaveLength(1)
					}
					expect(run.messages.filter((message) => message.role === 'tool')).toHaveLength(3)
				}
			} finally {
				caller.abort(new RunCancelled('user'))
				for (const release of releases) release.resolve()
				await pending.catch(() => {})
				await runtime.close()
				await Promise.all(finished.slice(0, childIndex).map((entry) => entry.promise))
			}
		},
	)

	it.each([false, true])(
		'keeps ten tasks and a metered parent responsive with eight slots (cancel=%s)',
		async (cancel) => {
			const cwd = mkdtempSync(join(tmpdir(), 'namzu-ten-delegates-'))
			workdirs.push(cwd)
			const parent = await subagentParentFixture(cwd)
			const inbox = new InputInbox()
			const releases = Array.from({ length: 10 }, () => deferred<void>())
			const started = Array.from({ length: 10 }, () => deferred<AbortSignal>())
			const finished = Array.from({ length: 10 }, () => deferred<void>())
			let childCount = 0
			let active = 0
			let peak = 0
			let scopeReads = 0
			const parentResponseRelease = deferred<void>()
			const runtime = await createSubagentRuntime({
				resolveParent: async (runId) => {
					scopeReads++
					return parent.resolveParent(runId)
				},
				resolveWaitForInbound: () => inbox.wait,
				cwd,
				model: 'mock-model',
				tokenBudget: 1_000_000,
				buildTools: () => new ToolRegistry(),
				buildProvider: () => {
					const index = childCount++
					return {
						id: `held-child-${index}`,
						name: 'Metered held child',
						async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
							active++
							peak = Math.max(peak, active)
							try {
								// Charge realistic prompt usage while requests remain in flight.
								// A zero-usage fake hid starvation of the parent's next response.
								yield {
									id: `held-${index}`,
									delta: {},
									usage: {
										promptTokens: 22_000,
										completionTokens: 0,
										totalTokens: 22_000,
										cachedTokens: 0,
										cacheWriteTokens: 0,
									},
								}
								started[index]!.resolve(params.signal as AbortSignal)
								await releases[index]!.promise
								yield* new MockLLMProvider({
									turns: [
										{
											text: `child-result-${index}`,
											usage: { promptTokens: 22_000, completionTokens: 500, totalTokens: 22_500 },
										},
									],
								}).chatStream(params)
							} finally {
								active--
								finished[index]!.resolve()
							}
						},
					} satisfies LLMProvider
				},
			})
			const gateway = await runtime.gatewayForRun(parent.scope.runId)
			const completionInbox = await runtime.completionInboxForRun(parent.scope.runId)
			const requests = Array.from({ length: 20 }, () => deferred<ChatCompletionParams>())
			const script = new MockLLMProvider({
				nextTurn: (_params, index) =>
					index === 0
						? {
								toolCalls: Array.from({ length: 10 }, (_, i) => ({
									id: `call_child_${i}`,
									name: 'Agent',
									args: {
										description: `child ${i}`,
										prompt: `complete task ${i}`,
										subagent_type: 'explore',
									},
								})),
								usage: { promptTokens: 29_000, completionTokens: 1_000, totalTokens: 30_000 },
							}
						: {
								text: 'I received your message; the tasks remain tracked.',
								usage: { promptTokens: 20_000, completionTokens: 500, totalTokens: 20_500 },
							},
			})
			let parentRequests = 0
			const provider: LLMProvider = {
				id: 'held-parent',
				name: 'Parent with a held response',
				async *chatStream(params) {
					const index = parentRequests++
					requests[index]!.resolve(params)
					if (index === 2) await parentResponseRelease.promise
					yield* script.chatStream(params)
				},
			}
			const tools = new ToolRegistry()
			tools.register(runtime.agentTool)
			const caller = new AbortController()
			const pending = drainQuery({
				provider,
				tools,
				taskScheduler: gateway,
				completionInbox,
				inboundMessages: inbox.drain,
				waitForInbound: inbox.wait,
				runConfig: {
					model: 'mock-model',
					timeoutMs: 30_000,
					tokenBudget: 1_000_000,
					maxIterations: 20,
					permissionMode: 'auto',
				},
				agentId: 'namzu',
				agentName: 'namzu',
				messages: [createUserMessage('delegate ten tasks')],
				workingDirectory: cwd,
				...parent.scope,
				signal: caller.signal,
			}).finally(() => runtime.releaseRun(parent.scope.runId))
			try {
				const signals = await Promise.all(started.slice(0, 8).map((entry) => entry.promise))
				// The generic tool batch also has eight workers. The remaining two
				// Agent calls enter the scheduler when steering releases those waits.
				await inbox.waiting(8)
				expect(childCount).toBe(8)
				expect(gateway.budget!.remaining).toBeGreaterThan(40_000)
				inbox.enqueue('Can we talk while all ten tasks are tracked?')
				const response = await requests[1]!.promise
				expect(response.messages.at(-1)?.content).toBe(
					'Can we talk while all ten tasks are tracked?',
				)
				const receipts = response.messages.filter((message) => message.role === 'tool')
				expect(receipts).toHaveLength(10)
				expect(gateway.listTasks()).toHaveLength(10)
				expect(gateway.listTasks().filter((task) => task.state === 'pending')).toHaveLength(2)
				expect(new Set(receipts.map((message) => message.toolCallId)).size).toBe(10)
				expect(
					receipts.filter((message) => String(message.content).includes('queued')),
				).toHaveLength(2)
				expect(
					receipts.filter((message) => String(message.content).includes('still running')),
				).toHaveLength(8)
				expect(receipts.every((message) => !String(message.content).includes('Error:'))).toBe(true)
				await inbox.waiting(1)
				inbox.enqueue('Keep those same ten tasks; do not restart any.')
				expect((await requests[2]!.promise).messages.at(-1)?.content).toBe(
					'Keep those same ten tasks; do not restart any.',
				)
				// A child releases its slot while the parent still owns an open
				// provider request. Admission must wait for that receipt, not fail
				// the ninth task or reserve the parent's unmeasured allowance.
				expect(gateway.budget!.hasInFlightRequest).toBe(true)
				releases[0]!.resolve()
				await vi.waitFor(() =>
					expect(gateway.listTasks().filter((task) => task.state === 'completed')).toHaveLength(1),
				)
				const readsAfterCompletion = scopeReads
				await vi.waitFor(() => expect(scopeReads).toBeGreaterThan(readsAfterCompletion + 1))
				expect(childCount).toBe(8)
				expect(gateway.listTasks().filter((task) => task.state === 'pending')).toHaveLength(2)
				expect(gateway.listTasks().filter((task) => task.state === 'failed')).toHaveLength(0)
				expect(signals.every((signal) => !signal.aborted)).toBe(true)
				if (cancel) caller.abort(new RunCancelled('user'))
				else {
					parentResponseRelease.resolve()
					await started[8]!.promise
					expect(childCount).toBe(9)
					releases[1]!.resolve()
					await started[9]!.promise
					expect(childCount).toBe(10)
					for (const release of releases) release.resolve()
				}
				const run = await pending
				expect(run.status).toBe(cancel ? 'cancelled' : 'completed')
				expect(run.stopReason).not.toBe('token_budget')
				expect(peak).toBeLessThanOrEqual(8)
				expect(inbox.pendingWaiters).toBe(0)
				if (cancel) {
					expect(childCount).toBe(8)
					expect(signals.slice(1).every((signal) => signal.aborted)).toBe(true)
				} else {
					for (let i = 0; i < 10; i++)
						expect(
							run.messages.filter((message) =>
								String(message.content).includes(`child-result-${i}`),
							),
						).toHaveLength(1)
				}
			} finally {
				parentResponseRelease.resolve()
				caller.abort(new RunCancelled('user'))
				for (const release of releases) release.resolve()
				await pending.catch(() => {})
				await runtime.close()
				await Promise.all(finished.slice(0, childCount).map((entry) => entry.promise))
			}
		},
		30_000,
	)

	it('retrieves complete yielded output, releases a repeated wait, and refuses an unrelated task', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-delegation-retrieve-'))
		workdirs.push(cwd)
		const parent = await subagentParentFixture(cwd)
		const inbox = new InputInbox()
		const release = deferred<void>()
		const started = deferred<void>()
		const completeOutput = `Task 1: 596ec65e-b063-401c-b1f7-a2b6cc4ce35a\nbegin:${'x'.repeat(5_000)}:complete-tail`
		const otherRunId = generateRunId()
		let requests = 0
		const runtime = await createSubagentRuntime({
			resolveParent: (runId) =>
				parent.resolveParent(runId === otherRunId ? parent.scope.runId : runId),
			resolveWaitForInbound: () => inbox.wait,
			cwd,
			model: 'mock-model',
			buildTools: () => new ToolRegistry(),
			buildProvider: () => ({
				id: 'held-result',
				name: 'Held Result',
				async *chatStream(params) {
					requests++
					started.resolve()
					await release.promise
					yield* new MockLLMProvider({
						turns: [{ text: completeOutput, chunkSize: 8_000 }],
					}).chatStream(params)
				},
			}),
		})
		const context = {
			runId: parent.scope.runId,
			workingDirectory: cwd,
			abortSignal: new AbortController().signal,
			env: {},
			log() {},
		}
		const launch = runtime.agentTool.execute(
			{ description: 'long result', prompt: 'produce long result' },
			context,
		)
		try {
			await started.promise
			inbox.enqueue('status?')
			const yielded = await launch
			const taskId = (yielded.data as { task_id: string }).task_id
			expect(yielded.output).toContain('still running')
			inbox.drain()
			const waiting = runtime.waitForTaskTool.execute({ task_id: taskId }, context)
			await inbox.waiting(1)
			inbox.enqueue('one more question')
			expect((await waiting).output).toContain('still running')
			inbox.drain()
			release.resolve()
			const result = await runtime.waitForTaskTool.execute({ task_id: taskId }, context)
			expect(result.success).toBe(true)
			expect(result.output).toBe(
				`task_id: ${taskId}\nstatus: completed\n\nAgent result:\n${completeOutput}`,
			)
			expect(requests).toBe(1)
			expect((await runtime.completionInboxForRun(parent.scope.runId)).drain()).toEqual([])
			const refused = await runtime.waitForTaskTool.execute(
				{ task_id: '596ec65e-b063-401c-b1f7-a2b6cc4ce35a' },
				context,
			)
			expect(refused.success).toBe(false)
			expect(refused.error).toContain('does not belong to this parent run')
			const foreign = await runtime.waitForTaskTool.execute(
				{ task_id: taskId },
				{ ...context, runId: otherRunId },
			)
			expect(foreign.success).toBe(false)
			expect(foreign.error).toContain('does not belong to this parent run')
			const invalid = await runtime.waitForTaskTool.execute({ task_id: '../../other-run' }, context)
			expect(invalid.success).toBe(false)
			expect(invalid.error).toContain('task UUID')
		} finally {
			release.resolve()
			await launch.catch(() => {})
			await runtime.close()
		}
	})

	it('labels a child token-budget stop and preserves its partial output', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-delegation-partial-'))
		workdirs.push(cwd)
		const parent = await subagentParentFixture(cwd)
		const runtime = await createSubagentRuntime({
			resolveParent: parent.resolveParent,
			cwd,
			model: 'mock-model',
			tokenBudget: 1_000,
			resolveResumeHandler: () => async () => ({ action: 'approve_tools' }),
			buildTools: () => new ToolRegistry(),
			buildProvider: () =>
				new MockLLMProvider({
					turns: [
						{
							text: 'Partial finding from the child.',
							toolCalls: [{ id: 'call_more_work', name: 'unavailable-tool', args: {} }],
							usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600 },
						},
					],
				}),
		})
		try {
			const result = await runtime.agentTool.execute(
				{ description: 'partial task', prompt: 'keep working' },
				{
					runId: parent.scope.runId,
					workingDirectory: cwd,
					abortSignal: new AbortController().signal,
					env: {},
					log() {},
				},
			)
			expect(result.data).toMatchObject({ stop_reason: 'token_budget', status: 'incomplete' })
			expect(result.success).toBe(false)
			expect(result.output).toContain('status: incomplete')
			expect(result.output).not.toContain('status: completed')
			expect(result.output).toContain('token_budget')
			expect(result.output).toContain('does not establish task completion')
			expect(result.output).toContain('Partial finding from the child.')
			expect(runtime.activity.getSnapshot().at(-1)?.status).toBe('failed')
			const listing = await runtime.agentTaskListTool.execute(
				{},
				{
					runId: parent.scope.runId,
					workingDirectory: cwd,
					abortSignal: new AbortController().signal,
					env: {},
					log() {},
				},
			)
			expect(JSON.parse(listing.output).tasks[0]).toMatchObject({
				status: 'incomplete',
				stop_reason: 'token_budget',
			})
		} finally {
			await runtime.close()
		}
	})
})
