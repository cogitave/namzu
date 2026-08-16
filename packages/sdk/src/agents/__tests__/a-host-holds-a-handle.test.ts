import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../provider/index.js'
import { ToolRegistry } from '../../registry/index.js'
import { drainQuery } from '../../runtime/query/index.js'
import { SteeringBinding } from '../../runtime/query/steering.js'
import { DiskTopicStateStore, InMemoryTopicStateStore } from '../../store/topic/state.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import { type Message, createUserMessage } from '../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { AgentNotRunningError, createAgentHandle } from '../handle.js'

/**
 * A host had no object to hold between runs.
 *
 * No way to ask whether the agent was running, and nowhere to put "when you
 * next run, start with this" — so a host either held a steer until it
 * observed a run starting, or carried the text itself and passed it
 * manually on the next `run()` call.
 *
 * Two delivery targets with stated lifetimes, and no silent third state.
 * `steer` reaches the run that is happening; `queueForNextRun` reaches the
 * one that has not started. `steer` on an idle handle THROWS rather than
 * accepting into a queue nothing will read.
 */

registerMock()

const TOPIC = 'top_handle' as TopicId
const TENANT = 'tnt_handle' as TenantId

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

class CapturingProvider extends MockLLMProvider {
	readonly sent: Message[][] = []
	override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.sent.push([...(params.messages as Message[])])
		yield* super.chatStream(params)
	}
}

const textOf = (messages: Message[]) =>
	messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')

async function runOnce(store: InMemoryTopicStateStore | DiskTopicStateStore) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-handle-'))
	dirs.push(workingDirectory)
	const provider = new CapturingProvider({ turns: [{ text: 'done' }] as never })

	await drainQuery({
		provider,
		tools: new ToolRegistry(),
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 3 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_h' as SessionId,
		topicId: TOPIC,
		projectId: 'prj_h' as ProjectId,
		tenantId: TENANT,
		topicStateStore: store,
	})

	return provider.sent
}

describe('steering an idle agent is refused, not queued', () => {
	it('throws, and points at the alternative', () => {
		// Quietly rerouting to `queueForNextRun` would be a host asking to
		// redirect what is happening NOW and getting a message delivered
		// minutes later to a different run — worse than an error, because
		// nothing says it happened.
		const handle = createAgentHandle({
			steering: new SteeringBinding(),
			topicId: TOPIC,
			tenantId: TENANT,
			isRunning: () => false,
		})

		expect(() => handle.steer('go left')).toThrow(AgentNotRunningError)
		expect(() => handle.steer('go left')).toThrow(/queueForNextRun/)
	})

	it('persists nothing as a side effect of the refusal', async () => {
		const topicStateStore = new InMemoryTopicStateStore()
		const steering = new SteeringBinding()
		const handle = createAgentHandle({
			steering,
			topicStateStore,
			topicId: TOPIC,
			tenantId: TENANT,
			isRunning: () => false,
		})

		expect(() => handle.steer('go left')).toThrow()

		// Nothing in the channel and nothing on the record.
		expect(steering.pending).toBe(false)
		expect(await topicStateStore.getState(TOPIC, TENANT)).toBeNull()
	})

	it('delivers to the channel when a run IS in flight', async () => {
		const steering = new SteeringBinding()
		const handle = createAgentHandle({
			steering,
			topicId: TOPIC,
			tenantId: TENANT,
			isRunning: () => true,
		})

		handle.steer('go left')

		expect(steering.pending).toBe(true)
	})
})

describe('status answers at the moment it is asked', () => {
	it('follows the live predicate rather than a stored flag', () => {
		// A stored boolean is only as current as whoever remembered to update
		// it, and the whole value of this object is answering now.
		let running = false
		const handle = createAgentHandle({
			steering: new SteeringBinding(),
			topicId: TOPIC,
			tenantId: TENANT,
			isRunning: () => running,
		})

		expect(handle.status).toBe('idle')
		running = true
		expect(handle.status).toBe('running')
		running = false
		expect(handle.status).toBe('idle')
	})
})

describe('a message queued for the next run arrives in its first request', () => {
	it('is delivered, and only once', async () => {
		const topicStateStore = new InMemoryTopicStateStore()
		const handle = createAgentHandle({
			steering: new SteeringBinding(),
			topicStateStore,
			topicId: TOPIC,
			tenantId: TENANT,
			isRunning: () => false,
		})
		await handle.queueForNextRun(createUserMessage('start with the migration'))

		const first = await runOnce(topicStateStore)
		const second = await runOnce(topicStateStore)

		// FIRST request, not a turn late.
		expect(textOf(first[0] as Message[])).toContain('start with the migration')
		// Cleared as it was read, so a later run does not carry it again.
		expect(textOf(second[0] as Message[])).not.toContain('start with the migration')
	})

	it('survives the store instance that wrote it', async () => {
		// Written through one instance, read by a run built from a fresh one
		// over the same directory. An in-memory-only implementation fails.
		const rootDir = await mkdtemp(join(tmpdir(), 'namzu-handle-disk-'))
		dirs.push(rootDir)
		const handle = createAgentHandle({
			steering: new SteeringBinding(),
			topicStateStore: new DiskTopicStateStore({ rootDir }),
			topicId: TOPIC,
			tenantId: TENANT,
			isRunning: () => false,
		})
		await handle.queueForNextRun(createUserMessage('resume the audit'))

		const sent = await runOnce(new DiskTopicStateStore({ rootDir }))

		expect(textOf(sent[0] as Message[])).toContain('resume the audit')
	})

	it('refuses when the handle has nowhere to put it', async () => {
		// Rather than accepting and dropping. A host that built a handle
		// without a store has a configuration bug, and telling it the message
		// was queued is the failure this whole object exists to avoid.
		const handle = createAgentHandle({
			steering: new SteeringBinding(),
			topicId: TOPIC,
			tenantId: TENANT,
			isRunning: () => false,
		})

		await expect(handle.queueForNextRun(createUserMessage('x'))).rejects.toThrow(
			/topic state store/i,
		)
	})

	it('changes nothing for a run with an empty queue', async () => {
		const topicStateStore = new InMemoryTopicStateStore()

		const sent = await runOnce(topicStateStore)

		expect(textOf(sent[0] as Message[])).toContain('go')
		expect(sent[0]).toHaveLength(
			(await runOnce(new InMemoryTopicStateStore()))[0]?.length as number,
		)
	})
})
