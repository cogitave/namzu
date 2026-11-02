import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { DETACH_AFTER_MS } from '../detached-calls.js'
import { drainQuery } from '../index.js'

/**
 * The operator asks how things stand while a long call is running.
 *
 * The question used to wait for the call to finish. These tests drive the real
 * loop with a fake model and a fake clock: the call is held open, the operator
 * writes, and what is asserted is what the MODEL was sent and when.
 */

registerMock()

const dirs: string[] = []

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(async () => {
	vi.useRealTimers()
	await removeTempDirs(dirs)
	dirs.length = 0
})

class CapturingProvider extends MockLLMProvider {
	readonly sent: Message[][] = []
	onSent: ((count: number) => void) | undefined
	override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.sent.push([...(params.messages as Message[])])
		this.onSent?.(this.sent.length)
		yield* super.chatStream(params)
	}
}

const textOf = (messages: readonly Message[]) =>
	messages
		.map(
			(m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`,
		)
		.join('\n')

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

/** A host inbox: messages pushed by the test, a wake the loop can wait on. */
function inbox() {
	const queue: Message[] = []
	const waiters = new Set<() => void>()
	const operatorWaiters = new Set<() => void>()
	const waitOn = (set: Set<() => void>, signal: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			if (queue.length > 0) return resolve()
			const wake = () => {
				set.delete(wake)
				resolve()
			}
			set.add(wake)
			signal.addEventListener(
				'abort',
				() => {
					set.delete(wake)
					reject(signal.reason)
				},
				{ once: true },
			)
		})
	return {
		push(text: string) {
			queue.push(createUserMessage(text))
			for (const wake of [...waiters]) wake()
			for (const wake of [...operatorWaiters]) wake()
		},
		/** Another source of input (a child's notice, a peer's mail) wakes the loop, not the operator. */
		wakeWithoutOperator() {
			for (const wake of [...waiters]) wake()
		},
		waitForOperator: (signal: AbortSignal) => waitOn(operatorWaiters, signal),
		inboundMessages: () => queue.splice(0, queue.length),
		waitForInbound: (signal: AbortSignal) =>
			new Promise<void>((resolve, reject) => {
				if (queue.length > 0) return resolve()
				const wake = () => {
					waiters.delete(wake)
					resolve()
				}
				waiters.add(wake)
				signal.addEventListener(
					'abort',
					() => {
						waiters.delete(wake)
						reject(signal.reason)
					},
					{ once: true },
				)
			}),
	}
}

async function start(options: {
	turns: unknown[]
	release: ReturnType<typeof deferred>
	fail?: boolean
	optOut?: boolean
}) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-detach-'))
	dirs.push(workingDirectory)
	const started = deferred()
	let executions = 0
	const slow = defineTool({
		name: 'long_build',
		description: 'a long build',
		inputSchema: z.object({}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async () => {
			executions++
			started.resolve()
			await options.release.promise
			if (options.fail) return { success: false, output: '', error: 'the build crashed' }
			return { success: true, output: 'build finished: 12 passed' }
		},
	})
	const provider = new CapturingProvider({ turns: options.turns as never })
	const host = inbox()
	const requested = new Map<number, ReturnType<typeof deferred>>()
	const requestSeen = (count: number) => {
		let entry = requested.get(count)
		if (!entry) {
			entry = deferred()
			requested.set(count, entry)
		}
		return entry.promise
	}
	provider.onSent = (count) => {
		requestSeen(count)
		requested.get(count)?.resolve()
	}
	const run = drainQuery({
		provider,
		toolsets: [testToolset(slow)],
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('build it')],
		workingDirectory,
		sessionId: '4970651e-37ae-4b4a-92c2-4c52e1428108' as SessionId,
		topicId: 'ce38fa45-e43f-42f8-93fb-3c172e86fbfd' as TopicId,
		projectId: '78c64c0b-4e41-463a-a5a7-b0aa85c33338' as ProjectId,
		tenantId: '2d00498b-cbc5-4c9a-a2bd-ff8eee5dbd80' as TenantId,
		inboundMessages: host.inboundMessages,
		waitForInbound: host.waitForInbound,
		waitForOperator: host.waitForOperator,
		...(options.optOut ? {} : { answerWhileCallsRun: true }),
	})
	return {
		run,
		provider,
		host,
		started: started.promise,
		requestSeen,
		executions: () => executions,
	}
}

const CALL = { toolCalls: [{ id: 'call-1', name: 'long_build', rawArguments: '{}' }] }

describe('an operator message while a call is running', () => {
	it('is answered before the call ends, the call is not repeated, and its result arrives later', async () => {
		const release = deferred()
		const t = await start({
			release,
			turns: [CALL, { text: 'The build is still running.' }, { text: 'Build done: 12 passed.' }],
		})
		await t.started

		t.host.push('ne alemde?')
		await vi.advanceTimersByTimeAsync(0)
		await vi.advanceTimersByTimeAsync(DETACH_AFTER_MS)
		await t.requestSeen(2)

		// The model's second request carries the placeholder as the call's result
		// and the operator's question after it, while the call is still open.
		const second = textOf(t.provider.sent[1] ?? [])
		expect(second).toContain('[Still running]')
		expect(second).toContain('was not interrupted')
		expect(second).toContain('ne alemde?')
		expect(second).not.toContain('build finished')
		const roles = (t.provider.sent[1] ?? []).map((m) => m.role)
		expect(roles.slice(-3)).toEqual(['assistant', 'tool', 'user'])

		release.resolve()
		const result = await t.run
		expect(t.executions()).toBe(1)

		// The real result reaches the model as a message of its own that names the call.
		const third = textOf(t.provider.sent[2] ?? [])
		expect(third).toContain('call-1')
		expect(third).toContain('build finished: 12 passed')
		expect(result.stopReason).not.toBe('cancelled')
	})

	it('is not handed back when something other than the operator wakes the loop', async () => {
		const release = deferred()
		const t = await start({ release, turns: [CALL, { text: 'All done.' }] })
		await t.started

		t.host.wakeWithoutOperator()
		await vi.advanceTimersByTimeAsync(DETACH_AFTER_MS * 5)
		expect(t.provider.sent).toHaveLength(1)

		release.resolve()
		await t.run
		const second = textOf(t.provider.sent[1] ?? [])
		expect(second).toContain('build finished: 12 passed')
		expect(second).not.toContain('[Still running]')
	})

	it('waits for a call that has run less than the grace period', async () => {
		const release = deferred()
		const t = await start({
			release,
			turns: [CALL, { text: 'All done.' }],
		})
		await t.started

		t.host.push('quick question')
		await vi.advanceTimersByTimeAsync(DETACH_AFTER_MS - 1)
		expect(t.provider.sent).toHaveLength(1)

		release.resolve()
		await t.run
		// The call finished inside the grace period: its own result, no placeholder.
		const second = textOf(t.provider.sent[1] ?? [])
		expect(second).toContain('build finished: 12 passed')
		expect(second).not.toContain('[Still running]')
		expect(second).toContain('quick question')
	})

	it('never ends the turn cancelled when the operator asks twice while it answers', async () => {
		const release = deferred()
		const t = await start({
			release,
			turns: [
				CALL,
				{ text: 'Still building.' },
				{ text: 'Still building, no change.' },
				{ text: 'Finished: 12 passed.' },
			],
		})
		await t.started

		t.host.push('ne alemde?')
		await vi.advanceTimersByTimeAsync(0)
		await vi.advanceTimersByTimeAsync(DETACH_AFTER_MS)
		await t.requestSeen(2)
		t.host.push('hala mı çalışıyor?')
		await vi.advanceTimersByTimeAsync(0)
		await vi.advanceTimersByTimeAsync(DETACH_AFTER_MS)
		await t.requestSeen(3)
		expect(textOf(t.provider.sent[2] ?? [])).toContain('hala mı çalışıyor?')

		release.resolve()
		const result = await t.run
		expect(result.stopReason).not.toBe('cancelled')
		expect(t.executions()).toBe(1)
	})

	it('tells the model when the call it was told was still running failed', async () => {
		const release = deferred()
		const t = await start({
			release,
			fail: true,
			turns: [CALL, { text: 'Still running.' }, { text: 'It failed.' }],
		})
		await t.started

		t.host.push('ne alemde?')
		await vi.advanceTimersByTimeAsync(0)
		await vi.advanceTimersByTimeAsync(DETACH_AFTER_MS)
		await t.requestSeen(2)

		release.resolve()
		await t.run
		const third = textOf(t.provider.sent[2] ?? [])
		expect(third).toContain('has finished with an error')
		expect(third).toContain('the build crashed')
	})

	it('leaves a call alone when the host did not ask to answer during calls', async () => {
		const release = deferred()
		const t = await start({ release, turns: [CALL, { text: 'done' }], optOut: true })
		await t.started
		t.host.push('ne alemde?')
		await vi.advanceTimersByTimeAsync(0)
		await vi.advanceTimersByTimeAsync(DETACH_AFTER_MS * 5)
		expect(t.provider.sent).toHaveLength(1)
		release.resolve()
		await t.run
		expect(textOf(t.provider.sent[1] ?? [])).not.toContain('[Still running]')
	})
})
