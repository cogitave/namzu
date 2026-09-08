import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Message,
	MockLLMProvider,
	ProviderRegistry,
	type ToolRegistryContract,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import type { AgentEvent, SendOptions } from '../agent.js'

let childTools: (() => ToolRegistryContract) | undefined
vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async (options: { buildTools: () => ToolRegistryContract }) => {
		childTools = options.buildTools
		throw new Error('This fixture isolates the main conversation tools')
	},
}))

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	childTools = undefined
	for (const root of roots.splice(0)) removeTempDir(root)
})

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY.anthropic,
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'fixture-key',
		alternatives: [],
	},
]

it('settles an accepted switch without another inference and preserves its receipt for the next send', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{ id: 'switch-accepted', name: 'switch_model', args: { model: 'gpt-5.6-luna' } },
				],
			},
			// The provider would repeat the accepted request if the kernel asked again.
			{
				toolCalls: [
					{ id: 'switch-without-owner', name: 'switch_model', args: { model: 'gpt-5.6-luna' } },
				],
			},
			{ text: 'No active selection handler.' },
		],
	})
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-model-switch-session-'))
	roots.push(cwd)
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detected, { cwd, allowModelSwitch: true })
	const switchModel = vi.fn<NonNullable<SendOptions['onModelSwitch']>>(async () => ({
		kind: 'pending',
		selection: { id: 'codex', model: 'gpt-5.6-luna' },
	}))
	const onPermission = vi.fn(async () => ({ kind: 'reject' as const }))
	const first: AgentEvent[] = []
	const second: AgentEvent[] = []
	let conversation: readonly Message[] | undefined
	try {
		for await (const event of session.send([createUserMessage('Switch to gpt-5.6-luna')], {
			onModelSwitch: switchModel,
			permissionMode: 'prompt',
			onPermission,
			onConversationMessages: (messages) => {
				conversation = messages
			},
		}))
			first.push(event)

		expect(provider.requests).toHaveLength(1)
		expect(provider.requests[0]?.tools?.map((tool) => tool.function.name)).not.toContain(
			'search_tools',
		)
		expect(switchModel).toHaveBeenCalledTimes(1)
		expect(first.filter((event) => event.kind === 'done')).toEqual([
			expect.objectContaining({ stopReason: 'end_turn', text: expect.stringMatching(/pending/i) }),
		])
		expect(conversation).toContainEqual(
			expect.objectContaining({
				role: 'assistant',
				toolCalls: [
					expect.objectContaining({
						id: 'switch-accepted',
						function: { name: 'switch_model', arguments: '{"model":"gpt-5.6-luna"}' },
					}),
				],
			}),
		)
		expect(conversation).toContainEqual(
			expect.objectContaining({
				role: 'tool',
				toolCallId: 'switch-accepted',
				content: expect.stringMatching(/pending/i),
			}),
		)
		if (!conversation) throw new Error('The settled conversation was not published.')
		for await (const event of session.send([
			...conversation,
			createUserMessage('Another turn without selection authority'),
		]))
			second.push(event)

		expect(provider.requests).toHaveLength(3)
		expect(provider.requests[1]?.messages).toContainEqual(
			expect.objectContaining({
				role: 'tool',
				toolCallId: 'switch-accepted',
				content: expect.stringMatching(/pending/i),
			}),
		)
		expect(switchModel).toHaveBeenCalledTimes(1)
		expect(switchModel.mock.calls[0]?.[0]).toEqual({ model: 'gpt-5.6-luna' })
		expect(onPermission).not.toHaveBeenCalled()
		expect(first).toContainEqual(
			expect.objectContaining({
				kind: 'tool-end',
				toolName: 'switch_model',
				isError: false,
			}),
		)
		expect(second).toContainEqual(
			expect.objectContaining({
				kind: 'tool-end',
				toolName: 'switch_model',
				isError: true,
			}),
		)
		expect(JSON.stringify(first)).toMatch(/pending/i)
		expect(second).toContainEqual(
			expect.objectContaining({
				kind: 'done',
				stopReason: 'end_turn',
				text: 'No active selection handler.',
			}),
		)
		expect(session.toolNames()).toContain('switch_model')
		expect(childTools?.().listNames()).not.toContain('switch_model')
	} finally {
		await session.close()
	}
})

it('returns a rejected selection to the model so a corrected request can settle successfully', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{ id: 'switch-rejected', name: 'switch_model', args: { model: 'unknown-model' } },
				],
			},
			{
				toolCalls: [
					{ id: 'switch-corrected', name: 'switch_model', args: { model: 'gpt-5.6-luna' } },
				],
			},
			{ text: 'An accepted switch should not need this inference.' },
		],
	})
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-model-switch-recovery-'))
	roots.push(cwd)
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detected, { cwd, allowModelSwitch: true })
	const switchModel = vi.fn<NonNullable<SendOptions['onModelSwitch']>>(async (request) =>
		request.model === 'unknown-model'
			? { kind: 'rejected', reason: 'Unknown model. Use gpt-5.6-luna.' }
			: { kind: 'pending', selection: { id: 'codex', model: 'gpt-5.6-luna' } },
	)
	const events: AgentEvent[] = []
	let conversation: readonly Message[] | undefined
	try {
		for await (const event of session.send([createUserMessage('Switch to gpt-5.6-luna')], {
			onModelSwitch: switchModel,
			onConversationMessages: (messages) => {
				conversation = messages
			},
		}))
			events.push(event)

		expect(provider.requests).toHaveLength(2)
		expect(switchModel.mock.calls.map(([request]) => request.model)).toEqual([
			'unknown-model',
			'gpt-5.6-luna',
		])
		expect(provider.requests[1]?.messages).toContainEqual(
			expect.objectContaining({
				role: 'tool',
				toolCallId: 'switch-rejected',
				isError: true,
				content: expect.stringContaining('Unknown model. Use gpt-5.6-luna.'),
			}),
		)
		expect(events.filter((event) => event.kind === 'tool-end')).toEqual([
			expect.objectContaining({ toolName: 'switch_model', isError: true }),
			expect.objectContaining({ toolName: 'switch_model', isError: false }),
		])
		expect(events.filter((event) => event.kind === 'done')).toEqual([
			expect.objectContaining({ stopReason: 'end_turn', text: expect.stringMatching(/pending/i) }),
		])
		expect(conversation?.filter((message) => message.role === 'tool')).toEqual([
			expect.objectContaining({ toolCallId: 'switch-rejected', isError: true }),
			expect.objectContaining({
				toolCallId: 'switch-corrected',
				content: expect.stringMatching(/pending/i),
			}),
		])
	} finally {
		await session.close()
	}
})

it('does not advertise model switching to a headless session', async () => {
	const provider = new MockLLMProvider({ turns: [{ text: 'Hello.' }] })
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-model-switch-headless-'))
	roots.push(cwd)
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detected, { cwd })
	try {
		for await (const _event of session.send([createUserMessage('Hello')])) {
		}
		expect(session.toolNames()).not.toContain('switch_model')
		expect(provider.requests[0]?.tools?.map((tool) => tool.function.name)).not.toContain(
			'switch_model',
		)
	} finally {
		await session.close()
	}
})
