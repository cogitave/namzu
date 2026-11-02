import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { createUserMessage } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import {
	type BackgroundJob,
	type BackgroundJobOutput,
	BackgroundJobRegistry,
} from '../../jobs/registry.js'
import { drainQuery } from '../index.js'
import {
	JOB_NOTICE_INLINE_OUTPUT_MAX_BYTES,
	SteeringBinding,
	formatJobExitNotice,
} from '../steering.js'

/**
 * A job that exits while the model is waiting on it is told once: by the result
 * of the call that collected it, never again by an exit notice for the same exit.
 */
class SignalledJobs extends BackgroundJobRegistry {
	private readonly listeners = new Set<(job: BackgroundJob) => void>()
	private readonly known = new Map<string, BackgroundJob>()
	output = 'built ok\n'

	override onExit(listener: (job: BackgroundJob) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	override get(id: string): BackgroundJob {
		const job = this.known.get(id)
		if (!job) throw new Error(`unknown ${id}`)
		return job
	}

	override read(id: string): BackgroundJobOutput {
		return {
			chunk: this.output,
			nextOffset: Buffer.byteLength(this.output),
			droppedBytes: 0,
			status: this.get(id).status,
			exitCode: 0,
		}
	}

	announce(owner: string, id: string): void {
		const job: BackgroundJob = {
			id,
			owner,
			command: 'build',
			status: 'exited',
			startedAt: 1,
			exitedAt: 2,
			exitCode: 0,
		}
		this.known.set(id, job)
		for (const listener of this.listeners) listener(job)
	}
}

async function run(options: { collect: boolean; output?: string }) {
	const registry = new SignalledJobs()
	if (options.output !== undefined) registry.output = options.output
	const owner = generateSessionId()
	const sessionId = generateSessionId()
	const acknowledgements: string[][] = []
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ id: 'call_1', name: 'wait_step', args: {} }] }, { text: 'finished' }],
	})
	const tool = defineTool({
		name: 'wait_step',
		description: 'Collects a job that exits while it waits',
		inputSchema: z.object({}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async (_input, context) => {
			registry.announce(owner, 'b00000001')
			if (options.collect) context.backgroundJobs?.markCollected?.('b00000001')
			return { success: true, output: 'job exited' }
		},
	})
	const result = await drainQuery({
		provider,
		toolsets: [testToolset(tool)],
		agentId: 'collected-job-test',
		agentName: 'Collected job test',
		messages: [createUserMessage('wait for the build')],
		workingDirectory: process.cwd(),
		projectId: generateProjectId(),
		sessionId,
		sessionLog: new InMemorySessionLog({ sessionId }),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		turnConfig: {
			model: 'mock',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 3,
		},
		backgroundJobs: registry,
		backgroundJobOwner: owner,
		onJobNoticeDelivered: (ids) => acknowledgements.push([...ids]),
	})
	const notice = result.messages.find(
		(message) =>
			message.role === 'user' &&
			typeof message.content === 'string' &&
			message.content.includes('[Background job update]'),
	)
	return { result, acknowledgements, notice }
}

describe('a job whose exit a tool result already delivered', () => {
	it('is not announced again by an exit notice, and the host is told it was delivered', async () => {
		const { result, acknowledgements, notice } = await run({ collect: true })
		expect(result.status).toBe('completed')
		expect(notice).toBeUndefined()
		expect(acknowledgements).toEqual([['b00000001']])
	})

	it('is announced once when nothing collected it, with the output that fits inline', async () => {
		const { notice, acknowledgements } = await run({ collect: false })
		expect(typeof notice?.content === 'string' ? notice.content : '').toContain('built ok')
		expect(acknowledgements).toEqual([['b00000001']])
	})
})

describe('the output a job-exit notice carries', () => {
	const job = {
		id: 'b00000001',
		command: 'build',
		status: 'exited',
		exitCode: 0,
	} as const

	it('is inlined, framed as untrusted, when the whole of it fits the limit', () => {
		const text = formatJobExitNotice(job, {
			chunk: 'ok\n',
			nextOffset: 3,
			droppedBytes: 0,
		})
		expect(text).toContain('ok')
		expect(text).toContain('not the operator')
		expect(text).not.toContain('Read its output with the job tool')
	})

	it('is left to the job tool when it is larger than the limit', () => {
		const text = formatJobExitNotice(job, {
			chunk: 'x'.repeat(10),
			nextOffset: JOB_NOTICE_INLINE_OUTPUT_MAX_BYTES + 1,
			droppedBytes: 0,
		})
		expect(text).toContain('Read its output with the job tool')
		expect(text).not.toContain('xxxx')
	})

	it('is left to the job tool when the retention cap dropped some of it', () => {
		const text = formatJobExitNotice(job, {
			chunk: 'tail',
			nextOffset: 4,
			droppedBytes: 9,
		})
		expect(text).toContain('Read its output with the job tool')
	})
})

describe('withdrawing a queued notice', () => {
	it('removes only the text queued under that key', () => {
		const channel = new SteeringBinding()
		channel.steer('first', 'a')
		channel.steer('second', 'b')
		expect(channel.withdraw('a')).toBe(true)
		expect(channel.withdraw('a')).toBe(false)
		expect(channel.drain()).toBe('second')
		expect(channel.pending).toBe(false)
	})
})
