import { describe, expect, it, vi } from 'vitest'
import { ToolExecutor } from '../../runtime/query/executor.js'
import { ActivityStore } from '../../store/activity/memory.js'
import { testToolset } from '../../test-support/toolset.js'
import { ToolManager } from '../../toolsets/manager.js'
import type { ChatCompletionResponse } from '../../types/provider/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import { generateSessionId, generateTenantId, generateTurnId } from '../../utils/id.js'
import { resolveLogger } from '../../utils/logger.js'
import {
	type PalMessagingRecipient,
	type PalMessagingToolsOptions,
	createPalMessagingTools,
} from './tools.js'
import type { PalMessageReceipt, PalMessageSender, PalMessageSenderContext } from './types.js'

const senderId = '76d3a3de-99a7-438f-b991-821009cad239'
const recipientId = '82936875-9b9d-49ef-946d-987957a2c3be'
const otherId = 'ac77ddcd-9c9a-4624-8a2c-1677b9166468'

function fixture() {
	const source: PalMessageSenderContext = {
		address: { tenantId: generateTenantId(), palId: senderId },
		conversationId: generateSessionId(),
		profileRevision: 1,
	}
	const state = {
		active: true,
		visible: [{ palId: recipientId, name: 'Review' }] as readonly PalMessagingRecipient[],
	}
	const receipt: PalMessageReceipt = {
		id: 'a'.repeat(64),
		digest: 'b'.repeat(64),
		recipient: { tenantId: source.address.tenantId, palId: recipientId },
		routeId: 'c'.repeat(64),
		sessionId: generateSessionId(),
		ordinal: 1,
		status: 'accepted',
	}
	const send = vi.fn<PalMessageSender['send']>(async () => receipt)
	const assertCurrentAdmission = vi.fn<PalMessagingToolsOptions['assertCurrentAdmission']>(() => {
		if (!state.active) throw new Error('Pal admission is no longer current.')
	})
	const listAuthorizedPals = vi.fn<PalMessagingToolsOptions['listAuthorizedPals']>(
		() => state.visible,
	)
	const options: PalMessagingToolsOptions = {
		sender: { send },
		source,
		assertCurrentAdmission,
		listAuthorizedPals,
	}
	const tools = createPalMessagingTools(options)
	const named = (name: string) => {
		const tool = tools.find((candidate) => candidate.name === name)
		if (!tool) throw new Error('Missing fixture tool.')
		return tool
	}
	const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
		sessionId: source.conversationId,
		turnId: generateTurnId(),
		toolUseId: 'executor-call-1',
		toolBatchId: 'executor-batch-1',
		workingDirectory: '/unused-host-control',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...overrides,
	})
	return {
		source,
		state,
		receipt,
		send,
		assertCurrentAdmission,
		listAuthorizedPals,
		options,
		tools,
		named,
		context,
	}
}

describe('host-bound Pal messaging tools', () => {
	it('advertises only explicit recipient, message and observed reply inputs', () => {
		const f = fixture()
		expect(f.tools.map((tool) => tool.name)).toEqual(['send_pal_message', 'list_pals'])
		const send = f.named('send_pal_message')
		expect(
			send.inputSchema.safeParse({ palId: recipientId, body: 'Review this result.' }).success,
		).toBe(true)
		expect(
			send.inputSchema.safeParse({ palId: recipientId, body: 'x', operationId: 'chosen' }).success,
		).toBe(false)
		expect(f.named('list_pals').inputSchema.safeParse({ directory: '/host' }).success).toBe(false)
		expect(send.isReadOnly?.(undefined)).toBe(false)
		expect(send.maxRetries).toBe(0)
		expect(f.named('list_pals').isReadOnly?.(undefined)).toBe(true)
	})
	it('sends only through the captured sender and tenant, with a durable acceptance result', async () => {
		const f = fixture()
		const replyTo = 'd'.repeat(64)
		const result = await f
			.named('send_pal_message')
			.execute({ palId: recipientId, body: 'Türkçe 🧪 review', replyTo }, f.context())
		expect(f.send).toHaveBeenCalledExactlyOnceWith({
			operationId: expect.stringMatching(/^[a-f0-9]{64}$/),
			recipient: { tenantId: f.source.address.tenantId, palId: recipientId },
			body: 'Türkçe 🧪 review',
			replyTo,
		})
		expect(f.assertCurrentAdmission).toHaveBeenCalledOnce()
		expect(f.listAuthorizedPals).not.toHaveBeenCalled()
		expect(result).toEqual({
			success: true,
			output: JSON.stringify({
				status: 'accepted',
				messageId: f.receipt.id,
				recipientPalId: recipientId,
			}),
			data: { status: 'accepted', messageId: f.receipt.id, recipientPalId: recipientId },
		})
		expect(result.output).not.toContain('delivered')
		expect(result.output).not.toContain(f.receipt.sessionId)
	})
	it('retains operation identity on the same executor call and distinguishes calls and batches', async () => {
		const f = fixture()
		const tool = f.named('send_pal_message')
		const input = { palId: recipientId, body: 'One message.' }
		const context = f.context()
		await tool.execute(input, context)
		await tool.execute(input, context)
		await tool.execute(input, { ...context, toolUseId: 'executor-call-2' })
		await tool.execute(input, { ...context, toolBatchId: 'executor-batch-2' })
		const ids = f.send.mock.calls.map(([request]) => request.operationId)
		expect(ids[0]).toBe(ids[1])
		expect(new Set([ids[0], ids[2], ids[3]]).size).toBe(3)
	})
	it.each([
		{ toolBatchId: undefined },
		{ toolBatchId: '' },
		{ toolUseId: undefined },
		{ toolUseId: '' },
	])('refuses a send without complete executor correlation: %j', async (missing) => {
		const f = fixture()
		const result = await f
			.named('send_pal_message')
			.execute({ palId: recipientId, body: 'A message.' }, f.context(missing))
		expect(result.success).toBe(false)
		expect(result.error).toContain('executor toolBatchId and toolUseId')
		expect(f.send).not.toHaveBeenCalled()
	})
	it('rejects model attempts to select sender, tenant, operation identity or host paths', async () => {
		const f = fixture()
		for (const spoof of [
			{ sender: otherId },
			{ tenantId: generateTenantId() },
			{ operationId: 'model-retry-uuid' },
			{ workspace: '/host/private' },
		]) {
			const result = await f
				.named('send_pal_message')
				.execute({ palId: recipientId, body: 'A message.', ...spoof }, f.context())
			expect(result.success).toBe(false)
		}
		expect(f.send).not.toHaveBeenCalled()
		expect(f.assertCurrentAdmission).not.toHaveBeenCalled()
	})
	it('refuses both operations from another conversation before host access', async () => {
		const f = fixture()
		const context = f.context({ sessionId: generateSessionId() })
		for (const [name, input] of [
			['send_pal_message', { palId: recipientId, body: 'A message.' }],
			['list_pals', {}],
		] as const) {
			const result = await f.named(name).execute(input, context)
			expect(result.success).toBe(false)
			expect(result.error).toContain('captured sender conversation')
		}
		expect(f.send).not.toHaveBeenCalled()
		expect(f.listAuthorizedPals).not.toHaveBeenCalled()
	})
	it('rechecks live admission on each operation after the factory has been retained', async () => {
		const f = fixture()
		await f.named('list_pals').execute({}, f.context())
		f.state.active = false
		for (const [name, input] of [
			['send_pal_message', { palId: recipientId, body: 'A message.' }],
			['list_pals', {}],
		] as const) {
			expect((await f.named(name).execute(input, f.context())).success).toBe(false)
		}
		expect(f.send).not.toHaveBeenCalled()
		expect(f.listAuthorizedPals).toHaveBeenCalledOnce()
	})
	it('uses the current authorized discovery callback and projects only discovery fields', async () => {
		const f = fixture()
		f.state.visible = [
			Object.assign(
				{ palId: recipientId, name: 'Review', description: 'Review explicit results.' },
				{ workspace: '/private', token: 'host-secret', grant: { allow: true } },
			),
		]
		const first = await f.named('list_pals').execute({}, f.context())
		expect(JSON.parse(first.output)).toEqual({
			pals: [{ palId: recipientId, name: 'Review', description: 'Review explicit results.' }],
		})
		expect(first.output).not.toContain('host-secret')
		f.state.visible = []
		expect(JSON.parse((await f.named('list_pals').execute({}, f.context())).output)).toEqual({
			pals: [],
		})
		expect(f.listAuthorizedPals).toHaveBeenCalledTimes(2)
	})
	it('withholds an asynchronous discovery result if admission is revoked while reading it', async () => {
		const f = fixture()
		let resolve!: (value: readonly PalMessagingRecipient[]) => void
		let started!: () => void
		const callbackStarted = new Promise<void>((done) => {
			started = done
		})
		f.listAuthorizedPals.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done
					started()
				}),
		)
		const pending = f.named('list_pals').execute({}, f.context())
		// Await the callback event itself, without a timer or machine-speed race.
		await callbackStarted
		f.state.active = false
		resolve([{ palId: recipientId, name: 'Now private' }])
		const result = await pending
		expect(result.success).toBe(false)
		expect(result.output).toBe('')
		expect(f.assertCurrentAdmission).toHaveBeenCalledTimes(2)
	})
	it('does not retry a denied or uncertain sender result', async () => {
		const f = fixture()
		f.send.mockRejectedValue(new Error('Pal send refused by current policy.'))
		const result = await f
			.named('send_pal_message')
			.execute({ palId: otherId, body: 'A message.' }, f.context())
		expect(result.success).toBe(false)
		expect(result.error).toContain('current policy')
		expect(f.send).toHaveBeenCalledOnce()
	})
	it('checks cancellation before any host operation', async () => {
		const f = fixture()
		const controller = new AbortController()
		controller.abort(new Error('Revoked tool call.'))
		for (const [name, input] of [
			['send_pal_message', { palId: recipientId, body: 'A message.' }],
			['list_pals', {}],
		] as const) {
			expect(
				(await f.named(name).execute(input, f.context({ abortSignal: controller.signal }))).success,
			).toBe(false)
		}
		expect(f.send).not.toHaveBeenCalled()
		expect(f.listAuthorizedPals).not.toHaveBeenCalled()
		expect(f.assertCurrentAdmission).not.toHaveBeenCalled()
	})
	it('captures source and callbacks instead of accepting later replacement of factory options', async () => {
		const f = fixture()
		const capturedTenant = f.source.address.tenantId
		const context = f.context()
		const replacement = vi.fn<PalMessageSender['send']>(async () => f.receipt)
		Object.assign(f.source.address, { tenantId: generateTenantId(), palId: otherId })
		Object.assign(f.source, { conversationId: generateSessionId() })
		Object.assign(f.options, { sender: { send: replacement }, listAuthorizedPals: () => [] })
		const result = await f
			.named('send_pal_message')
			.execute({ palId: recipientId, body: 'A message.' }, context)
		expect(result.success).toBe(true)
		expect(f.send.mock.calls[0]?.[0].recipient.tenantId).toBe(capturedTenant)
		expect(replacement).not.toHaveBeenCalled()
		expect(JSON.parse((await f.named('list_pals').execute({}, context)).output).pals).toHaveLength(
			1,
		)
	})
	it('requires explicit sender, current admission and discovery at construction', () => {
		const f = fixture()
		for (const name of ['sender', 'assertCurrentAdmission', 'listAuthorizedPals'] as const)
			expect(() => createPalMessagingTools({ ...f.options, [name]: undefined } as never)).toThrow(
				'require a sender, live admission and authorized discovery',
			)
	})
	it('receives both stable identities from the real query executor for concurrent sibling sends', async () => {
		const f = fixture()
		const turnId = generateTurnId()
		const tools = new ToolManager({ toolsets: [testToolset(...f.tools)], messages: () => [] })
		const executor = new ToolExecutor(
			{
				sessionId: f.source.conversationId,
				turnId,
				tools,
				workingDirectory: '/unused-host-control',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			new ActivityStore(turnId, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
			async () => {},
			resolveLogger(undefined),
		)
		const response: ChatCompletionResponse = {
			id: 'fixture-response',
			model: 'fixture',
			message: {
				role: 'assistant',
				content: null,
				toolCalls: ['first-call', 'second-call'].map((id) => ({
					id,
					type: 'function' as const,
					function: {
						name: 'send_pal_message',
						arguments: JSON.stringify({ palId: recipientId, body: id }),
					},
				})),
			},
			finishReason: 'tool_calls',
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
		}
		try {
			await executor.executeBatch(response)
			expect(f.send).toHaveBeenCalledTimes(2)
			expect(new Set(f.send.mock.calls.map(([request]) => request.operationId)).size).toBe(2)
			expect(
				f.assertCurrentAdmission.mock.calls.map(([context]) => context.toolUseId).sort(),
			).toEqual(['first-call', 'second-call'])
			expect(
				new Set(f.assertCurrentAdmission.mock.calls.map(([context]) => context.toolBatchId)).size,
			).toBe(1)
			expect(
				f.assertCurrentAdmission.mock.calls.every(
					([context]) => context.sessionId === f.source.conversationId && !!context.toolBatchId,
				),
			).toBe(true)
		} finally {
			tools.dispose()
		}
	})
})
