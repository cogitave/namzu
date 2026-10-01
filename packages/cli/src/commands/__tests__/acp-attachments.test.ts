import { type Message, asSessionId, createUserMessage } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { fixtureUuid } from '../../../../sdk/src/test-support/ids.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

it('carries ACP image bytes into the actual CLI user message and keeps them with settled history', async () => {
	let requestMessages: readonly Message[] = []
	const sessionId = asSessionId(fixtureUuid('acp-image-owner'))
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} } },
		{
			probe: async () => ({
				preferences: { version: 3, providers: [{ id: 'fixture' }], subagents: { active: [] } },
				detected: [],
				needsRepickReason: null,
			}),
			createSession: vi.fn(async () => ({
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				close: async () => {},
				send: async function* (
					messages: readonly Message[],
					options: { onConversationMessages?: (messages: readonly Message[]) => void },
				) {
					requestMessages = messages
					options.onConversationMessages?.(messages)
					yield { kind: 'done', stopReason: 'end_turn' } as const
				},
			})),
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (ctx: unknown) => ctx,
			resolveSession: async () => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
	try {
		const image = {
			type: 'image' as const,
			mediaType: 'image/png',
			data: Buffer.from('user-owned image').toString('base64'),
		}
		const result = await runtime.gateway.prompt({
			sessionId,
			prompt: 'Inspect the attachment',
			attachments: [image],
			cwd: '/project',
			history: [],
			filesystem: undefined,
			signal: new AbortController().signal,
			onEvent: () => {},
			ask: async () => ({ kind: 'reject' }),
		})
		expect(requestMessages.at(-1)).toMatchObject({
			role: 'user',
			content: 'Inspect the attachment',
			attachments: [image],
		})
		expect(result.history).toEqual(requestMessages)
	} finally {
		await runtime.close()
	}
})

it.each([
	{
		type: 'image' as const,
		mediaType: 'image/png',
		field: 'imageAttachmentsSupported' as const,
		label: 'images',
	},
	{
		type: 'document' as const,
		mediaType: 'application/pdf',
		field: 'documentAttachmentsSupported' as const,
		label: 'documents',
	},
])(
	'refuses declared unsupported $label before send, while leaving plain text usable',
	async ({ type, mediaType, field, label }) => {
		const sessionId = asSessionId(fixtureUuid(`acp-unsupported-${type}`))
		const send = vi.fn(async function* () {
			yield { kind: 'done', stopReason: 'end_turn' } as const
		})

		const runtime = createCliAcpRuntime(
			{ config: {}, formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} } },
			{
				probe: async () => ({
					preferences: { version: 3, providers: [{ id: 'fixture' }], subagents: { active: [] } },
					detected: [],
					needsRepickReason: null,
				}),
				createSession: async () => ({
					hasProvider: true,
					errorHint: null,
					mcpFailed: [],
					close: async () => {},
					[field]: false,
					send,
				}),
				decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
				resolveProjectContext: (ctx: unknown) => ctx,
				resolveSession: async () => ({ sessionId }),
			} as unknown as AcpRuntimeDependencies,
		)
		const prompt = (attachments?: Parameters<typeof runtime.gateway.prompt>[0]['attachments']) =>
			runtime.gateway.prompt({
				sessionId,
				prompt: 'Inspect',
				...(attachments ? { attachments } : {}),
				cwd: '/project',
				history: [],
				filesystem: undefined,
				signal: new AbortController().signal,
				onEvent: () => {},
				ask: async () => ({ kind: 'reject' }),
			})
		try {
			await expect(
				prompt([{ type, mediaType, data: Buffer.from('owned bytes').toString('base64') }]),
			).rejects.toThrow(`cannot receive ${label}`)
			expect(send).not.toHaveBeenCalled()
			await expect(prompt()).resolves.toMatchObject({ stopReason: 'end_turn' })
			expect(send).toHaveBeenCalledOnce()
		} finally {
			await runtime.close()
		}
	},
)

it('surfaces yielded pre-turn failures without replacing history, and preserves history from failed actual turns', async () => {
	const sessionId = asSessionId(fixtureUuid('acp-pre-turn-failure'))
	const prior = [createUserMessage('Earlier settled message')]
	let settleHistory = false
	let captured: readonly Message[] = []
	const runtime = createCliAcpRuntime(
		{
			config: {},
			formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
		},
		{
			probe: async () => ({
				preferences: { version: 3, providers: [{ id: 'fixture' }], subagents: { active: [] } },
				detected: [],
				needsRepickReason: null,
			}),
			createSession: async () => ({
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				close: async () => {},
				send: async function* (
					messages: readonly Message[],
					options: { onConversationMessages?: (messages: readonly Message[]) => void },
				) {
					captured = messages
					if (settleHistory) options.onConversationMessages?.(messages)
					yield {
						kind: 'error',
						message: 'The retained history contains a duplicate tool call ID.',
					} as const
				},
			}),
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (ctx: unknown) => ctx,
			resolveSession: async () => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
	const prompt = () =>
		runtime.gateway.prompt({
			sessionId,
			prompt: 'Try the next turn',
			cwd: '/project',
			history: prior,
			filesystem: undefined,
			signal: new AbortController().signal,
			onEvent: () => {},
			ask: async () => ({ kind: 'reject' }),
		})
	try {
		await expect(prompt()).rejects.toThrow('retained history contains a duplicate tool call ID')
		expect(prior).toHaveLength(1)
		expect(captured[0]).toEqual(prior[0])
		settleHistory = true
		const result = await prompt()
		expect(result.stopReason).toBe('error')
		expect(result.history).toEqual(captured)
		expect(result.history).toHaveLength(2)
	} finally {
		await runtime.close()
	}
})
