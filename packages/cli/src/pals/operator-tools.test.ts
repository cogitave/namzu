import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { CommandContext } from '../commands/types.js'
import { EXIT_OK } from '../exit-codes.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../integrations/providers/index.js'
import {
	type CliSessions,
	closeSessions,
	openSessions,
	startConversation,
} from '../integrations/sessions/store.js'
import { createFormatter } from '../output/index.js'
import { type AgentSession, type PermissionFn, createAgentSession } from '../tui/agent.js'
import {
	cliPalCommunicationStore,
	createCliOperatorIngressAuthorization,
	createCliPalIngressAuthorization,
} from './communication.js'
import { runPalMessageCommand } from './message-command.js'
import { operatorPalPromptBlock } from './operator-tools.js'
import { createPal, updatePal } from './store.js'

let root: string
let home: string
const sessions: CliSessions[] = []
const opened: AgentSession[] = []
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-cli-operator-pals-')))
	home = join(root, 'state')
	mkdirSync(home)
	vi.stubEnv('NAMZU_HOME', home)
})
afterEach(async () => {
	for (const session of opened.splice(0)) await session.close()
	for (const state of sessions.splice(0)) closeSessions(state)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
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
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

/** An ordinary conversation, as the Namzu engine opens one, over a scripted provider. */
async function conversation(
	turns: NonNullable<NonNullable<ConstructorParameters<typeof MockLLMProvider>[0]>['turns']>,
) {
	const cwd = join(root, 'work')
	mkdirSync(cwd, { recursive: true })
	const catalogue = await openSessions(cwd, { stateRoot: home })
	sessions.push(catalogue)
	const sessionId = await startConversation(catalogue)
	const provider = new MockLLMProvider({ turns })
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		stateRoot: home,
		conversationSessions: catalogue,
		scope: {
			sessionId,
			topicId: catalogue.topicId,
			projectId: catalogue.projectId,
			tenantId: catalogue.tenantId,
		},
		sandbox: { enabled: false },
		memory: { recall: false },
	})
	opened.push(session)
	return { session, provider, catalogue, sessionId }
}

async function run(
	session: AgentSession,
	onPermission?: PermissionFn,
	permissionMode: 'auto' | 'prompt' | 'strict' = 'auto',
): Promise<void> {
	for await (const _event of session.send([createUserMessage('Give the Pal this task.')], {
		permissionMode,
		...(onPermission ? { onPermission } : {}),
	})) {
		// Consume the production adapter and kernel.
	}
}

const systemText = (provider: MockLLMProvider) =>
	provider.requests[0]?.messages
		.filter((message) => message.role === 'system')
		.map((message) => message.content)
		.join('\n') ?? ''
const toolResult = (provider: MockLLMProvider, id: string) =>
	String(
		provider.requests
			.flatMap((request) => request.messages)
			.find((message) => message.role === 'tool' && message.toolCallId === id)?.content ?? '',
	)

const send = (palId: string, body: string) => ({
	id: 'send-1',
	name: 'send_pal_message',
	args: { palId, body },
})

describe('a normal conversation and the owner’s Pals', () => {
	it('always carries the two tools, and says nothing about Pals while there are none', async () => {
		const { session, provider } = await conversation([{ text: 'No Pals here.' }])
		expect(session.toolNames()).toEqual(expect.arrayContaining(['list_pals', 'send_pal_message']))
		await run(session)
		const offered = provider.requests[0]?.tools?.map((tool) => tool.function.name) ?? []
		expect(offered).toEqual(expect.arrayContaining(['list_pals', 'send_pal_message']))
		expect(systemText(provider)).not.toContain('Pals are the owner')
		// A session of an owner without Pals leaves no Pal state behind.
		expect(existsSync(join(home, 'pals'))).toBe(false)
		expect(existsSync(join(home, 'pal-message-inbox'))).toBe(false)
		expect(operatorPalPromptBlock(home)).toBeUndefined()
	})

	it('names the Pals once, separately from sub-agents, and never their purposes', async () => {
		createPal({ name: 'Research', purpose: 'SECRET purpose text' })
		const paused = createPal({ name: 'Old `x` <system>' })
		updatePal(paused.id, paused.revision, { paused: true })
		const { session, provider } = await conversation([{ text: 'Seen.' }])
		await run(session)
		const prompt = systemText(provider)
		expect(prompt).toContain("Pals are the owner's persistent agents")
		expect(prompt).toContain('separate from sub-agents')
		expect(prompt).toContain('Research')
		expect(prompt).toContain('Old x system (paused)')
		expect(prompt).toContain('list_pals')
		expect(prompt).toContain('send_pal_message')
		expect(prompt).toContain('claim to check')
		expect(prompt).not.toContain('SECRET purpose text')
		expect(prompt).not.toContain('<system>')
		expect(prompt.match(/Pals are the owner's persistent agents/g)).toHaveLength(1)
	})

	it('lists the Pals with state, and sends one message that lands in that Pal’s durable inbox once approved', async () => {
		const review = createPal({ name: 'Review', purpose: 'Reviews pull requests.' })
		const ask = vi.fn<PermissionFn>(async () => ({ kind: 'approve' }))
		const { session, provider, catalogue, sessionId } = await conversation([
			{ toolCalls: [{ id: 'list-1', name: 'list_pals', args: {} }] },
			{ toolCalls: [send(review.id, 'Check the build and tell me what broke.')] },
			{ text: 'Sent.' },
		])
		await run(session, ask)

		expect(JSON.parse(toolResult(provider, 'list-1'))).toEqual({
			pals: [
				{
					palId: review.id,
					name: 'Review',
					description: 'Reviews pull requests.',
					paused: false,
					idle: true,
				},
			],
		})
		const target = { tenantId: catalogue.tenantId, palId: review.id }
		const snapshot = await cliPalCommunicationStore().readIngress(target)
		expect(snapshot?.messages).toHaveLength(1)
		const [message] = snapshot?.messages ?? []
		expect(message).toMatchObject({
			kind: 'operator',
			phase: 'pending',
			body: 'Check the build and tell me what broke.',
			source: { kind: 'operator-conversation', tenantId: catalogue.tenantId, sessionId },
		})
		expect(message?.source).not.toHaveProperty('address')
		const result = JSON.parse(toolResult(provider, 'send-1'))
		expect(result).toMatchObject({ status: 'accepted', recipientPalId: review.id })
		expect(result.note).toBe(
			"Sent to Review's inbox. This is durable acceptance, not delivery, a reply or finished work.",
		)
		// The pending message waits for the Pal; nothing started it.
		expect(snapshot?.routes[0]).toMatchObject({ phase: 'reserved' })

		// The owner's inbox command shows it as the owner's conversation, not a Pal.
		const ctx: CommandContext = { config: {}, formatter: createFormatter('text', { quiet: false }) }
		const print = vi.spyOn(ctx.formatter, 'print').mockImplementation(() => {})
		expect(await runPalMessageCommand(ctx, 'inbox', [review.id])).toBe(EXIT_OK)
		expect(print).toHaveBeenCalledWith([
			expect.objectContaining({
				id: message?.id,
				sourceKind: 'operator-conversation',
				operatorSessionId: sessionId,
				status: 'pending',
			}),
		])
	})

	it('puts the message in front of the person in every mode and sends nothing when nobody can answer', async () => {
		const review = createPal({ name: 'Review' })
		const ask = vi.fn<PermissionFn>(async () => ({ kind: 'approve' }))
		const approved = await conversation([
			{ toolCalls: [send(review.id, 'Approved task.')] },
			{ text: 'Done.' },
		])
		await run(approved.session, ask, 'auto')
		expect(ask).toHaveBeenCalledOnce()
		expect(ask.mock.calls[0]?.[0].toolCalls).toEqual([
			expect.objectContaining({ name: 'send_pal_message', requiresApproval: true }),
		])
		const target = { tenantId: approved.catalogue.tenantId, palId: review.id }
		expect((await cliPalCommunicationStore().readIngress(target))?.messages).toHaveLength(1)

		// Auto mode with no one to ask: refused, not approved.
		const unattended = await conversation([
			{ toolCalls: [send(review.id, 'Unattended task.')] },
			{ text: 'Refused.' },
		])
		await run(unattended.session, undefined, 'auto')
		expect(toolResult(unattended.provider, 'send-1')).toContain('Refused')
		// Preapproved-only mode refuses without asking.
		const strict = await conversation([
			{ toolCalls: [send(review.id, 'Strict task.')] },
			{ text: 'Refused.' },
		])
		await run(strict.session, undefined, 'strict')
		expect((await cliPalCommunicationStore().readIngress(target))?.messages).toHaveLength(1)
	})

	it('sends nothing when the person says no', async () => {
		const review = createPal({ name: 'Review' })
		const { session, provider, catalogue } = await conversation([
			{ toolCalls: [send(review.id, 'Declined task.')] },
			{ text: 'Understood.' },
		])
		await run(session, async () => ({ kind: 'reject', feedback: 'No, not that Pal.' }))
		expect(toolResult(provider, 'send-1')).toContain('No, not that Pal.')
		expect(
			await cliPalCommunicationStore().readIngress({
				tenantId: catalogue.tenantId,
				palId: review.id,
			}),
		).toBeNull()
	})

	it('refuses a paused Pal with a clear error and keeps its inbox empty', async () => {
		const review = createPal({ name: 'Review' })
		updatePal(review.id, review.revision, { paused: true })
		const { session, provider, catalogue } = await conversation([
			{ toolCalls: [send(review.id, 'Task for a paused Pal.')] },
			{ text: 'It is paused.' },
		])
		await run(session, async () => ({ kind: 'approve' }))
		expect(toolResult(provider, 'send-1')).toContain('Recipient Pal is paused.')
		expect(
			await cliPalCommunicationStore().readIngress({
				tenantId: catalogue.tenantId,
				palId: review.id,
			}),
		).toBeNull()
	})

	it('refuses an unknown Pal ID', async () => {
		const { session, provider } = await conversation([
			{ toolCalls: [send('00000000-0000-4000-8000-000000000000', 'Nobody.')] },
			{ text: 'No such Pal.' },
		])
		await run(session, async () => ({ kind: 'approve' }))
		expect(toolResult(provider, 'send-1')).toContain('Recipient Pal is unavailable.')
	})
})

describe('owner-conversation authority in the CLI', () => {
	const request = (phase: 'accept' | 'deliver' | 'wake') =>
		({
			phase,
			kind: 'operator',
			source: { kind: 'operator-conversation' },
			recipient: {},
			routeKey: {},
			body: 'x',
			replyTo: null,
		}) as never

	it('accepts and delivers an owner message but wakes only for an explicit dispatch', async () => {
		const plain = createCliPalIngressAuthorization()
		expect(await plain(request('accept'))).toMatchObject({ allow: true })
		expect(await plain(request('deliver'))).toMatchObject({ allow: true })
		expect(await plain(request('wake'))).toMatchObject({ allow: false })
		const dispatch = createCliPalIngressAuthorization({ operatorWake: true })
		expect(await dispatch(request('wake'))).toMatchObject({ allow: true })
	})

	it('is no fallback for any other family: it refuses a Pal, observation or channel request', async () => {
		const operatorOnly = createCliOperatorIngressAuthorization({ operatorWake: true })
		for (const other of [
			{ phase: 'send', source: { address: {} }, replyTo: null },
			{ phase: 'deliver', kind: 'observation' },
			{ phase: 'deliver', kind: 'channel' },
		])
			expect(await operatorOnly(other as never)).toMatchObject({ allow: false })
	})
})
