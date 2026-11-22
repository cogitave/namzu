/**
 * The person asks for one of their Namzu commands in words, and the model runs
 * it through the `command` tool. Everything below goes through the real agent
 * session, with a fake provider; the terminal side is a small double over the
 * real slash dispatch and the real goal store.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	HostCommandRegistry,
	InMemorySessionGoalStore,
	InMemorySessionStore,
	MockLLMProvider,
	ProviderRegistry,
	SessionGoalActivation,
	type Toolset,
	createUserMessage,
	generateTenantId,
	generateTopicId,
	kernelHostCommands,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { permissionQuestion } from '../PermissionOverlay.js'
import type { AgentEvent, PermissionRequest, SendOptions } from '../agent.js'
import { builtinCommandCatalogue } from '../command-catalogue.js'
import type { CommandRunOutcome, CommandToolHost } from '../command-tool.js'
import {
	CLI_LOCAL_COMMANDS,
	type SlashContext,
	kernelCommandDescriptors,
	mergeHostCommands,
	renderOutcome,
	runSlash,
} from '../slashCommands.js'

let childTools: (() => readonly Toolset[]) | undefined
vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async (options: { buildTools: () => readonly Toolset[] }) => {
		childTools = options.buildTools
		throw new Error('This fixture isolates the main conversation tools')
	},
}))

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
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
		entry: PROVIDER_REGISTRY[preferences.providers[0]?.id as keyof typeof PROVIDER_REGISTRY],
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'fixture-key',
		alternatives: [],
	},
]

const hostCommands = mergeHostCommands(kernelCommandDescriptors(), CLI_LOCAL_COMMANDS)

/** The terminal's side: the real dispatch, the real goal store, a model that offers (or lacks) fast. */
async function terminal(options: { fast: boolean }) {
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject({ tenantId, name: 'chat commands' }, tenantId)
	const session = await sessions.createSession(
		{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
		tenantId,
	)
	const goals = new InMemorySessionGoalStore({ sessions })
	const activation = new SessionGoalActivation()
	const slashCtx = {
		cwd: '/workspace',
		speedTiers: () => (options.fast ? ['fast'] : []),
		speedTierRefusal: (tier: string) =>
			options.fast ? undefined : `${tier} is not offered by this model.`,
	} as unknown as SlashContext
	const shown: string[] = []
	const queued: string[] = []
	const host: CommandToolHost = {
		catalogue: builtinCommandCatalogue(),
		unavailable: (name) => hostCommands.find((c) => c.name === name)?.unavailable?.(slashCtx),
		async run(line, runOptions): Promise<CommandRunOutcome> {
			if (runOptions.deferred) {
				queued.push(line)
				return { kind: 'queued' }
			}
			const action = runSlash(line, slashCtx, hostCommands)
			if (action?.kind === 'host-command') {
				const registry = new HostCommandRegistry()
				registry.register(
					kernelHostCommands({
						goal: { store: goals, sessionId: session.id, tenantId, activation },
					}),
				)
				const outcome = await registry.dispatch(`/${action.name} ${action.args.join(' ')}`.trim())
				const text = outcome ? renderOutcome(outcome) : ''
				shown.push(text)
				return { kind: 'ran', output: text }
			}
			if (action?.kind === 'message') {
				shown.push(action.content)
				return { kind: 'ran', output: action.content }
			}
			shown.push(`(${action?.kind ?? 'nothing'})`)
			return { kind: 'ran' }
		},
	}
	return {
		host,
		shown,
		queued,
		currentGoal: () => goals.getGoal(session.id, tenantId),
	}
}

async function mount(provider: MockLLMProvider, extra: Record<string, unknown>) {
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	vi.stubEnv('NAMZU_DISABLE_BACKGROUND_TASKS', '1')
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-chat-commands-'))
	roots.push(cwd)
	const { createAgentSession } = await import('../agent.js')
	return createAgentSession(preferences, detected, { toolLoading: 'eager', cwd, ...extra })
}

async function send(
	session: Awaited<ReturnType<typeof mount>>,
	text: string,
	options: SendOptions,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = []
	for await (const event of session.send([createUserMessage(text)], options)) events.push(event)
	return events
}

const toolEnds = (events: AgentEvent[]) =>
	events.filter(
		(event): event is Extract<AgentEvent, { kind: 'tool-end' }> => event.kind === 'tool-end',
	)

it('sets a goal from "set a goal: write the changelog" once the person approves the exact line', async () => {
	const t = await terminal({ fast: true })
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{
						id: 'goal-call',
						name: 'command',
						args: { name: 'goal', args: ['write', 'the', 'changelog'] },
					},
				],
			},
			{ text: 'The goal is set.' },
		],
	})
	const session = await mount(provider, { commandHost: t.host })
	const onPermission = vi.fn(async (_request: PermissionRequest) => ({ kind: 'approve' as const }))
	try {
		const events = await send(session, 'set a goal: write the changelog', {
			permissionMode: 'prompt',
			onPermission,
		})
		expect(onPermission).toHaveBeenCalledTimes(1)
		const asked = onPermission.mock.calls[0]?.[0]
		expect(asked?.toolCalls[0]).toMatchObject({ name: 'command', requiresApproval: true })
		expect(permissionQuestion(asked?.toolCalls ?? [])).toBe(
			'Do you want to run /goal write the changelog?',
		)
		expect(toolEnds(events)[0]).toMatchObject({ toolName: 'command', isError: false })
		const goal = await t.currentGoal()
		expect(goal).toMatchObject({ objective: 'write the changelog', phase: 'active' })
		expect(t.shown[0]).toContain('Goal created')
		const names = provider.requests[0]?.tools?.map((tool) => tool.function.name) ?? []
		expect(names).toContain('command')
		expect(provider.requests[1]?.messages).toContainEqual(
			expect.objectContaining({
				role: 'tool',
				content: expect.stringContaining('Ran /goal write the changelog'),
			}),
		)
	} finally {
		await session.close()
	}
})

it('does nothing when the person says no', async () => {
	const t = await terminal({ fast: true })
	const run = vi.spyOn(t.host, 'run')
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ id: 'g', name: 'command', args: { name: 'goal', args: ['x'] } }],
			},
			{ text: 'Understood, no goal.' },
		],
	})
	const session = await mount(provider, { commandHost: t.host })
	const onPermission = vi.fn(async () => ({ kind: 'reject' as const }))
	try {
		const events = await send(session, 'set a goal: x', { permissionMode: 'prompt', onPermission })
		expect(onPermission).toHaveBeenCalledTimes(1)
		expect(run).not.toHaveBeenCalled()
		expect(await t.currentGoal()).toBeNull()
		expect(toolEnds(events)[0]).toMatchObject({ toolName: 'command', isError: true })
	} finally {
		await session.close()
	}
})

it('refuses a never command without a prompt, naming it, and runs nothing', async () => {
	const t = await terminal({ fast: true })
	const run = vi.spyOn(t.host, 'run')
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'l', name: 'command', args: { name: 'login', args: ['codex'] } }] },
			{ text: 'Please type /login codex yourself.' },
		],
	})
	const session = await mount(provider, { commandHost: t.host })
	const onPermission = vi.fn(async () => ({ kind: 'approve' as const }))
	try {
		const events = await send(session, 'sign me in', { permissionMode: 'prompt', onPermission })
		expect(onPermission).not.toHaveBeenCalled()
		expect(run).not.toHaveBeenCalled()
		expect(toolEnds(events)[0]).toMatchObject({ isError: true })
		expect(JSON.stringify(provider.requests[1]?.messages)).toContain('/login codex')
	} finally {
		await session.close()
	}
})

it('runs a read command at once with no prompt', async () => {
	const t = await terminal({ fast: true })
	const run = vi.spyOn(t.host, 'run')
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 's', name: 'command', args: { name: 'goal', args: ['status'] } }] },
			{ text: 'No goal yet.' },
		],
	})
	const session = await mount(provider, { commandHost: t.host })
	const onPermission = vi.fn(async () => ({ kind: 'reject' as const }))
	try {
		const events = await send(session, 'what is my goal?', {
			permissionMode: 'prompt',
			onPermission,
		})
		expect(onPermission).not.toHaveBeenCalled()
		expect(run).toHaveBeenCalledExactlyOnceWith('/goal status', expect.anything())
		expect(toolEnds(events)[0]).toMatchObject({ isError: false })
	} finally {
		await session.close()
	}
})

it('says "turn on fast mode" was refused, with the verdict reason, on a model without fast', async () => {
	const t = await terminal({ fast: false })
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'f', name: 'command', args: { name: 'fast' } }] },
			{ text: 'This model has no fast mode.' },
		],
	})
	const session = await mount(provider, { commandHost: t.host })
	const onPermission = vi.fn(async () => ({ kind: 'approve' as const }))
	try {
		const events = await send(session, 'turn on fast mode', {
			permissionMode: 'prompt',
			onPermission,
		})
		// Nothing to approve: the command cannot run here, so the person is not asked.
		expect(onPermission).not.toHaveBeenCalled()
		expect(toolEnds(events)[0]).toMatchObject({ toolName: 'command', isError: true })
		expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
			'fast is not offered by this model.',
		)
		expect(t.shown).toEqual([])
	} finally {
		await session.close()
	}
})

it('asks, then queues, a command that replaces the conversation', async () => {
	const t = await terminal({ fast: true })
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c', name: 'command', args: { name: 'clear' } }] },
			{ text: 'It will clear when I am done.' },
		],
	})
	const session = await mount(provider, { commandHost: t.host })
	const onPermission = vi.fn(async () => ({ kind: 'approve' as const }))
	try {
		const events = await send(session, 'clear the chat', { permissionMode: 'prompt', onPermission })
		expect(onPermission).toHaveBeenCalledTimes(1)
		expect(t.queued).toEqual(['/clear'])
		expect(toolEnds(events)[0]).toMatchObject({ isError: false })
		expect(JSON.stringify(provider.requests[1]?.messages)).toMatch(/when this turn ends/)
	} finally {
		await session.close()
	}
})

it('mounts the tool only where a terminal supplies it, never for a child or a headless session', async () => {
	const t = await terminal({ fast: true })
	const withHost = await mount(new MockLLMProvider({ turns: [{ text: 'hi' }] }), {
		commandHost: t.host,
	})
	try {
		expect(withHost.toolNames()).toContain('command')
		expect(
			childTools?.()
				.flatMap((toolset) => toolset.tools())
				.map((tool) => tool.name),
		).not.toContain('command')
	} finally {
		await withHost.close()
	}
	const headless = await mount(new MockLLMProvider({ turns: [{ text: 'hi' }] }), {})
	try {
		expect(headless.toolNames()).not.toContain('command')
	} finally {
		await headless.close()
	}
})

it('makes switch_model ask the person first, and change nothing on no', async () => {
	for (const answer of ['approve', 'reject'] as const) {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'm', name: 'switch_model', args: { model: 'gpt-5.6-luna' } }] },
				{ text: 'done' },
			],
		})
		const session = await mount(provider, { allowModelSwitch: true })
		const switchModel = vi.fn<NonNullable<SendOptions['onModelSwitch']>>(async () => ({
			kind: 'pending',
			selection: { id: 'codex', model: 'gpt-5.6-luna' },
		}))
		const onPermission = vi.fn(async () => ({ kind: answer }))
		try {
			await send(session, 'switch to gpt-5.6-luna', {
				permissionMode: 'prompt',
				onPermission,
				onModelSwitch: switchModel,
			})
			expect(onPermission).toHaveBeenCalledTimes(1)
			const asked: PermissionRequest | undefined = (
				onPermission.mock.calls as unknown as [PermissionRequest][]
			)[0]?.[0]
			expect(asked?.toolCalls[0]).toMatchObject({ name: 'switch_model', requiresApproval: true })
			expect(permissionQuestion(asked?.toolCalls ?? [])).toBe(
				'Do you want to switch this conversation to gpt-5.6-luna?',
			)
			expect(switchModel).toHaveBeenCalledTimes(answer === 'approve' ? 1 : 0)
		} finally {
			await session.close()
		}
	}
})
