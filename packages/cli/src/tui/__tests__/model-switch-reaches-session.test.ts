import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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

it('routes the real kernel tool call to this send only, without a second permission prompt', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'switch_model', args: { model: 'gpt-5.6-luna' } }] },
			{ text: 'The model change is pending.' },
			{ toolCalls: [{ name: 'switch_model', args: { model: 'gpt-5.6-luna' } }] },
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
	try {
		for await (const event of session.send([createUserMessage('Switch to gpt-5.6-luna')], {
			onModelSwitch: switchModel,
			permissionMode: 'prompt',
			onPermission,
		}))
			first.push(event)
		for await (const event of session.send([
			createUserMessage('Another turn without selection authority'),
		]))
			second.push(event)

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
		expect(JSON.stringify(first)).toContain('pending')
		expect(session.toolNames()).toContain('switch_model')
		expect(childTools?.().listNames()).not.toContain('switch_model')
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
