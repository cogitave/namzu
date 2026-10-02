import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionLog,
	MockLLMProvider,
	type PalChannelIngressOptions,
	type PalEnvironmentLease,
	type PalIngressIntentDraft,
	PalRuntime,
	ProviderRegistry,
	type Sandbox,
	type SandboxId,
	type ToolContext,
	generateSessionId,
	generateTurnId,
	ingressIntentDigest,
	ingressIntentId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { CommandContext } from '../commands/types.js'
import { PROVIDER_REGISTRY } from '../integrations/providers/index.js'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import { createFormatter } from '../output/index.js'
import {
	cliPalActivitySubscriptionPolicy,
	cliPalActivitySubscriptionStore,
	cliPalCommunicationPolicy,
	cliPalCommunicationStore,
	createCliPalMessagingContext,
} from './communication.js'
import { claimPalConversation } from './conversations.js'
import { dispatchCliPalMessages } from './dispatch.js'
import { createPal, getCliPalStore, updatePal } from './store.js'

const controls = vi.hoisted(() => ({ probe: vi.fn(), runtime: vi.fn(), close: vi.fn() }))
vi.mock('../tui/agent.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../tui/agent.js')>()),
	probeAgentSession: controls.probe,
}))
vi.mock('./environment.js', () => ({
	getCliPalRuntime: controls.runtime,
	closeCliPalRuntime: controls.close,
}))

let root: string
const runtimes: PalRuntime[] = []
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-pal-dispatch-')))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	controls.runtime.mockReset()
	controls.close.mockReset().mockResolvedValue(undefined)
	controls.probe.mockReset().mockResolvedValue({
		preferences: null,
		detected: [
			{
				entry: PROVIDER_REGISTRY['openai'],
				apiKey: 'fixture-private-provider-key',
				source: { kind: 'env', envName: 'OPENAI_API_KEY' },
				alternatives: [],
			},
		],
		credentialGap: null,
		needsRepickReason: null,
	})
})
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function environment(palId: string): PalEnvironmentLease {
	const sandbox: Sandbox = {
		id: generateSessionId() as unknown as SandboxId,
		status: 'ready',
		rootDir: '/home/namzu/workspace',
		environment: 'linux-namespace',
		readFile: vi.fn(async () => Buffer.from('isolated guest result')),
		writeFile: vi.fn(async () => {}),
		listFiles: vi.fn(async () => []),
		exec: vi.fn(async () => ({
			exitCode: 0,
			stdout: '',
			stderr: '',
			timedOut: false,
			durationMs: 0,
		})),
		destroy: vi.fn(async () => {}),
	}
	return {
		palId,
		environmentId: 'fixture-isolated-guest',
		generation: 1,
		sandbox,
		computerUseHost: {
			id: 'fixture-guest-display',
			getDisplayGeometry: async () => ({ width: 1280, height: 800, scaleFactor: 1 }),
			capabilities: {
				displayServer: 'x11',
				screenshot: true,
				mouse: true,
				keyboard: true,
				cursorPosition: false,
				clipboard: false,
			},
			execute: vi.fn(async () => {
				throw new Error('Unused guest display operation')
			}),
		},
		release: vi.fn(async () => {}),
	}
}

async function fixture(
	provider = new MockLLMProvider({ responseText: 'Reviewed incoming finding.' }),
	allowWake = true,
	sendInitial = true,
) {
	const sender = createPal({ name: 'Research' })
	const recipient = createPal({
		name: 'Review',
		purpose: 'Review the accepted original evidence.',
		model: { provider: 'openai', model: 'pinned-review-model' },
	})
	const sessionId = generateSessionId()
	await claimPalConversation(sender.workspace, sender.id, sessionId)
	const state = await openSessions(sender.workspace)
	const tenantId = state.tenantId
	closeSessions(state)
	const source = { tenantId, palId: sender.id }
	const target = { tenantId, palId: recipient.id }
	const policy = cliPalCommunicationPolicy()
	await policy.update({ source, recipient: target, expectedRevision: 0, enabled: true, allowWake })
	const execution: ToolContext = {
		sessionId,
		turnId: generateTurnId(),
		toolBatchId: 'actual-sender-batch',
		toolUseId: 'actual-sender-call',
		workingDirectory: '/unused',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
	async function send(conversationId = sessionId, body = 'Review this accepted finding.') {
		if (conversationId !== sessionId)
			await claimPalConversation(sender.workspace, sender.id, conversationId)
		const context = createCliPalMessagingContext(
			sender,
			{ sessionId: conversationId, tenantId },
			() => {},
		)
		const tool = context.tools.find((item) => item.name === 'send_pal_message')!
		const result = await tool.execute(
			{ palId: recipient.id, body },
			{ ...execution, sessionId: conversationId },
		)
		expect(result.success).toBe(true)
		return result
	}
	if (sendInitial) await send()
	const store = cliPalCommunicationStore()
	const guest = environment(recipient.id)
	const acquire = vi.fn(async () => guest)
	const runtime = new PalRuntime({ store: getCliPalStore(), environments: { acquire } })
	runtimes.push(runtime)
	controls.runtime.mockResolvedValue(runtime)
	controls.close.mockImplementation(() => runtime.close())
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const ctx: CommandContext = {
		config: { limits: { tokenBudget: 0, timeoutMs: 0, maxIterations: 5 } },
		formatter: createFormatter('text', { quiet: true }),
	}
	const revoke = () =>
		policy.update({
			source,
			recipient: target,
			expectedRevision: 1,
			enabled: false,
			allowWake: false,
		})
	return {
		sender,
		recipient,
		sessionId,
		source,
		target,
		provider,
		policy,
		store,
		guest,
		runtime,
		acquire,
		ctx,
		send,
		revoke,
	}
}

async function acceptedObservation(f: Awaited<ReturnType<typeof fixture>>, wake: boolean) {
	const subscriptionId = randomUUID()
	const state = await openSessions(f.sender.workspace)
	const scope = {
		tenantId: state.tenantId,
		projectId: state.projectId,
		palId: f.sender.id,
		profileRevision: f.sender.revision,
		sessionId: f.sessionId,
	}
	closeSessions(state)
	await cliPalActivitySubscriptionStore().create({
		id: subscriptionId,
		scope,
		recipient: f.target,
		enabled: true,
	})
	const policy = cliPalActivitySubscriptionPolicy()
	await policy.update({
		subscriptionId,
		expectedRevision: 0,
		observe: true,
		disclose: true,
		receive: true,
		wake,
	})
	const draft: PalIngressIntentDraft = {
		kind: 'observation',
		source: { kind: 'host-observation', subscriptionId, scope },
		recipient: f.target,
		routeKey: { v: 1, kind: 'observation', recipient: f.target, subscriptionId, scope },
		operationId: 'b'.repeat(64),
		fact: {
			id: 'b'.repeat(64),
			type: 'turn_started',
			sessionId: f.sessionId,
			turnId: generateTurnId(),
			seq: 2,
			generation: 1,
			at: '2026-10-02T00:00:00.000Z',
			status: 'running',
		},
		subscriptionTrail: [subscriptionId],
		replyTo: null,
		grant: { id: 'accepted-observation', revision: '1' },
		createdAt: 100,
	}
	const id = ingressIntentId(draft)
	await f.store.acceptIngress(
		{ ...draft, id, digest: ingressIntentDigest({ ...draft, id }) },
		f.recipient.revision,
	)
	return { subscriptionId, policy }
}
async function acceptedChannel(f: Awaited<ReturnType<typeof fixture>>) {
	const native = {
		provider: 'local-fixture',
		connectionId: 'configured-connection',
		externalTenantId: 'verified-native-tenant',
		nativeConversationId: 'native-conversation',
		nativeChannelId: null,
		nativeThreadId: 'native-thread',
	}
	const draft: PalIngressIntentDraft = {
		kind: 'channel',
		source: {
			kind: 'channel',
			tenantId: f.target.tenantId,
			...native,
			actorId: 'verified-event-actor',
			eventId: 'captured-native-event',
		},
		recipient: f.target,
		routeKey: { v: 1, kind: 'channel', recipient: f.target, ...native },
		body: 'AUTHENTICATED_CHANNEL_CONTEXT',
		operationId: 'captured-native-event',
		replyTo: null,
		grant: { id: 'accepted-channel', revision: '1' },
		createdAt: 100,
	}
	const id = ingressIntentId(draft)
	await f.store.acceptIngress(
		{ ...draft, id, digest: ingressIntentDigest({ ...draft, id }) },
		f.recipient.revision,
	)
}

describe('finite CLI Pal dispatch with actual SDK delivery', () => {
	it('does not acquire a guest or query a provider when the directed grant has no wake permission', async () => {
		const f = await fixture(undefined, false)
		expect(
			await dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal),
		).toEqual({
			status: 'blocked',
			reason: 'This Pal communication permission does not allow wakeup.',
		})
		expect(controls.probe).not.toHaveBeenCalled()
		expect(controls.runtime).not.toHaveBeenCalled()
		expect(f.acquire).not.toHaveBeenCalled()
		expect(f.provider.requests).toEqual([])
		expect((await f.store.read(f.target))?.messages[0]).toMatchObject({
			phase: 'pending',
			receipt: null,
		})
	})
	it('records one owned route with the accepted immutable profile and leaves another route pending', async () => {
		const f = await fixture()
		await f.send(generateSessionId(), 'A second independently accepted route.')
		updatePal(f.recipient.id, 1, {
			purpose: 'Changed later purpose.',
			model: { provider: 'openai', model: 'changed-model' },
		})
		const outcome = await dispatchCliPalMessages(
			f.ctx,
			f.recipient.id,
			new AbortController().signal,
		)
		expect(outcome.status).toBe('ran')
		expect(f.provider.requests).toHaveLength(1)
		expect(f.provider.requests[0]?.model).toBe('pinned-review-model')
		expect(JSON.stringify(f.provider.requests)).toContain('Review the accepted original evidence.')
		expect(JSON.stringify(f.provider.requests)).not.toContain('Changed later purpose.')
		expect(JSON.stringify(f.provider.requests)).not.toContain('fixture-private-provider-key')
		const snapshot = await f.store.read(f.target)
		expect(snapshot?.messages.map((message) => message.phase)).toEqual(['recorded', 'pending'])
		const delivered = snapshot?.messages[0]
		if (!delivered?.receipt) throw new Error('Actual query did not acknowledge its recorded input')
		const state = await openSessions(f.recipient.workspace)
		try {
			const log = DiskSessionLog.at(state.paths, { sessionId: delivered.receipt.sessionId })
			const record = (
				await log.readAll({ expectHead: delivered.receipt.through.pointer })
			).entries.find(
				(entry) =>
					entry.record.type === 'message' &&
					entry.record.messageId === delivered.receipt?.messageId,
			)?.record
			expect(record).toMatchObject({
				type: 'message',
				role: 'user',
				content: {
					source: {
						type: 'runtime-context',
						kind: 'peer-message',
						deliveryRef: {
							namespace: 'namzu-pal-message/1',
							id: delivered.id,
							digest: delivered.digest,
						},
					},
				},
			})
		} finally {
			closeSessions(state)
		}
		expect(f.acquire).toHaveBeenCalledOnce()
		expect(f.guest.release).toHaveBeenCalledOnce()
		expect(f.runtime.busy(f.recipient.id)).toBe(false)
	})
	it('rechecks revocation after computer admission and refuses delivery before inference', async () => {
		const f = await fixture()
		const original = f.runtime.admit.bind(f.runtime)
		vi.spyOn(f.runtime, 'admit').mockImplementation(async (request) => {
			const admission = await original(request)
			await f.revoke()
			return admission
		})
		await expect(
			dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal),
		).rejects.toThrow('permission')
		expect(f.provider.requests).toEqual([])
		expect(f.guest.sandbox.readFile).not.toHaveBeenCalled()
		expect(f.guest.sandbox.writeFile).not.toHaveBeenCalled()
		expect((await f.store.read(f.target))?.messages[0]?.phase).toBe('pending')
		expect(f.guest.release).toHaveBeenCalledOnce()
	})
	it('rechecks revocation at a tool boundary and does not make another inference call', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ name: 'read', args: { path: 'notes.txt' } }] },
				{ text: 'Must not continue after consent withdrawal.' },
			],
		})
		const f = await fixture(provider)
		const stream = provider.chatStream.bind(provider)
		vi.spyOn(provider, 'chatStream').mockImplementation(async function* (params) {
			yield* stream(params)
			await f.revoke()
		})
		await expect(
			dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal),
		).rejects.toThrow('step_refused')
		expect(provider.requests).toHaveLength(1)
		expect(f.guest.sandbox.readFile).not.toHaveBeenCalled()
		expect(f.guest.sandbox.writeFile).not.toHaveBeenCalled()
		expect((await f.store.read(f.target))?.messages[0]?.phase).toBe('recorded')
		expect(f.guest.release).toHaveBeenCalledOnce()
	})
	it('keeps strict tool review separate from directed wake permission', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ name: 'write', args: { path: 'unapproved.txt', content: 'Must not write.' } },
					],
				},
				{ text: 'The requested write needs separate review.' },
			],
		})
		const f = await fixture(provider)
		await dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal)
		expect(f.guest.sandbox.writeFile).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(2)
		expect(provider.requests[1]?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: 'tool',
					isError: true,
					content: expect.stringContaining('no rule covers this call'),
				}),
			]),
		)
	})
	it('removes the sender signal listener when an admitted query is explicitly interrupted', async () => {
		const f = await fixture()
		const controller = new AbortController()
		const add = vi.spyOn(controller.signal, 'addEventListener')
		const remove = vi.spyOn(controller.signal, 'removeEventListener')
		const original = f.runtime.admit.bind(f.runtime)
		vi.spyOn(f.runtime, 'admit').mockImplementation(async (request) => {
			const admission = await original(request)
			controller.abort(new Error('Explicit dispatch cancellation.'))
			return admission
		})
		await expect(dispatchCliPalMessages(f.ctx, f.recipient.id, controller.signal)).rejects.toThrow(
			'cancellation',
		)
		for (const [type, listener] of add.mock.calls) {
			if (type === 'abort') expect(remove).toHaveBeenCalledWith('abort', listener)
		}
		expect(add.mock.calls.some(([type]) => type === 'abort')).toBe(true)
		expect(f.provider.requests).toEqual([])
		expect(f.guest.release).toHaveBeenCalledOnce()
	})
	it('checks observation wake independently before any computer or provider work', async () => {
		const f = await fixture(undefined, true, false)
		await acceptedObservation(f, false)
		const result = await dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal)
		expect(result.status).toBe('blocked')
		expect(controls.probe).not.toHaveBeenCalled()
		expect(f.acquire).not.toHaveBeenCalled()
		expect(f.provider.requests).toEqual([])
		expect((await f.store.readIngress(f.target))?.messages[0]?.phase).toBe('pending')
	})
	it('rechecks observation disclosure revocation after admission before model or guest effects', async () => {
		const f = await fixture(undefined, true, false)
		const observation = await acceptedObservation(f, true)
		const original = f.runtime.admit.bind(f.runtime)
		vi.spyOn(f.runtime, 'admit').mockImplementation(async (request) => {
			const admission = await original(request)
			await observation.policy.update({
				subscriptionId: observation.subscriptionId,
				expectedRevision: 1,
				observe: true,
				disclose: false,
				receive: true,
				wake: true,
			})
			return admission
		})
		await expect(
			dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal),
		).rejects.toThrow('permission')
		expect(f.provider.requests).toEqual([])
		expect(f.guest.sandbox.readFile).not.toHaveBeenCalled()
		expect(f.guest.release).toHaveBeenCalledOnce()
		expect((await f.store.readIngress(f.target))?.messages[0]?.phase).toBe('pending')
	})
	it('requires a trusted channel authorizer before allocating a computer or calling a model', async () => {
		const f = await fixture(undefined, true, false)
		await acceptedChannel(f)
		expect(
			await dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal),
		).toEqual({
			status: 'blocked',
			reason: 'No trusted channel authorization adapter is configured.',
		})
		expect(f.acquire).not.toHaveBeenCalled()
		expect(f.provider.requests).toEqual([])
	})
	it('rechecks the current channel actor grant at tool boundaries', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ name: 'read', args: { path: 'private.txt' } }] },
				{ text: 'Must not infer again after actor revocation' },
			],
		})
		const f = await fixture(provider, true, false)
		await acceptedChannel(f)
		let permitted = true
		const authorizeChannel: PalChannelIngressOptions['authorize'] = vi.fn(async (request) =>
			permitted && request.source.actorId === 'verified-event-actor'
				? { allow: true as const, grant: { id: 'current-actor', revision: '1' } }
				: { allow: false as const, reason: 'Current channel actor revoked' },
		)
		const stream = provider.chatStream.bind(provider)
		vi.spyOn(provider, 'chatStream').mockImplementation(async function* (params) {
			yield* stream(params)
			permitted = false
		})
		await expect(
			dispatchCliPalMessages(f.ctx, f.recipient.id, new AbortController().signal, {
				authorizeChannel,
			}),
		).rejects.toThrow('step_refused')
		expect(provider.requests).toHaveLength(1)
		expect(f.guest.sandbox.readFile).not.toHaveBeenCalled()
		expect(f.guest.release).toHaveBeenCalledOnce()
		expect((await f.store.readIngress(f.target))?.messages[0]).toMatchObject({
			kind: 'channel',
			phase: 'recorded',
			receipt: { ref: { namespace: 'namzu-pal-channel/1' } },
		})
	})
})
