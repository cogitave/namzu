import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SandboxId, SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { Sandbox, SandboxProvider } from '../../../types/sandbox/index.js'
import { TurnCancelled } from '../../../types/session/cancel-cause.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { StepResult } from '../../../types/session/step.js'
import { drainQuery } from '../index.js'

type Acquire = 'eager' | 'concurrent' | 'on-first-use'

const workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function boundary(destroy: () => Promise<void> = async () => {}): Sandbox {
	return {
		id: '3fbee056-35a0-44a6-8faf-ef1adfb2161a' as SandboxId,
		status: 'ready',
		rootDir: '/workspace',
		environment: 'basic',
		exec: async () => ({
			stdout: '',
			stderr: '',
			exitCode: 0,
			durationMs: 0,
			timedOut: false,
		}),
		writeFile: async () => {},
		readFile: async () => Buffer.alloc(0),
		listFiles: async () => [],
		destroy,
	}
}

/** One tool call, then an answer; the tool records whether it was handed a sandbox. */
function toolTurn() {
	const ran: { sandbox: boolean }[] = []
	const tool = defineTool({
		name: 'inspect_sandbox',
		description: 'Reports whether the tool context carries a sandbox.',
		inputSchema: z.object({}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async (_input, context) => {
			ran.push({ sandbox: context.sandbox !== undefined })
			return { success: true, output: 'ok' }
		},
	})
	return {
		ran,
		tools: [testToolset(tool)],
		turns: [{ toolCalls: [{ id: 'call_1', name: 'inspect_sandbox', args: {} }] }, { text: 'done' }],
	}
}

async function run(input: {
	readonly acquire: Acquire
	readonly provider: MockLLMProvider
	readonly create: SandboxProvider['create']
	readonly tools?: ReturnType<typeof toolTurn>['tools']
	readonly signal?: AbortSignal
	readonly timeoutMs?: number
	readonly onEvent?: (event: SessionEvent) => void
	/** Replaces the single opening user message, e.g. with a prior turn's history. */
	readonly messages?: readonly Message[]
	readonly sessionLog?: InMemorySessionLog
	/** Pass `acquire` as `turnConfig.sandbox.acquire` without any sandbox provider. */
	readonly withoutProvider?: boolean
	readonly onStepFinish?: (step: StepResult) => void
}) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-sandbox-acquire-'))
	workdirs.push(workingDirectory)
	const events: SessionEvent[] = []
	const result = drainQuery(
		{
			provider: input.provider,
			toolsets: input.tools ?? [],
			...(input.withoutProvider
				? {}
				: {
						sandboxProvider: {
							id: 'acquire-modes',
							name: 'Acquire modes',
							environment: 'basic',
							create: input.create,
						},
					}),
			...(input.sessionLog ? { sessionLog: input.sessionLog } : {}),
			...(input.onStepFinish ? { onStepFinish: input.onStepFinish } : {}),
			...(input.signal ? { signal: input.signal } : {}),
			turnConfig: {
				model: 'mock-model',
				timeoutMs: input.timeoutMs ?? 20_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				sandbox: { acquire: input.acquire },
			},
			retry: false as const,
			agentId: 'agent_sandbox_acquire',
			agentName: 'Sandbox acquire',
			messages: input.messages ?? [createUserMessage('go')],
			workingDirectory,
			sessionId: '82374a6e-20d2-4f11-b06f-5792141c0497' as SessionId,
			topicId: 'a789bffc-abbd-4e79-b3ec-6011b08067bc' as TopicId,
			projectId: '1556cc8f-9c7e-4d40-9705-22471d1d7237' as ProjectId,
			tenantId: 'b857f97a-dde7-4ddb-a571-e13f3a2c45a3' as TenantId,
		} as never,
		(event) => {
			events.push(event)
			input.onEvent?.(event)
		},
	)
	return { result, events }
}

/** Lets everything already queued run, without waiting on the clock. */
async function settleQueues(): Promise<void> {
	for (let round = 0; round < 5; round++) {
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
}

const types = (events: readonly SessionEvent[]) => events.map((event) => event.type)

describe("sandbox.acquire: 'eager' (the default)", () => {
	const EXPECTED = [
		'turn_started',
		'sandbox_created',
		'activity_created',
		'activity_updated',
		'iteration_started',
		'request_envelope',
		'message_started',
		'tool_input_started',
		'tool_input_delta',
		'tool_input_delta',
		'tool_input_completed',
		'message_completed',
		'token_usage_updated',
		'activity_updated',
		'tool_review_requested',
		'tool_review_completed',
		'activity_created',
		'activity_updated',
		'tool_executing',
		'activity_updated',
		'tool_completed',
		'checkpoint_created',
		'iteration_completed',
		'activity_created',
		'activity_updated',
		'iteration_started',
		'message_started',
		'text_delta',
		'message_completed',
		'token_usage_updated',
		'activity_updated',
		'iteration_completed',
		'turn_completed',
		'sandbox_destroyed',
	]

	// Recorded from the kernel before this option existed (`git stash` of the
	// change reproduces it); an unset option and an explicit 'eager' must both
	// keep it.
	it.each([undefined, 'eager' as const])(
		"keeps today's event order and acquires before the first model request, acquire=%s",
		async (acquire) => {
			const trace: string[] = []
			const script = toolTurn()
			const model = new MockLLMProvider({
				turns: script.turns,
				onRequest: () => trace.push('request'),
			})
			const { result, events } = await run({
				acquire: acquire as Acquire,
				provider: model,
				tools: script.tools,
				create: async () => {
					trace.push('created')
					return boundary()
				},
			})
			const finished = await result
			expect(finished.stopReason).toBe('end_turn')
			expect(types(events)).toEqual(EXPECTED)
			expect(trace.slice(0, 2)).toEqual(['created', 'request'])
			expect(script.ran).toEqual([{ sandbox: true }])
		},
	)
})

describe("sandbox.acquire: 'concurrent'", () => {
	it('sends the first model request before the acquisition resolves, and emits sandbox_created on resolution', async () => {
		const allocation = deferred<Sandbox>()
		const trace: string[] = []
		const model = new MockLLMProvider({
			turns: [{ text: 'no tools needed' }],
			onRequest: () => trace.push('request'),
		})
		const { result, events } = await run({
			acquire: 'concurrent',
			provider: model,
			create: async () => {
				trace.push('create-called')
				const handle = await allocation.promise
				trace.push('create-resolved')
				return handle
			},
			onEvent: (event) => {
				// The model has answered and the acquisition is still pending.
				if (event.type === 'message_completed') {
					expect(events.some((seen) => seen.type === 'sandbox_created')).toBe(false)
					allocation.resolve(boundary())
				}
			},
		})
		const finished = await result
		expect(finished.stopReason).toBe('end_turn')
		expect(trace).toEqual(['create-called', 'request', 'create-resolved'])
		const order = types(events)
		expect(order.indexOf('message_completed')).toBeLessThan(order.indexOf('sandbox_created'))
		expect(order.indexOf('sandbox_created')).toBeLessThan(order.indexOf('turn_completed'))
		expect(order.at(-1)).toBe('sandbox_destroyed')
	})

	it('holds the first tool call until the sandbox exists and hands it to the tool', async () => {
		const allocation = deferred<Sandbox>()
		const script = toolTurn()
		const model = new MockLLMProvider({ turns: script.turns })
		const { result, events } = await run({
			acquire: 'concurrent',
			provider: model,
			tools: script.tools,
			create: () => allocation.promise,
			onEvent: (event) => {
				if (event.type === 'message_completed' && script.ran.length === 0) {
					expect(script.ran).toHaveLength(0)
					allocation.resolve(boundary())
				}
			},
		})
		const finished = await result
		expect(finished.stopReason).toBe('end_turn')
		expect(script.ran).toEqual([{ sandbox: true }])
		const order = types(events)
		expect(order.indexOf('sandbox_created')).toBeLessThan(order.indexOf('tool_executing'))
		expect(order.indexOf('message_completed')).toBeLessThan(order.indexOf('sandbox_created'))
	})

	it('ends the turn as an eager failure does when acquisition fails before any tool call', async () => {
		const failure = new Error('provider refused the claim')
		const outcome = async (acquire: Acquire) => {
			const model = new MockLLMProvider({ turns: [{ text: 'answer' }] })
			const { result, events } = await run({
				acquire,
				provider: model,
				create: async () => {
					throw failure
				},
			})
			const finished = await result
			return { finished, events, requests: model.requests.length }
		}
		const eager = await outcome('eager')
		const concurrent = await outcome('concurrent')
		expect(eager.requests).toBe(0)
		expect(concurrent.requests).toBe(1)
		expect(concurrent.finished.status).toBe(eager.finished.status)
		expect(concurrent.finished.stopReason).toBe(eager.finished.stopReason)
		expect(concurrent.finished.lastError).toBe(eager.finished.lastError)
		expect(concurrent.finished.lastError).toContain('provider refused the claim')
		expect(types(concurrent.events)).not.toContain('sandbox_created')
	})

	it('does not run the tool when acquisition fails at its first use', async () => {
		const allocation = deferred<Sandbox>()
		const script = toolTurn()
		const model = new MockLLMProvider({ turns: script.turns })
		const { result, events } = await run({
			acquire: 'concurrent',
			provider: model,
			tools: script.tools,
			create: () => allocation.promise,
			onEvent: (event) => {
				if (event.type === 'message_completed') allocation.reject(new Error('no capacity'))
			},
		})
		const finished = await result
		expect(finished.lastError).toContain('no capacity')
		expect(script.ran).toHaveLength(0)
		expect(model.requests).toHaveLength(1)
		expect(types(events)).not.toContain('tool_executing')
	})

	it('releases a pending acquisition when the turn is aborted, and a late handle with it', async () => {
		const allocation = deferred<Sandbox>()
		const destroyed = deferred<void>()
		const caller = new AbortController()
		const model = new MockLLMProvider({
			turns: [{ text: 'never finishes' }],
			// The first model request is out while the acquisition is pending.
			onRequest: () => caller.abort(new TurnCancelled('user')),
		})
		const { result, events } = await run({
			acquire: 'concurrent',
			provider: model,
			signal: caller.signal,
			// Ignores its signal, as a provider mid-claim may.
			create: () => allocation.promise,
		})
		const finished = await result
		expect(finished.status).toBe('cancelled')
		expect(finished.stopReason).toBe('cancelled')
		expect(model.requests).toHaveLength(1)
		allocation.resolve(boundary(async () => destroyed.resolve()))
		await destroyed.promise
		expect(types(events)).not.toContain('sandbox_created')
	})

	it('ends the turn with the timeout stop reason when the acquisition outlives the turn', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
		try {
			const allocation = deferred<Sandbox>()
			const created = deferred<void>()
			const destroyed = deferred<void>()
			const model = new MockLLMProvider({ turns: [{ text: 'answer' }] })
			const { result, events } = await run({
				acquire: 'concurrent',
				provider: model,
				timeoutMs: 100,
				create: () => {
					created.resolve()
					return allocation.promise
				},
			})
			await created.promise
			await vi.advanceTimersByTimeAsync(100)
			const finished = await result
			expect(finished.stopReason).toBe('timeout')
			expect(model.requests).toHaveLength(1)
			expect(types(events)).not.toContain('sandbox_created')

			allocation.resolve(boundary(async () => destroyed.resolve()))
			await destroyed.promise
		} finally {
			vi.useRealTimers()
		}
	})

	it('releases a handle that arrives after the turn has settled, exactly once', async () => {
		const allocation = deferred<Sandbox>()
		const created = deferred<void>()
		const destroyed = deferred<void>()
		const destroy = vi.fn(async () => destroyed.resolve())
		const caller = new AbortController()
		const model = new MockLLMProvider({ turns: [{ text: 'answer' }] })
		const { result } = await run({
			acquire: 'concurrent',
			provider: model,
			signal: caller.signal,
			create: () => {
				created.resolve()
				return allocation.promise
			},
			onEvent: (event) => {
				if (event.type === 'message_completed') caller.abort(new TurnCancelled('user'))
			},
		})
		await created.promise
		await result
		allocation.resolve(boundary(destroy))
		await destroyed.promise
		// "Exactly once" is only proven once nothing else can still arrive: let
		// every queued continuation and I/O callback run, then count.
		await settleQueues()
		expect(destroy).toHaveBeenCalledTimes(1)
	})
})

describe("sandbox.acquire: 'on-first-use'", () => {
	it('never acquires on a turn without a tool call', async () => {
		const create = vi.fn(async () => boundary())
		const model = new MockLLMProvider({ turns: [{ text: 'answer' }] })
		const { result, events } = await run({
			acquire: 'on-first-use',
			provider: model,
			create,
		})
		const finished = await result
		expect(finished.stopReason).toBe('end_turn')
		expect(create).not.toHaveBeenCalled()
		expect(types(events)).not.toContain('sandbox_created')
	})

	it('acquires at the first tool call, once, and hands the sandbox to the tool', async () => {
		const trace: string[] = []
		const script = toolTurn()
		const model = new MockLLMProvider({
			turns: script.turns,
			onRequest: () => trace.push('request'),
		})
		const create = vi.fn(async () => {
			trace.push('create')
			return boundary()
		})
		const { result, events } = await run({
			acquire: 'on-first-use',
			provider: model,
			tools: script.tools,
			create,
		})
		const finished = await result
		expect(finished.stopReason).toBe('end_turn')
		expect(create).toHaveBeenCalledTimes(1)
		expect(trace).toEqual(['request', 'create', 'request'])
		expect(script.ran).toEqual([{ sandbox: true }])
		expect(types(events)).toContain('sandbox_created')
	})
})

describe('sandbox.acquire: safety properties', () => {
	// A tool that reads the call's command line is examined by the escalation
	// pass (`escalationOf`), which asks the tool for its shell dialect. The
	// spy records whether a sandbox existed when it was asked. The review of a
	// batch, and the escalation that feeds it, must be computed after the gate,
	// or an escalation is decided against a turn whose sandbox is not there yet.
	function dialectProbe() {
		const askedWith: { sandboxCreated: boolean; sandboxed: boolean }[] = []
		let created = false
		let armed = false
		const tool = defineTool({
			name: 'shell_probe',
			description: 'Takes a command line.',
			inputSchema: z.object({ command: z.string() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			commandArgument: 'command',
			commandDialect: ({ sandboxed }) => {
				if (armed) askedWith.push({ sandboxCreated: created, sandboxed })
				return 'sh'
			},
			execute: async () => ({ success: true, output: 'ok' }),
		})
		return {
			askedWith,
			markCreated: () => {
				created = true
			},
			arm: () => {
				armed = true
			},
			tools: [testToolset(tool)],
			turns: [
				{ toolCalls: [{ id: 'call_1', name: 'shell_probe', args: { command: 'echo hi' } }] },
				{ text: 'done' },
			],
		}
	}

	it('holds a batch at the gate before it is reviewed or escalated', async () => {
		const allocation = deferred<Sandbox>()
		const probe = dialectProbe()
		const model = new MockLLMProvider({ turns: probe.turns })
		const { result, events } = await run({
			acquire: 'concurrent',
			provider: model,
			tools: probe.tools,
			create: () => allocation.promise,
			onEvent: (event) => {
				// The model has answered; the sandbox arrives in a later macrotask,
				// so a pass that did not wait for it would run first.
				if (event.type === 'message_completed') {
					probe.arm()
					setTimeout(() => {
						probe.markCreated()
						allocation.resolve(boundary())
					}, 20)
				}
			},
		})
		const finished = await result
		expect(finished.stopReason).toBe('end_turn')
		expect(probe.askedWith.length).toBeGreaterThan(0)
		for (const asked of probe.askedWith) {
			expect(asked).toEqual({ sandboxCreated: true, sandboxed: true })
		}
		const order = types(events)
		expect(order.indexOf('sandbox_created')).toBeLessThan(order.indexOf('tool_review_requested'))
	})

	it("refuses a bad 'acquire' value with invalid_config, with or without a provider", async () => {
		for (const withoutProvider of [false, true]) {
			const model = new MockLLMProvider({ turns: [{ text: 'never asked' }] })
			const create = vi.fn(async () => boundary())
			const { result } = await run({
				acquire: 'sometimes' as Acquire,
				provider: model,
				create,
				withoutProvider,
			})
			const finished = await result
			expect(finished.status).toBe('failed')
			expect(finished.lastError).toContain(
				"sandbox.acquire must be 'eager', 'concurrent' or 'on-first-use'",
			)
			expect(model.requests).toHaveLength(0)
			expect(create).not.toHaveBeenCalled()
		}
	})

	it('tears the late handle down exactly once, and runs no tool, when the first model request fails', async () => {
		const allocation = deferred<Sandbox>()
		const created = deferred<void>()
		const destroyed = deferred<void>()
		const destroy = vi.fn(async () => destroyed.resolve())
		const script = toolTurn()
		const model = new MockLLMProvider({
			turns: [{ error: { message: 'upstream refused', status: 400 } }],
		})
		const { result, events } = await run({
			acquire: 'concurrent',
			provider: model,
			tools: script.tools,
			create: () => {
				created.resolve()
				return allocation.promise
			},
		})
		await created.promise
		const finished = await result
		expect(finished.status).toBe('failed')
		expect(finished.lastError).toContain('upstream refused')
		expect(script.ran).toHaveLength(0)
		// The allocation answers after the turn is over.
		allocation.resolve(boundary(destroy))
		await destroyed.promise
		await settleQueues()
		expect(destroy).toHaveBeenCalledTimes(1)
		expect(types(events)).not.toContain('sandbox_created')
		expect(types(events)).not.toContain('tool_executing')
	})

	it('records a timed-out acquisition as the timeout, not as a failed step', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
		try {
			const allocation = deferred<Sandbox>()
			const created = deferred<void>()
			const destroyed = deferred<void>()
			const script = toolTurn()
			const steps: StepResult[] = []
			const model = new MockLLMProvider({ turns: script.turns })
			const { result } = await run({
				acquire: 'concurrent',
				provider: model,
				tools: script.tools,
				timeoutMs: 100,
				onStepFinish: (step) => steps.push(step),
				create: () => {
					created.resolve()
					return allocation.promise
				},
				onEvent: (event) => {
					if (event.type === 'message_completed') void vi.advanceTimersByTimeAsync(100)
				},
			})
			await created.promise
			const finished = await result
			expect(finished.stopReason).toBe('timeout')
			expect(script.ran).toHaveLength(0)
			// The step the model spent is kept, as a stopped one; none is an error.
			expect(steps.map((step) => step.finishReason)).toEqual(['cancelled'])
			allocation.resolve(boundary(async () => destroyed.resolve()))
			await destroyed.promise
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('a follow-up turn after a rejected sandbox gate', () => {
	it('sends the provider no tool call without its result', async () => {
		const log = new InMemorySessionLog({
			sessionId: '82374a6e-20d2-4f11-b06f-5792141c0497' as SessionId,
		})
		const allocation = deferred<Sandbox>()
		const script = toolTurn()
		const first = await run({
			acquire: 'concurrent',
			provider: new MockLLMProvider({ turns: script.turns }),
			tools: script.tools,
			sessionLog: log,
			create: () => allocation.promise,
			onEvent: (event) => {
				if (event.type === 'message_completed') allocation.reject(new Error('no capacity'))
			},
		})
		const firstTurn = await first.result
		expect(firstTurn.lastError).toContain('no capacity')
		expect(script.ran).toHaveLength(0)
		// The precondition: the rejected turn left a tool call with no result.
		const strandedCalls = firstTurn.messages.flatMap((message) =>
			message.role === 'assistant' ? (message.toolCalls ?? []) : [],
		)
		expect(strandedCalls).toHaveLength(1)
		expect(firstTurn.messages.some((message) => message.role === 'tool')).toBe(false)

		const followUp = new MockLLMProvider({ turns: [{ text: 'recovered' }] })
		const second = await run({
			acquire: 'eager',
			withoutProvider: true,
			provider: followUp,
			sessionLog: log,
			messages: [...firstTurn.messages, createUserMessage('try again')],
			create: async () => boundary(),
		})
		const secondTurn = await second.result
		expect(secondTurn.stopReason).toBe('end_turn')
		const sent = followUp.requests[0]?.messages ?? []
		const calledIds = sent.flatMap((message) =>
			message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : [],
		)
		const answeredIds = sent.flatMap((message) =>
			message.role === 'tool' ? [message.toolCallId] : [],
		)
		expect(calledIds.sort()).toEqual(answeredIds.sort())
	})
})
