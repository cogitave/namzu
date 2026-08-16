import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import { SteeringBinding } from '../steering.js'

/**
 * Two public APIs could accept text and never deliver it.
 *
 * `AgentManager.continueTask` and `queueMessage` pushed onto
 * `pendingMessages` and nothing in the kernel drained it — the manager
 * interface's own docblock said "the runtime does not deliver it", and
 * `continue_task` was unmounted from the coordinator tools because of that.
 *
 * The steering channel had the mirror-image hole. It can only append to a
 * settled tool result, so guidance queued during a turn that called no
 * tools stayed pending, and the loop then ended the run with the channel
 * still full.
 *
 * Every assertion here is on what the PROVIDER was sent. A test that
 * checked the queue was empty would pass against a drain that dropped the
 * messages on the floor.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** Captures the message list of every request. */
class CapturingProvider extends MockLLMProvider {
	readonly sent: Message[][] = []
	override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.sent.push([...(params.messages as Message[])])
		yield* super.chatStream(params)
	}
}

function registry(): ToolRegistry {
	const r = new ToolRegistry()
	r.register(
		defineTool({
			name: 'probe',
			description: 'probes',
			inputSchema: z.object({}),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'ok' }),
		}),
	)
	return r
}

const textOf = (messages: Message[]) =>
	messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')

async function run(opts: {
	turns: unknown[]
	inbound?: () => Message[]
	steering?: SteeringBinding
}) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-inbound-'))
	dirs.push(workingDirectory)
	const provider = new CapturingProvider({ turns: opts.turns as never })

	const result = await drainQuery({
		provider,
		tools: registry(),
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_i' as SessionId,
		topicId: 'top_i' as TopicId,
		projectId: 'prj_i' as ProjectId,
		tenantId: 'tnt_i' as TenantId,
		...(opts.inbound ? { inboundMessages: opts.inbound } : {}),
		...(opts.steering ? { steering: opts.steering } : {}),
	})

	return { result, requests: provider.sent }
}

/** A queue that yields its contents once, exactly as the manager's drain does. */
function onceQueue(...messages: Message[]): () => Message[] {
	let drained = false
	return () => {
		if (drained) return []
		drained = true
		return messages
	}
}

describe('text queued between turns arrives at the next one', () => {
	it('puts a queued message in the next request', async () => {
		// Asserted on the request the provider received, not on the queue
		// being empty — a drain that dropped everything on the floor empties
		// the queue too.
		const { requests } = await run({
			turns: [{ text: 'first answer' }, { text: 'done' }],
			inbound: onceQueue(createUserMessage('switch to Y')),
		})

		expect(requests.length).toBeGreaterThanOrEqual(2)
		expect(textOf(requests[1] as Message[])).toContain('switch to Y')
	})

	it('delivers steering guidance stranded by a turn that called no tools', async () => {
		// The channel can only ride on a settled tool result. A turn of pure
		// prose has none, so this guidance used to sit pending until the run
		// ended — and the steering suite pinned that as correct.
		const steering = new SteeringBinding()
		steering.steer('actually, use the other file')

		const { requests } = await run({
			turns: [{ text: 'first answer' }, { text: 'done' }],
			steering,
		})

		expect(textOf(requests[1] as Message[])).toContain('actually, use the other file')
		// And the channel is empty, because it was delivered rather than
		// carried into a run that has ended.
		expect(steering.pending).toBe(false)
	})

	it('costs exactly one extra turn, and only when something was queued', async () => {
		// The bound. A drain that re-delivers, or a `continue` that fires on
		// an empty queue, shows up here as an extra request.
		const withQueue = await run({
			turns: [{ text: 'first' }, { text: 'done' }],
			inbound: onceQueue(createUserMessage('one more thing')),
		})
		const without = await run({ turns: [{ text: 'first' }] })

		expect(withQueue.requests).toHaveLength(without.requests.length + 1)
	})

	it('changes nothing at all for a run with an empty queue', async () => {
		// The overwhelmingly common case. An empty drain must not cost an
		// iteration, a model call, or a message in the history.
		const withCallback = await run({ turns: [{ text: 'done' }], inbound: () => [] })
		const without = await run({ turns: [{ text: 'done' }] })

		expect(withCallback.requests).toHaveLength(without.requests.length)
		expect(textOf(withCallback.requests[0] as Message[])).toBe(
			textOf(without.requests[0] as Message[]),
		)
	})

	it('delivers on a turn that DID call tools, in the same request as its results', async () => {
		// The other seam. Here the message rides beside the tool results
		// rather than causing a turn of its own, so the count must not grow.
		const { requests } = await run({
			turns: [
				{ toolCalls: [{ id: 't1', name: 'probe', args: {} }], finishReason: 'tool_calls' },
				{ text: 'done' },
			],
			inbound: onceQueue(createUserMessage('and check the log too')),
		})

		expect(textOf(requests[1] as Message[])).toContain('and check the log too')
	})

	it('does not deliver the same message twice', async () => {
		// The queue is drained, not read. A drain that peeked would re-deliver
		// on every boundary for the rest of the run.
		const { requests } = await run({
			turns: [{ text: 'a' }, { text: 'b' }, { text: 'done' }],
			inbound: onceQueue(createUserMessage('exactly once')),
		})

		const deliveries = requests.filter((r) => textOf(r).includes('exactly once')).length
		// Present in every request after the one that received it — history
		// accumulates — but pushed only once, so the LAST request holds one
		// copy.
		expect(deliveries).toBeGreaterThan(0)
		const last = textOf(requests[requests.length - 1] as Message[])
		expect(last.split('exactly once')).toHaveLength(2)
	})
})
