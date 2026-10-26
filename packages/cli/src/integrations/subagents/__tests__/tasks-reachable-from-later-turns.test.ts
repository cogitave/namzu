import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	MockLLMProvider,
	type ResumeHandler,
	SessionPaths,
	type ToolContext,
	type TurnId,
	asTaskId,
	defineTool,
	mcpJsonSchemaToZod,
	toolset,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { type SubagentRuntimeOptions, createSubagentRuntime } from '../runtime.js'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDir(directory)
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const MADE_UP = '596ec65e-b063-401c-b1f7-a2b6cc4ce35a'

/**
 * A conversation whose turns share one runtime. The child model answers
 * `RESULT_<n>` for its n-th request; with `holdFirstChild` its first request
 * waits for `hold.resolve()`, which is how a test keeps one running.
 */
async function conversation(
	options: {
		holdFirstChild?: boolean
		/** The child's second request (a resumed run) waits for `hold.resolve()`. */
		holdResume?: boolean
		durable?: boolean
		keepRunningAfterTurn?: boolean
		savedAgents?: SubagentRuntimeOptions['savedAgents']
	} = {},
) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cross-turn-'))
	directories.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const hold = deferred<void>()
	const started = deferred<void>()
	const unwound = deferred<void>()
	const requests: ChatCompletionParams[] = []
	// Set once a request is parked on `hold`, which is what `finish` must wait out.
	let holding = false
	const handlerTurns: TurnId[] = []
	const limitTurns: TurnId[] = []
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		...(options.savedAgents ? { savedAgents: options.savedAgents } : {}),
		// A finished child is resumed only over a durable session log.
		...(options.durable
			? { paths: new SessionPaths({ home: join(cwd, 'state'), slug: 'cross-turn' }) }
			: {}),
		cwd,
		model: 'mock',
		backgroundByDefault: options.keepRunningAfterTurn !== false,
		resolveLimits: (turnId) => {
			limitTurns.push(turnId)
			return undefined
		},
		resolveResumeHandler: (turnId): ResumeHandler => {
			handlerTurns.push(turnId)
			return async (request) =>
				request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' }
		},
		buildTools: () => [
			toolset('test', [
				defineTool({
					name: 'probe',
					description: 'A read-only child observation.',
					category: 'custom',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: true,
					inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
					execute: async () => ({ success: true, output: 'PROBE_RESULT' }),
				}),
			]),
		],
		buildProvider: (): LLMProvider => {
			const held = requests.length === 0 && options.holdFirstChild === true
			const script = held
				? new MockLLMProvider({
						turns: [
							{ toolCalls: [{ id: 'probe-call', name: 'probe', args: {} }] },
							{ text: 'RESULT_HELD' },
						],
					})
				: undefined
			return {
				id: 'child',
				name: 'child',
				async *chatStream(params) {
					requests.push(params)
					if (script) {
						// The first request of a held child ignores cancellation until it is
						// released, so the runtime must fence what it says afterwards.
						if (requests.length === 1) {
							holding = true
							started.resolve()
							try {
								await hold.promise
							} finally {
								unwound.resolve()
							}
						}
						yield* script.chatStream(params)
					} else {
						if (options.holdResume && requests.length === 2) {
							holding = true
							started.resolve()
							try {
								await hold.promise
							} finally {
								unwound.resolve()
							}
						}
						yield* new MockLLMProvider({
							turns: [{ text: `RESULT_${requests.length}` }],
						}).chatStream(params)
					}
				},
			}
		},
	})
	const contextFor = (turnId: TurnId): ToolContext => ({
		sessionId: parent.scope.sessionId,
		turnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	})
	const turn1 = parent.scope.turnId
	const turn2 = parent.addTurn()
	return {
		parent,
		runtime,
		requests,
		handlerTurns,
		limitTurns,
		hold,
		/** Release a held child, close the runtime and wait for the child to unwind. */
		async finish() {
			hold.resolve()
			await runtime.close()
			if (holding) await unwound.promise
		},
		started,
		unwound,
		turn1,
		turn2,
		/** End a turn the way the host does: release its delegation, then forget its scope. */
		async endTurn(turnId: TurnId) {
			await runtime.releaseTurn(turnId)
			parent.end(turnId)
		},
		context1: contextFor(turn1),
		context2: contextFor(turn2),
		contextFor,
	}
}
type World = Awaited<ReturnType<typeof conversation>>

/** Launch one agent in turn 1 and read the task id off the receipt or the gateway. */
async function launch(world: World, background: boolean): Promise<string> {
	const receipt = await world.runtime.agentTool.execute(
		{ description: 'investigate', prompt: 'ORIGINAL_TASK', run_in_background: background },
		world.context1,
	)
	expect(receipt.success).toBe(true)
	const gateway = await world.runtime.gatewayForTurn(world.turn1)
	const task = gateway.listTasks()[0]
	if (!task) throw new Error('no task launched')
	return String(task.taskId)
}

describe('an agent is reachable from every later turn of its conversation', () => {
	it('returns a finished foreground agent without a new wait, says it already ended, and lists it', async () => {
		const world = await conversation()
		try {
			const taskId = await launch(world, false)
			await world.endTurn(world.turn1)
			expect(world.requests).toHaveLength(1)

			const waited = await world.runtime.waitForTaskTool.execute(
				{ task_id: taskId },
				world.context2,
			)
			expect(waited.success).toBe(true)
			expect(waited.output).toBe(`task_id: ${taskId}\nstatus: completed\n\nAgent result:\nRESULT_1`)
			expect(world.requests).toHaveLength(1)

			const cancelled = await world.runtime.cancelAgentTool.execute(
				{ task_id: taskId },
				world.context2,
			)
			expect(cancelled.success).toBe(true)
			expect(cancelled.output).toBe(
				`Task ${taskId} already ended: completed. No cancellation sent.`,
			)

			const listed = await world.runtime.agentTaskListTool.execute({}, world.context2)
			expect(JSON.parse(listed.output).tasks).toEqual([
				expect.objectContaining({ task_id: taskId, state: 'completed' }),
			])
		} finally {
			await world.runtime.close()
		}
	})

	it('resumes a finished agent with a message on the later turn, under that turn’s limits and review', async () => {
		const world = await conversation({ durable: true })
		try {
			const taskId = await launch(world, false)
			await world.endTurn(world.turn1)
			world.handlerTurns.length = 0
			world.limitTurns.length = 0

			const sent = await world.runtime.sendMessageTool.execute(
				{ task_id: taskId, message: 'FOLLOW_UP' },
				world.context2,
			)
			expect(sent.success).toBe(true)
			expect(sent.output).toContain('Resuming agent')
			expect(sent.data).toMatchObject({ status: 'resumed' })

			const shown = world.runtime.activity.getSnapshot()
			expect(shown).toHaveLength(1)
			const resumed = await (await world.runtime.gatewayForTurn(world.turn2)).waitForTask(
				asTaskId(String(shown[0]?.taskId)),
			)
			expect(resumed.result?.lastError).toBeUndefined()
			expect(resumed.state).toBe('completed')
			expect(world.requests).toHaveLength(2)
			const second = JSON.stringify(world.requests[1]?.messages)
			expect(second).toContain('ORIGINAL_TASK')
			expect(second).toContain('FOLLOW_UP')
			// The resumed child answers to the later turn's review channel and limits.
			expect(world.handlerTurns).toEqual([world.turn2])
			expect(world.limitTurns).toContain(world.turn2)
			expect(world.limitTurns).not.toContain(world.turn1)

			// The id the model was first given still names the agent, with its latest run.
			const again = await world.runtime.waitForTaskTool.execute({ task_id: taskId }, world.context2)
			expect(again.success).toBe(true)
			expect(again.output).toContain('RESULT_2')
			expect(world.requests).toHaveLength(2)
		} finally {
			await world.runtime.close()
		}
	})

	it('delivers a message to a background agent still running from an earlier turn', async () => {
		const world = await conversation({ holdFirstChild: true })
		try {
			const taskId = await launch(world, true)
			await world.started.promise
			await world.endTurn(world.turn1)

			const sent = await world.runtime.sendMessageTool.execute(
				{ task_id: taskId, message: 'LATE_CORRECTION' },
				world.context2,
			)
			expect(sent.success).toBe(true)
			expect(sent.data).toMatchObject({ status: 'queued' })
			expect(world.requests).toHaveLength(1)
			// Its review channel stays the one it was launched under.
			expect(world.handlerTurns).toEqual([world.turn1])

			world.hold.resolve()
			const result = await world.runtime.waitForTaskTool.execute(
				{ task_id: taskId },
				world.context2,
			)
			expect(result.success).toBe(true)
			expect(result.output).toContain('RESULT_HELD')
			expect(
				world.requests
					.slice(1)
					.every(
						(request) =>
							request.messages.filter((message) => message.content === 'LATE_CORRECTION').length ===
							1,
					),
			).toBe(true)
			expect(
				world.requests.some((request) =>
					request.messages.some((message) => message.content === 'LATE_CORRECTION'),
				),
			).toBe(true)
		} finally {
			await world.finish()
		}
	})

	it('cancels a running background agent from a later turn', async () => {
		const world = await conversation({ holdFirstChild: true })
		try {
			const taskId = await launch(world, true)
			await world.started.promise
			await world.endTurn(world.turn1)

			const cancelled = await world.runtime.cancelAgentTool.execute(
				{ task_id: taskId },
				world.context2,
			)
			expect(cancelled.success).toBe(true)
			expect(cancelled.data).toMatchObject({ status: 'cancellation_requested' })
			world.hold.resolve()
			const ended = await world.runtime.waitForTaskTool.execute({ task_id: taskId }, world.context2)
			expect(ended.success).toBe(false)
			expect(ended.output).toContain('status: canceled')
			// Nothing ran after the cancellation.
			expect(world.requests).toHaveLength(1)
		} finally {
			await world.finish()
		}
	})

	it('keeps one id for an agent across resumes in what the model reads', async () => {
		const world = await conversation({ holdResume: true, durable: true })
		try {
			const taskId = await launch(world, false)
			await world.endTurn(world.turn1)
			const heard: { taskId: string; text: string }[] = []
			const ended = deferred<void>()
			world.runtime.onBackgroundCompletion((completion) => {
				heard.push(completion)
				ended.resolve()
			})
			const sent = await world.runtime.sendMessageTool.execute(
				{ task_id: taskId, message: 'FOLLOW_UP' },
				world.context2,
			)
			expect(sent.data).toMatchObject({ task_id: taskId, status: 'resumed' })
			// The turn ends while the resumed run is still working; its end is announced later.
			await world.runtime.releaseTurn(world.turn2)
			world.hold.resolve()
			await ended.promise
			expect(heard).toHaveLength(1)
			expect(heard[0]?.taskId).toBe(taskId)
			expect(heard[0]?.text).toContain(taskId)
			expect(heard[0]?.text).toContain('RESULT_2')

			const turn3 = world.parent.addTurn()
			const listed = await world.runtime.agentTaskListTool.execute({}, world.contextFor(turn3))
			expect(JSON.parse(listed.output).tasks).toEqual([
				expect.objectContaining({ task_id: taskId, state: 'completed' }),
			])
			const waited = await world.runtime.waitForTaskTool.execute(
				{ task_id: taskId },
				world.contextFor(turn3),
			)
			expect(waited.output).toBe(`task_id: ${taskId}\nstatus: completed\n\nAgent result:\nRESULT_2`)
			expect(waited.data).toMatchObject({ task_id: taskId })
		} finally {
			await world.finish()
		}
	})

	it('says in plain words that an agent is already being resumed when two messages meet', async () => {
		const world = await conversation({ holdResume: true, durable: true })
		try {
			const taskId = await launch(world, false)
			await world.endTurn(world.turn1)
			const viewId = world.runtime.activity.getSnapshot()[0]?.viewId
			if (!viewId) throw new Error('the agent is not shown')
			const signal = new AbortController().signal
			const first = world.runtime.messageChild(viewId, 'ONE', world.turn2, signal)
			const second = world.runtime.messageChild(viewId, 'TWO', world.turn2, signal)
			await expect(second).rejects.toThrow(/already being resumed/i)
			await expect(second).rejects.not.toThrow(/admitted/)
			expect((await first).kind).toBe('started')

			// Two messages from the model meet the same way: neither gets wire wording.
			const answers = await Promise.all([
				world.runtime.sendMessageTool.execute({ task_id: taskId, message: 'A' }, world.context2),
				world.runtime.sendMessageTool.execute({ task_id: taskId, message: 'B' }, world.context2),
			])
			for (const answer of answers) {
				expect(`${answer.output}${answer.error ?? ''}`).not.toMatch(/admitted/)
			}
		} finally {
			await world.finish()
		}
	})

	it('answers about the new run, not the old one, while a resume is being admitted', async () => {
		const world = await conversation({ holdResume: true, durable: true })
		try {
			const taskId = await launch(world, false)
			await world.endTurn(world.turn1)
			const gateway = await world.runtime.gatewayForTurn(world.turn2)
			const admit = deferred<void>()
			const entered = deferred<void>()
			const original = gateway.createTask.bind(gateway)
			vi.spyOn(gateway, 'createTask').mockImplementation(async (options) => {
				entered.resolve()
				await admit.promise
				return original(options)
			})

			const sending = world.runtime.sendMessageTool.execute(
				{ task_id: taskId, message: 'AGAIN' },
				world.context2,
			)
			await entered.promise
			const waiting = world.runtime.waitForTaskTool.execute({ task_id: taskId }, world.context2)
			const cancelling = world.runtime.cancelAgentTool.execute({ task_id: taskId }, world.context2)
			admit.resolve()

			expect((await sending).data).toMatchObject({ status: 'resumed' })
			const cancelled = await cancelling
			expect(cancelled.output).not.toContain('already ended')
			expect(cancelled.data).toMatchObject({ status: 'cancellation_requested' })
			world.hold.resolve()
			const ended = await waiting
			expect(ended.output).toContain('status: canceled')
			expect(ended.output).not.toContain('RESULT_1')
		} finally {
			await world.finish()
		}
	})

	it('says an agent nothing holds any more is stopping instead of calling it unknown', async () => {
		const world = await conversation({ holdFirstChild: true })
		try {
			const taskId = await launch(world, true)
			await world.started.promise
			const retired = await world.runtime.gatewayForTurn(world.turn1)
			await world.endTurn(world.turn1)
			vi.spyOn(retired, 'getTask').mockReturnValue(undefined)

			const cancelled = await world.runtime.cancelAgentTool.execute(
				{ task_id: taskId },
				world.context2,
			)
			expect(cancelled.success).toBe(true)
			expect(cancelled.output).toBe(
				`Task ${taskId} is already stopping. No further cancellation sent.`,
			)
			for (const tool of [world.runtime.waitForTaskTool, world.runtime.sendMessageTool]) {
				const result = await tool.execute({ task_id: taskId, message: 'X' }, world.context2)
				expect(result.success).toBe(false)
				expect(result.error).toContain('is stopping')
				expect(result.error).not.toContain('No task with ID')
			}
		} finally {
			await world.finish()
		}
	})

	it('does not resume an agent the user stopped', async () => {
		const world = await conversation({ holdFirstChild: true })
		try {
			const taskId = await launch(world, true)
			await world.started.promise
			const view = world.runtime.activity.getSnapshot()[0]
			expect(world.runtime.stopChild(String(view?.viewId))).toBe(true)
			world.hold.resolve()
			await world.endTurn(world.turn1)
			await world.runtime.waitForTaskTool.execute({ task_id: taskId }, world.context2)

			const sent = await world.runtime.sendMessageTool.execute(
				{ task_id: taskId, message: 'RESUME_ME' },
				world.context2,
			)
			expect(sent.success).toBe(false)
			expect(sent.error).toContain('was stopped by the user and was not resumed')
			expect(
				world.requests.filter((r) => JSON.stringify(r.messages).includes('RESUME_ME')),
			).toEqual([])
		} finally {
			await world.finish()
		}
	})

	it('answers an id of another conversation, or nobody’s, as unknown, and writes nothing', async () => {
		const world = await conversation({ holdFirstChild: true })
		try {
			const taskId = await launch(world, true)
			await world.started.promise
			const stranger = await world.parent.addForeignTurn()
			const strangerContext = world.contextFor(stranger)

			for (const tool of [
				world.runtime.waitForTaskTool,
				world.runtime.cancelAgentTool,
				world.runtime.sendMessageTool,
			]) {
				const foreign = await tool.execute({ task_id: taskId, message: 'FOREIGN' }, strangerContext)
				expect(foreign.success).toBe(false)
				expect(foreign.error).toContain(`No task with ID ${taskId} in this conversation.`)
				expect(foreign.error).not.toContain('does not belong')

				const madeUp = await tool.execute({ task_id: MADE_UP, message: 'MADE_UP' }, world.context2)
				expect(madeUp.success).toBe(false)
				expect(madeUp.error).toContain(`No task with ID ${MADE_UP} in this conversation.`)
				expect(madeUp.error).toContain(`Running agents: ${taskId}.`)
				// Nothing saved is called by that id, so no history hint is made.
				expect(madeUp.error).not.toContain('history')

				const garbled = await tool.execute({ task_id: 'task 1', message: 'X' }, world.context2)
				expect(garbled.success).toBe(false)
				expect(garbled.error).toContain('No task with ID task 1 in this conversation.')
				expect(garbled.error).toContain(`Running agents: ${taskId}.`)
			}
			expect(JSON.stringify(world.runtime.activity.getSnapshot())).not.toMatch(/FOREIGN|MADE_UP/)
			// The stranger's conversation sees none of it.
			const listed = await world.runtime.agentTaskListTool.execute({}, strangerContext)
			expect(JSON.parse(listed.output).tasks).toEqual([])
		} finally {
			await world.finish()
		}
	})

	it('does not reach a running agent of another session through its retired turn', async () => {
		const world = await conversation({ holdFirstChild: true })
		try {
			const taskId = await launch(world, true)
			await world.started.promise
			await world.endTurn(world.turn1)
			const stranger = await world.parent.addForeignTurn()
			const strangerContext = world.contextFor(stranger)

			for (const tool of [
				world.runtime.waitForTaskTool,
				world.runtime.cancelAgentTool,
				world.runtime.sendMessageTool,
			]) {
				const foreign = await tool.execute({ task_id: taskId, message: 'FOREIGN' }, strangerContext)
				expect(foreign.success).toBe(false)
				expect(foreign.error).toContain(`No task with ID ${taskId} in this conversation.`)
				expect(foreign.error).not.toContain(`Running agents: ${taskId}`)
			}
			const listed = await world.runtime.agentTaskListTool.execute({}, strangerContext)
			expect(JSON.parse(listed.output).tasks).toEqual([])
			// The agent was neither cancelled nor messaged: its own conversation still reaches it.
			const sent = await world.runtime.sendMessageTool.execute(
				{ task_id: taskId, message: 'OWN' },
				world.context2,
			)
			expect(sent.success).toBe(true)
			expect(JSON.stringify(world.requests)).not.toContain('FOREIGN')
		} finally {
			await world.finish()
		}
	})

	it('points at the saved history only for an id that names a saved agent', async () => {
		const savedId = 'f4b5c1a2-3d4e-4f60-8a71-92b3c4d5e6f7'
		const world = await conversation({
			savedAgents: () => ({
				list: async () => ({ agents: [], omitted: 0 }),
				read: async (id) => {
					if (id !== savedId) throw new Error('not saved')
					return {} as never
				},
			}),
		})
		try {
			const saved = await world.runtime.cancelAgentTool.execute(
				{ task_id: savedId },
				world.context2,
			)
			expect(saved.error).toContain('agent_task_list')
			expect(saved.error).toContain('history: true')
			const other = await world.runtime.cancelAgentTool.execute(
				{ task_id: MADE_UP },
				world.context2,
			)
			expect(other.error).toBe(`No task with ID ${MADE_UP} in this conversation.`)
		} finally {
			await world.runtime.close()
		}
	})

	it('stops the running agents of a closed conversation and reaches nothing afterwards', async () => {
		const world = await conversation({ holdFirstChild: true })
		const taskId = await launch(world, true)
		await world.started.promise
		await world.endTurn(world.turn1)
		world.hold.resolve()
		await world.finish()
		expect(world.requests).toHaveLength(1)
		for (const tool of [
			world.runtime.waitForTaskTool,
			world.runtime.cancelAgentTool,
			world.runtime.sendMessageTool,
		]) {
			const after = await tool.execute({ task_id: taskId, message: 'AFTER_CLOSE' }, world.context2)
			expect(after.success).toBe(false)
		}
		expect(
			world.requests.filter((r) => JSON.stringify(r.messages).includes('AFTER_CLOSE')),
		).toEqual([])
	})
})
