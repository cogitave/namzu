import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { ACPServer } from '../../../bridge/acp/server.js'
import { toAcpSessionUpdate } from '../../../bridge/acp/update.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { HostCommandRegistry } from '../../../registry/command/index.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { foldSessionMessages } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { AcpSessionUpdate } from '../../../types/acp/index.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/events.js'
import type { SessionRecord } from '../../../types/session/records.js'
import { drainQuery } from '../index.js'
import { memorySession, records } from './support/session.js'

const workdirs: string[] = []
afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})
const presenter = createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] }))
const echo = defineTool({
	name: 'echo',
	description: 'Echoes a fixture value',
	inputSchema: z.object({}),
	category: 'custom',
	permissions: [],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,
	execute: async () => ({ success: true, output: 'Fixture checked' }),
})

async function run(turns: readonly MockTurn[], tokenBudget = 100_000) {
	const session = memorySession()
	const events: SessionEvent[] = []
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-message-identity-'))
	workdirs.push(workingDirectory)
	const turn = await drainQuery(
		{
			...session,
			workingDirectory,
			provider: new MockLLMProvider({ turns: [...turns] }),
			toolsets: [testToolset(echo)],
			agentId: 'identity-test',
			agentName: 'Identity test',
			messages: [createUserMessage('Check the fixture')],
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'allow_by_name', toolNames: ['echo'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 0,
				tokenBudget,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
		},
		(event) => {
			events.push(event)
		},
	)
	return { turn, events, log: await records(session.sessionLog) }
}

it('preserves one answer identity from first streamed text through durable settlement and ACP', async () => {
	const { events, log, turn } = await run([{ text: 'First answer' }])
	const started = events.find((event) => event.type === 'message_started')
	const complete = events.find((event) => event.type === 'message_completed')
	const end = events.find((event) => event.type === 'turn_completed')
	const durable = log.find((record) => record.type === 'message' && record.role === 'assistant')
	if (
		started?.type !== 'message_started' ||
		complete?.type !== 'message_completed' ||
		end?.type !== 'turn_completed' ||
		durable?.type !== 'message'
	)
		throw new Error('Missing actual message lifecycle')
	const streamed = events.filter((event) => event.type === 'text_delta')
	expect(streamed.length).toBeGreaterThan(0)
	expect(new Set(streamed.map((event) => event.messageId))).toEqual(new Set([started.messageId]))
	expect(complete.messageId).toBe(started.messageId)
	expect(durable.messageId).toBe(started.messageId)
	expect(end.settlement?.resultMessageId).toBe(started.messageId)
	expect(turn.messages.find((message) => message.role === 'assistant')?.id).toBe(started.messageId)
	expect(toAcpSessionUpdate(complete, presenter)).toMatchObject({
		kind: 'agent_message',
		messageId: started.messageId,
	})
	expect(toAcpSessionUpdate(end, presenter)).toMatchObject({
		kind: 'turn_ended',
		messageId: started.messageId,
		result: 'First answer',
	})
})

it('retains distinct same-text tool commentary and final messages with their own persisted identities', async () => {
	const text = 'Repeated public text'
	const { events, log } = await run([
		{ text, toolCalls: [{ id: 'echo-call', name: 'echo', args: {} }] },
		{ text },
	])
	const completed = events.filter((event) => event.type === 'message_completed')
	const durable = log.filter(
		(record): record is Extract<SessionRecord, { type: 'message' }> =>
			record.type === 'message' && record.role === 'assistant',
	)
	expect(completed).toHaveLength(2)
	expect(completed.map((event) => event.stopReason)).toEqual(['tool_use', 'end_turn'])
	expect(new Set(completed.map((event) => event.messageId)).size).toBe(2)
	expect(durable.map((record) => record.messageId)).toEqual(
		completed.map((event) => event.messageId),
	)
	expect(
		(await foldSessionMessages(log))
			.filter((message) => message.role === 'assistant')
			.map((message) => message.content),
	).toEqual([text, text])
	expect(events.some((event) => event.type === 'tool_completed')).toBe(true)
	const updates = completed.map((event) => toAcpSessionUpdate(event, presenter))
	expect(
		updates.map((update) => (update && 'messageId' in update ? update.messageId : undefined)),
	).toEqual(completed.map((event) => event.messageId))
})

it('keeps the forced closing summary identity equal to its durable answer', async () => {
	const { events, log, turn } = await run(
		[
			{
				toolCalls: [{ name: 'echo', args: {} }],
				usage: { promptTokens: 1_000, completionTokens: 1_000, totalTokens: 2_000 },
			},
			{
				text: 'Closing summary',
				usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
			},
		],
		2_200,
	)
	const closing = events.find(
		(event) => event.type === 'message_completed' && event.stopReason === 'forced_finalize',
	)
	const terminal = events.find((event) => event.type === 'turn_completed')
	const durable = log
		.filter((record) => record.type === 'message' && record.role === 'assistant')
		.at(-1)
	if (
		closing?.type !== 'message_completed' ||
		terminal?.type !== 'turn_completed' ||
		durable?.type !== 'message'
	)
		throw new Error('Missing actual closing summary')
	expect(turn.result).toBe('Closing summary')
	expect(durable.messageId).toBe(closing.messageId)
	expect(terminal.settlement?.resultMessageId).toBe(closing.messageId)
})

it('delivers the same real query answer identity through an initialized ACP prompt', async () => {
	const session = memorySession()
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-acp-identity-'))
	workdirs.push(workingDirectory)
	const sent: MCPJsonRpcMessage[] = []
	const waiting = new Map<number, (message: MCPJsonRpcMessage) => void>()
	let receive: ((message: MCPJsonRpcMessage) => void) | undefined
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		onMessage: (handler) => {
			receive = handler
		},
		onClose: () => {},
		onError: () => {},
		send: async (message) => {
			sent.push(message)
			if (typeof message.id === 'number' && !message.method) waiting.get(message.id)?.(message)
		},
	}
	const server = new ACPServer({
		transport,
		commands: new HostCommandRegistry(),
		presenter,
		agentInfo: { name: 'identity-test', version: '0.0.0-test' },
		newSessionId: () => session.sessionId,
		gateway: {
			prompt: async ({ prompt, onEvent, signal }) => {
				const turn = await drainQuery(
					{
						...session,
						workingDirectory,
						signal,
						provider: new MockLLMProvider({ turns: [{ text: 'One visible answer' }] }),
						toolsets: [],
						agentId: 'identity-test',
						agentName: 'Identity test',
						messages: [createUserMessage(prompt)],
						turnConfig: { model: 'mock', timeoutMs: 0, tokenBudget: 0, maxIterations: 1 },
					},
					onEvent,
				)
				return { stopReason: turn.stopReason, history: turn.messages }
			},
		},
	})
	const request = (id: number, method: string, params: Record<string, unknown>) =>
		new Promise<MCPJsonRpcMessage>((resolve) => {
			waiting.set(id, resolve)
			receive?.({ jsonrpc: '2.0', id, method, params })
		})
	await server.start()
	try {
		expect((await request(1, 'initialize', { capabilities: ['permission'] })).error).toBeUndefined()
		expect((await request(2, 'session/new', { cwd: workingDirectory })).error).toBeUndefined()
		expect(
			(await request(3, 'session/prompt', { sessionId: session.sessionId, prompt: 'Answer once' }))
				.result,
		).toMatchObject({ stopReason: 'end_turn' })
		const updates = sent
			.filter((message) => message.method === 'session/update')
			.map((message) => message.params?.update as AcpSessionUpdate)
		const complete = updates.find((update) => update.kind === 'agent_message')
		const terminal = updates.find((update) => update.kind === 'turn_ended')
		expect(complete?.kind).toBe('agent_message')
		expect(terminal?.kind).toBe('turn_ended')
		if (complete?.kind !== 'agent_message' || terminal?.kind !== 'turn_ended')
			throw new Error('Missing delivered ACP settlement')
		expect(terminal.messageId).toBe(complete.messageId)
		expect(terminal.result).toBe('One visible answer')
		expect(updates.filter((update) => update.kind === 'agent_message')).toHaveLength(1)
		const durable = (await records(session.sessionLog)).find(
			(record) => record.type === 'message' && record.role === 'assistant',
		)
		expect(durable?.type === 'message' ? durable.messageId : undefined).toBe(complete.messageId)
	} finally {
		await server.stop()
	}
})
