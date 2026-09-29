import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type BackgroundJob, BackgroundJobRegistry } from '../../jobs/registry.js'
import { drainQuery } from '../index.js'
import { deliverArrivedJobExits, deliverAwaitedJobExits } from '../iteration/outstanding-work.js'
import type { IterationContext } from '../iteration/phases/context.js'
import { SteeringBinding } from '../steering.js'

class SignalledJobs extends BackgroundJobRegistry {
	private readonly listeners = new Set<(job: BackgroundJob) => void>()

	override onExit(listener: (job: BackgroundJob) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
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
		for (const listener of this.listeners) listener(job)
	}
}

async function run(exitAt: 'tool-result' | 'final-answer') {
	const registry = new SignalledJobs()
	const owner = generateSessionId()
	const sessionId = generateSessionId()
	const acknowledgements: string[][] = []
	let requests = 0
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ id: 'call_1', name: 'finish_step', args: {} }] }, { text: 'finished' }],
		onRequest: () => {
			requests += 1
			if (requests === 2 && exitAt === 'final-answer') registry.announce(owner, 'job_1')
		},
	})
	const tool = defineTool({
		name: 'finish_step',
		description: 'Finishes a step while a background job may exit',
		inputSchema: z.object({}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async () => {
			if (exitAt === 'tool-result') registry.announce(owner, 'job_1')
			return { success: true, output: 'step complete' }
		},
	})
	const result = await drainQuery({
		provider,
		toolsets: [testToolset(tool)],
		agentId: 'job-ack-test',
		agentName: 'Job acknowledgement test',
		messages: [createUserMessage('finish the step')],
		workingDirectory: process.cwd(),
		projectId: generateProjectId(),
		sessionId,
		sessionLog: new InMemorySessionLog({ sessionId }),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		turnConfig: { model: 'mock', timeoutMs: 10_000, tokenBudget: 100_000, maxIterations: 3 },
		backgroundJobs: registry,
		backgroundJobOwner: owner,
		onJobNoticeDelivered: (ids) => acknowledgements.push([...ids]),
	})
	return { result, acknowledgements }
}

describe('background job notice acknowledgement', () => {
	it('acknowledges an exit only after its notice enters a tool result', async () => {
		const { result, acknowledgements } = await run('tool-result')
		expect(result.status).toBe('completed')
		expect(acknowledgements).toEqual([['job_1']])
		expect(
			result.messages.some(
				(message) =>
					message.role === 'tool' &&
					typeof message.content === 'string' &&
					message.content.includes('[Background job update]'),
			),
		).toBe(true)
	})

	it('does not acknowledge an exit after the final tool result', async () => {
		const { result, acknowledgements } = await run('final-answer')
		expect(result.status).toBe('completed')
		expect(acknowledgements).toEqual([])
		expect(
			result.messages.some(
				(message) =>
					message.role === 'tool' &&
					typeof message.content === 'string' &&
					message.content.includes('[Background job update]'),
			),
		).toBe(false)
	})

	it.each([
		['awaited grace', deliverAwaitedJobExits],
		['final settlement', deliverArrivedJobExits],
	] as const)('acknowledges %s only after recording the job-exit context', (_, deliver) => {
		const notices = new SteeringBinding()
		notices.steer('job_1 exited with code 0')
		const messages: Message[] = []
		const acknowledgedAfter: string[] = []
		const exit: BackgroundJob = {
			id: 'job_1',
			owner: 'session',
			command: 'build',
			status: 'exited',
			startedAt: 1,
			exitedAt: 2,
			exitCode: 0,
		}
		const ctx = {
			jobNotices: notices,
			awaitedJobs: {
				takeDelivery: (notice: () => string | undefined) => {
					const text = notice()
					return text === undefined ? undefined : { text, exits: [exit] }
				},
			},
			recorder: {
				turnId: 'turn',
				pushMessage: (message: Message) => messages.push(message),
				materializeResult: () => 'final answer',
				setResult: () => {},
			},
			log: { info: () => {} },
			onJobNoticeDelivered: () => {
				acknowledgedAfter.push(messages.at(-1)?.content as string)
			},
		} as unknown as IterationContext

		deliver(ctx)

		expect(messages).toHaveLength(1)
		const delivered = messages[0]
		if (delivered?.role !== 'user') throw new Error('job exit context was not recorded')
		expect(delivered.source).toEqual({ type: 'runtime-context', kind: 'job-exit' })
		expect(acknowledgedAfter).toEqual([delivered.content])
		expect(acknowledgedAfter[0]).toContain('job_1 exited with code 0')
	})
})
