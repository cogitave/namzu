import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ToolContext, ToolDefinition } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery, query } from '../index.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const releases: Array<() => void> = []
const callers: AbortController[] = []
afterEach(() => {
	for (const release of releases.splice(0)) release()
	for (const caller of callers.splice(0)) caller.abort()
})

function held() {
	const value = deferred<void>()
	releases.push(value.resolve)
	return value
}

function tool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
	return defineTool({
		name,
		description: 'Controlled asynchronous read for live stream verification.',
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute,
	})
}

function fixture(tools: ToolDefinition[]) {
	const sessionId = generateSessionId()
	const caller = new AbortController()
	callers.push(caller)
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: tools.map((definition) => ({
					id: `call_${definition.name}`,
					name: definition.name,
					args: {},
				})),
			},
			{ text: 'All requested reads settled.' },
		],
	})
	return {
		caller,
		provider,
		params: {
			provider,
			toolsets: [testToolset(...tools)],
			messages: [{ role: 'user' as const, content: 'Run the controlled reads.' }],
			workingDirectory: process.cwd(),
			agentId: 'live-tool-observer',
			agentName: 'Live tool observer',
			sessionId,
			projectId: generateProjectId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			sessionLog: new InMemorySessionLog({ sessionId }),
			signal: caller.signal,
			resumeHandler: autoApproveHandler,
			turnConfig: {
				model: 'mock',
				timeoutMs: 0,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
				permissionMode: 'auto' as const,
			},
		},
	}
}

it('delivers a real tool start and progress to the query consumer before the tool returns', async () => {
	const release = held()
	const entered = deferred<ToolContext>()
	const started = deferred<void>()
	const progressed = deferred<void>()
	let toolReturned = false
	const f = fixture([
		tool('held_read', async (_input, context) => {
			entered.resolve(context)
			await release.promise
			toolReturned = true
			return { success: true, output: 'HELD_READ_RESULT' }
		}),
	])
	const events: SessionEvent[] = []
	const pending = drainQuery(f.params, (event) => {
		events.push(event)
		if (event.type === 'tool_executing') started.resolve()
		if (event.type === 'tool_progress' && event.message === 'The read is still active.')
			progressed.resolve()
	})
	try {
		await started.promise
		const context = await entered.promise
		expect(toolReturned).toBe(false)
		context.report?.('The read is still active.', 0.5)
		await progressed.promise
		expect(toolReturned).toBe(false)
		expect(events.some((event) => event.type === 'tool_completed')).toBe(false)
		expect(f.provider.requests).toHaveLength(1)
	} finally {
		release.resolve()
	}
	const result = await pending
	expect(result.status).toBe('completed')
	expect(result.messages).toContainEqual(
		expect.objectContaining({
			role: 'tool',
			toolCallId: 'call_held_read',
			content: 'HELD_READ_RESULT',
		}),
	)
	const types = events.map((event) => event.type)
	expect(types.indexOf('tool_executing')).toBeLessThan(types.indexOf('tool_progress'))
	expect(types.indexOf('tool_progress')).toBeLessThan(types.indexOf('tool_completed'))
})

it('streams one parallel completion while its sibling is held and preserves provider call order', async () => {
	const firstRelease = held()
	const secondRelease = held()
	const firstEntered = deferred<void>()
	const secondEntered = deferred<void>()
	const secondCompleted = deferred<void>()
	let firstReturned = false
	const f = fixture([
		tool('first_read', async () => {
			firstEntered.resolve()
			await firstRelease.promise
			firstReturned = true
			return { success: true, output: 'FIRST_RESULT' }
		}),
		tool('second_read', async () => {
			secondEntered.resolve()
			await secondRelease.promise
			return { success: true, output: 'SECOND_RESULT' }
		}),
	])
	const events: SessionEvent[] = []
	const pending = drainQuery(f.params, (event) => {
		events.push(event)
		if (event.type === 'tool_completed' && event.toolUseId === 'call_second_read')
			secondCompleted.resolve()
	})
	try {
		await Promise.all([firstEntered.promise, secondEntered.promise])
		secondRelease.resolve()
		await secondCompleted.promise
		expect(firstReturned).toBe(false)
		expect(f.provider.requests).toHaveLength(1)
		expect(events.filter((event) => event.type === 'tool_executing')).toHaveLength(2)
	} finally {
		secondRelease.resolve()
		firstRelease.resolve()
	}
	const result = await pending
	expect(result.status).toBe('completed')
	expect(
		events.filter((event) => event.type === 'tool_completed').map((event) => event.toolUseId),
	).toEqual(['call_second_read', 'call_first_read'])
	const request = f.provider.requests[1]?.messages ?? []
	const ownerAt = request.findIndex(
		(message) => message.role === 'assistant' && message.toolCalls?.length === 2,
	)
	expect(ownerAt).toBeGreaterThan(-1)
	expect(request[ownerAt + 1]).toMatchObject({
		role: 'tool',
		toolCallId: 'call_first_read',
		content: 'FIRST_RESULT',
	})
	expect(request[ownerAt + 2]).toMatchObject({
		role: 'tool',
		toolCallId: 'call_second_read',
		content: 'SECOND_RESULT',
	})
	const sequence = events.flatMap((event) => (event.seq === undefined ? [] : [event.seq]))
	expect(sequence).toEqual([...sequence].sort((a, b) => a - b))
	expect(new Set(sequence).size).toBe(sequence.length)
})

it('cancels a cooperative held tool after its live progress without starting another model request', async () => {
	const entered = deferred<void>()
	const progressed = deferred<void>()
	const f = fixture([
		tool('cancel_read', async (_input, context) => {
			entered.resolve()
			context.report?.('Waiting for the operator.')
			await new Promise<void>((resolve) => {
				if (context.abortSignal.aborted) resolve()
				else context.abortSignal.addEventListener('abort', () => resolve(), { once: true })
			})
			context.abortSignal.throwIfAborted()
			return { success: true, output: 'UNREACHABLE' }
		}),
	])
	const events: SessionEvent[] = []
	const pending = drainQuery(f.params, (event) => {
		events.push(event)
		if (event.type === 'tool_progress') progressed.resolve()
	})
	await Promise.all([entered.promise, progressed.promise])
	f.caller.abort(new Error('The operator canceled the read.'))
	const result = await pending
	expect(result.status).toBe('cancelled')
	expect(f.provider.requests).toHaveLength(1)
	expect(events.some((event) => event.type === 'tool_executing')).toBe(true)
	expect(JSON.stringify(result.messages)).not.toContain('UNREACHABLE')
})

it('stops and settles a cooperative tool before releasing a query whose consumer returned early', async () => {
	const entered = deferred<ToolContext>()
	const stopped = deferred<void>()
	const f = fixture([
		tool('abandoned_read', async (_input, context) => {
			entered.resolve(context)
			context.report?.('The consumer can leave now.')
			try {
				await new Promise<void>((resolve) => {
					if (context.abortSignal.aborted) resolve()
					else context.abortSignal.addEventListener('abort', () => resolve(), { once: true })
				})
				context.abortSignal.throwIfAborted()
				return { success: true, output: 'UNREACHABLE' }
			} finally {
				stopped.resolve()
			}
		}),
	])
	const stream = query(f.params)
	let event = await stream.next()
	while (!event.done && event.value.type !== 'tool_progress') event = await stream.next()
	expect(event.done).toBe(false)
	const context = await entered.promise
	await stream.return(undefined as never)
	expect(context.abortSignal.aborted).toBe(true)
	await stopped.promise
	expect(f.provider.requests).toHaveLength(1)
	const records = (await f.params.sessionLog.readAll()).entries.map((entry) => entry.record)
	const toolReceipt = records.findIndex((record) => record.type === 'tool_completed')
	const terminal = records.findIndex((record) => record.type === 'turn_completed')
	expect(toolReceipt).toBeGreaterThan(-1)
	expect(terminal).toBeGreaterThan(toolReceipt)
	expect(records.slice(terminal + 1).some((record) => record.type.startsWith('tool_'))).toBe(false)
})
