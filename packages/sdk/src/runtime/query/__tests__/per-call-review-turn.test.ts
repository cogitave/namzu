import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import type {
	HITLDecisionRequest,
	HITLResumeDecision,
	ResumeContext,
} from '../../../types/hitl/index.js'
import type { SessionId, TenantId, TurnId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { findPendingCheckpoint, readParks } from '../checkpoint.js'
import { drainQuery } from '../index.js'
import { NOT_RUN_BEFORE_RESTART } from '../resume-pending.js'
import { copySession } from './support/session.js'

/**
 * The per-call review through `query()`: what a turn does with the answers, and
 * what a second process does with the questions a first one left open.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const SESSION_ID = '4867992e-5fe0-44ac-8ad3-84768354abe1' as SessionId
const SCOPE = {
	tenantId: '945ca78a-e487-433d-a206-e2b9c64485c9' as TenantId,
	projectId: 'f4feb4a0-1fe7-447e-a5bb-29988d224bb0' as ProjectId,
	sessionId: SESSION_ID,
	topicId: '62a3b800-6711-4be4-9574-b8821f466408' as TopicId,
	turnId: 'b69a1e4f-bc7c-4031-9fd8-93be940b8ff6' as TurnId,
}

/** Lets pending microtasks and I/O callbacks run; waits for no clock. */
const settleWork = () => new Promise<void>((resolve) => setImmediate(resolve))

function tools(calls: string[]) {
	const look: ToolDefinition<{ id: number }> = {
		name: 'look',
		description: 'Look at a row',
		inputSchema: z.object({ id: z.number() }),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		execute: ({ id }) => {
			calls.push(`look:${id}`)
			return Promise.resolve({ success: true, output: `row ${id}` })
		},
	}
	const del: ToolDefinition<{ id: number }> = {
		name: 'delete_row',
		description: 'Delete a row',
		inputSchema: z.object({ id: z.number() }),
		isDestructive: () => true,
		execute: ({ id }) => {
			calls.push(`delete:${id}`)
			return Promise.resolve({ success: true, output: `deleted ${id}` })
		},
	}
	return testToolset(look as unknown as ToolDefinition, del as unknown as ToolDefinition)
}

async function params(
	provider: MockLLMProvider,
	toolset: ReturnType<typeof tools>,
	log: InMemorySessionLog,
	resumeHandler: (
		request: HITLDecisionRequest,
		context?: ResumeContext,
	) => Promise<HITLResumeDecision>,
) {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-per-call-'))
	dirs.push(dir)
	return {
		provider,
		toolsets: [toolset],
		resumeHandler,
		perCallReview: {},
		sessionLog: log,
		turnId: SCOPE.turnId,
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		agentId: 'agent_pc',
		agentName: 'PerCall',
		workingDirectory: dir,
		sessionId: SCOPE.sessionId,
		topicId: SCOPE.topicId,
		projectId: SCOPE.projectId,
		tenantId: SCOPE.tenantId,
	}
}

const firstId = (request: HITLDecisionRequest) =>
	request.type === 'tool_review' ? request.toolCalls[0]?.id : undefined

describe('a plain No to one call ends the turn', () => {
	it('answers every call, runs nothing further and does not call the model again', async () => {
		const calls: string[] = []
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ id: 'c_look', name: 'look', args: { id: 1 } },
						{ id: 'c_del', name: 'delete_row', args: { id: 2 } },
						{ id: 'c_del2', name: 'delete_row', args: { id: 3 } },
					],
				},
				{ text: 'this answer must never be asked for' },
			],
		})
		const asked: string[] = []
		const result = await drainQuery({
			...(await params(
				provider,
				tools(calls),
				new InMemorySessionLog({ sessionId: SESSION_ID }),
				async (request) => {
					asked.push(String(firstId(request)))
					return firstId(request) === 'c_del'
						? {
								action: 'reject_tools',
								feedback: 'no',
								declined: {},
								endTurn: true,
							}
						: { action: 'approve_tools' }
				},
			)),
			messages: [createUserMessage('tidy the table')],
		})

		expect(provider.requests).toHaveLength(1)
		expect(asked).toEqual(['c_look', 'c_del'])
		// The read had been approved and had run before the refusal; nothing after it did.
		expect(calls).toEqual(['look:1'])
		expect(result.status).toBe('cancelled')
		expect(result.stopReason).toBe('cancelled')
	})

	it('a No with a reason refuses only that call, and the model carries on', async () => {
		const calls: string[] = []
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ id: 'c_look', name: 'look', args: { id: 1 } },
						{ id: 'c_del', name: 'delete_row', args: { id: 2 } },
					],
				},
				{ text: 'ok, left row 2 alone' },
			],
		})
		const result = await drainQuery({
			...(await params(
				provider,
				tools(calls),
				new InMemorySessionLog({ sessionId: SESSION_ID }),
				async (request) =>
					firstId(request) === 'c_del'
						? {
								action: 'reject_tools',
								feedback: 'Leave row 2 alone.',
								declined: { note: 'Leave row 2 alone.' },
							}
						: { action: 'approve_tools' },
			)),
			messages: [createUserMessage('tidy the table')],
		})

		expect(provider.requests).toHaveLength(2)
		expect(calls).toEqual(['look:1'])
		expect(result.status).toBe('completed')
	})
})

describe('a question left open survives a restart', () => {
	/** Waits for the writes the turn makes, not for a duration. */
	async function untilParked(log: InMemorySessionLog, count: number) {
		for (;;) {
			const open = (await readParks(log)).filter((park) => park.pending.resolvedAt === undefined)
			if (open.length >= count) return open
			await settleWork()
		}
	}

	/** Two reads asked together and a delete behind them; the process dies with both reads open. */
	async function crashWithTwoReadsOpen() {
		const log = new InMemorySessionLog({ sessionId: SESSION_ID })
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ id: 'c_look1', name: 'look', args: { id: 1 } },
						{ id: 'c_look2', name: 'look', args: { id: 2 } },
						{ id: 'c_del', name: 'delete_row', args: { id: 3 } },
					],
				},
			],
		})
		const stop = new AbortController()
		const firstProcess = drainQuery({
			...(await params(
				provider,
				tools([]),
				log,
				// Both reads are asked together; the person answers neither.
				() => new Promise<HITLResumeDecision>(() => {}),
			)),
			parkRecordDelayMs: 0,
			signal: stop.signal,
			messages: [createUserMessage('tidy the table')],
		})
		const open = await untilParked(log, 2)
		expect(open.map((park) => (park.pending.request as { perCall?: true }).perCall)).toEqual([
			true,
			true,
		])
		// What a second process finds: the bytes as they are now.
		const afterCrash = await copySession(log, [SCOPE])
		stop.abort()
		await firstProcess.catch(() => undefined)
		const [first] = (await readParks(afterCrash)).filter(
			(park) => park.pending.resolvedAt === undefined,
		)
		if (!first) throw new Error('the first process left no question open')
		const id = (first.pending.request as { toolCalls: Array<{ id: string }> }).toolCalls[0]
			?.id as string
		return { afterCrash, park: first, id }
	}

	async function resume(
		afterCrash: InMemorySessionLog,
		checkpointId: string | undefined,
		decision: HITLResumeDecision,
	) {
		const calls: string[] = []
		const provider = new MockLLMProvider({ turns: [{ text: 'carried on' }] })
		const result = await drainQuery({
			...(await params(provider, tools(calls), afterCrash, async () => ({
				action: 'approve_tools',
			}))),
			messages: [],
			resumeFromCheckpoint: checkpointId as never,
			pendingDecision: decision,
		})
		const toolResults = provider.requests
			.flatMap((request) => request.messages)
			.filter((message) => message.role === 'tool')
			.map((message) => String(message.content))
		return { calls, result, toolResults }
	}

	it('applies a yes to the call it was given for and runs nothing else', async () => {
		const { afterCrash, park, id } = await crashWithTwoReadsOpen()
		const { calls, result, toolResults } = await resume(afterCrash, park.checkpointId, {
			action: 'approve_tools',
		})

		expect(result.status).toBe('completed')
		// The other read and the delete were never answered, so neither ran.
		expect(calls).toEqual([id === 'c_look1' ? 'look:1' : 'look:2'])
		expect(toolResults.filter((text) => text.includes(NOT_RUN_BEFORE_RESTART))).toHaveLength(2)
		// The other question about this batch is moot and is no longer outstanding.
		expect(await findPendingCheckpoint(afterCrash, { turnId: result.id })).toBeNull()
	})

	it('applies a No with a reason to that call only', async () => {
		const { afterCrash, park } = await crashWithTwoReadsOpen()
		const { calls, toolResults } = await resume(afterCrash, park.checkpointId, {
			action: 'reject_tools',
			feedback: 'Not that row.',
			declined: { note: 'Not that row.' },
		})

		expect(calls).toEqual([])
		expect(toolResults.some((text) => text.includes('Not that row.'))).toBe(true)
		expect(toolResults.filter((text) => text.includes(NOT_RUN_BEFORE_RESTART))).toHaveLength(2)
	})
})
