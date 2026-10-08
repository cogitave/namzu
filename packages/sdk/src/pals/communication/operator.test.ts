import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecordDraft } from '../../store/session-log/core.js'
import { DiskSessionLog } from '../../store/session-log/disk.js'
import type { SessionLease } from '../../store/session-log/lease.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type {
	InboundDeliveryClaim,
	InboundDeliveryReceipt,
} from '../../types/message/inbound-delivery.js'
import type { ToolContext } from '../../types/tool/index.js'
import {
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../utils/id.js'
import { DiskPalStore } from '../store.js'
import { PalMessageBroker } from './broker.js'
import { dispatchPalIngressOnce } from './ingress-dispatch.js'
import { checkedIngressIntent, ingressIntentDigest, ingressIntentId } from './ingress-schema.js'
import type {
	PalIngressAuthorizationRequest,
	PalIngressHostPort,
	PalIngressIntent,
	PalIngressOptions,
	PalIngressRouteBinding,
	PalOperatorIntent,
} from './ingress-types.js'
import {
	type PalOperatorConversation,
	PalOperatorMessageBroker,
	type PalOperatorMessageSender,
	type PalOperatorRecipient,
	createPalOperatorMessagingTools,
} from './operator.js'
import { DiskPalCommunicationStore } from './store.js'
import type { PalAddress } from './types.js'

const temporary: string[] = []
afterEach(async () => {
	for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})
const signal = () => new AbortController().signal

function completed(turnId: TurnId): SessionRecordDraft {
	return {
		type: 'turn_completed',
		turnId,
		result: 'Processed owner message',
		stopReason: 'end_turn',
		settlement: {
			status: 'completed',
			iterations: 1,
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
			durationMs: 0,
			resultSource: 'model',
			abandonedTaskIds: [],
			abandonedJobIds: [],
		},
	}
}

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-pal-operator-')))
	temporary.push(root)
	const pals = new DiskPalStore({ root: join(root, 'pals'), workspaceRoot: join(root, 'controls') })
	const research = pals.create({ name: 'Research' })
	const review = pals.create({ name: 'Review' })
	const tenantId = generateTenantId()
	const projectId = generateProjectId()
	const operatorSession = generateSessionId()
	const conversation: PalOperatorConversation = { tenantId, sessionId: operatorSession }
	const addressOf = (palId: string): PalAddress => ({ tenantId, palId })
	const store = new DiskPalCommunicationStore({ root: join(root, 'mail') })
	const logs = new Map<SessionId, { log: DiskSessionLog; lease: SessionLease }>()
	async function claimRoot(
		binding: Pick<PalIngressRouteBinding, 'sessionId' | 'profileRevision' | 'key'>,
	) {
		if (logs.has(binding.sessionId)) return
		const definition = pals.getRevision(binding.key.recipient.palId, binding.profileRevision)
		const log = new DiskSessionLog({
			now: () => 100,
			sessionId: binding.sessionId,
			file: join(root, 'logs', `${binding.sessionId}.jsonl`),
			sessionDir: join(root, 'logs', binding.sessionId),
		})
		const lease = await log.claim({
			holder: `fixture-${binding.sessionId}`,
			ttlMs: 60_000,
			now: 100,
		})
		if (!lease) throw new Error('Fixture writer was not admitted.')
		await log.append(lease, {
			type: 'session_started',
			projectId,
			tenantId,
			cwd: definition.workspace,
			agent: { id: definition.id, name: definition.name },
			origin: {
				protocol: 'desktop',
				externalSessionId: JSON.stringify([
					'namzu-pal',
					definition.id,
					definition.revision,
					binding.sessionId,
				]),
			},
		})
		logs.set(binding.sessionId, { log, lease })
	}
	const claims: InboundDeliveryClaim[] = []
	const host: PalIngressHostPort = {
		ensureConversation: async (binding) => claimRoot(binding),
		openConversation: async (binding) => {
			const owned = logs.get(binding.sessionId)
			if (!owned) throw new Error('Fixture conversation is not claimed.')
			return { log: owned.log, projectId }
		},
		notify: vi.fn(),
		runConversation: async (binding, source) => {
			const owned = logs.get(binding.sessionId)
			if (!owned) throw new Error('Missing fixture conversation.')
			const turnId = generateTurnId()
			await owned.log.beginTurn(owned.lease, {
				turnId,
				userMessageId: generateMessageId(),
				config: { model: 'fixture', tokenBudget: 0, timeoutMs: 60_000 },
			})
			for (const claim of await source.claim({
				sessionId: binding.sessionId,
				turnId,
				signal: signal(),
			})) {
				claims.push(claim)
				const messageId = generateMessageId()
				await owned.log.append(owned.lease, {
					type: 'message',
					turnId,
					messageId,
					role: 'user',
					kind: 'context',
					content: claim.message,
				})
				const through = await owned.log.head()
				if (!through) throw new Error('Missing appended head.')
				const receipt: InboundDeliveryReceipt = {
					claimId: claim.claimId,
					ref: claim.ref,
					sessionId: binding.sessionId,
					turnId,
					messageId,
					through,
				}
				await source.recorded([receipt])
			}
			await owned.log.append(owned.lease, completed(turnId))
		},
	}
	const requests: PalIngressAuthorizationRequest[] = []
	const policy = {
		wake: true,
		accept: true,
	}
	const authorize: PalIngressOptions['authorize'] = async (request) => {
		requests.push(request)
		const kind = 'kind' in request ? request.kind : 'pal'
		if (kind === 'operator' && request.phase === 'accept' && !policy.accept)
			return { allow: false, reason: 'Declined by the fixture.' }
		if (kind === 'operator' && request.phase === 'wake' && !policy.wake)
			return { allow: false, reason: 'No wake consent.' }
		return { allow: true, grant: { id: 'owner-conversation', revision: '1' } }
	}
	const broker = new PalOperatorMessageBroker({ store, pals, host, authorize, now: () => 100 })
	return {
		root,
		pals,
		research,
		review,
		tenantId,
		conversation,
		addressOf,
		store,
		host,
		authorize,
		requests,
		policy,
		broker,
		claims,
		options: { store, pals, host, authorize } satisfies PalIngressOptions,
	}
}

describe('operator-conversation Pal messages', () => {
	it('accepts the owner conversation as its own source, never as a Pal address', async () => {
		const f = await fixture()
		const receipt = await f.broker.send(f.conversation, {
			operationId: 'call-1',
			recipient: f.addressOf(f.review.id),
			body: 'Summarise the open reviews.',
		})
		expect(receipt).toMatchObject({ status: 'accepted', recipient: f.addressOf(f.review.id) })
		expect(f.host.notify).toHaveBeenCalledWith(f.addressOf(f.review.id))
		const snapshot = await f.store.readIngress(f.addressOf(f.review.id))
		const [message] = snapshot?.messages ?? []
		expect(message).toMatchObject({
			kind: 'operator',
			phase: 'pending',
			body: 'Summarise the open reviews.',
			replyTo: null,
			source: {
				kind: 'operator-conversation',
				tenantId: f.tenantId,
				sessionId: f.conversation.sessionId,
			},
			routeKey: {
				v: 1,
				kind: 'operator',
				recipient: f.addressOf(f.review.id),
				conversationId: f.conversation.sessionId,
			},
			grant: { id: 'owner-conversation', revision: '1' },
		})
		expect(message?.source).not.toHaveProperty('address')
		expect(message?.source).not.toHaveProperty('palId')
		expect(f.requests).toEqual([
			expect.objectContaining({ phase: 'accept', kind: 'operator', replyTo: null }),
		])
		// The legacy Pal-only reader keeps its shape and does not see the new family.
		expect((await f.store.read(f.addressOf(f.review.id)))?.messages).toEqual([])
	})

	it('is idempotent per tool call and refuses a changed body under the same operation', async () => {
		const f = await fixture()
		const request = {
			operationId: 'call-1',
			recipient: f.addressOf(f.review.id),
			body: 'One task.',
		}
		const first = await f.broker.send(f.conversation, request)
		const again = await f.broker.send(f.conversation, request)
		expect(again.id).toBe(first.id)
		expect((await f.store.readIngress(f.addressOf(f.review.id)))?.messages).toHaveLength(1)
		await expect(
			f.broker.send(f.conversation, { ...request, body: 'Another task.' }),
		).rejects.toThrow('different immutable intent')
	})

	it('gives a second operator conversation a distinct Pal conversation and shares one ordinal sequence', async () => {
		const f = await fixture()
		const target = f.addressOf(f.review.id)
		await f.broker.send(f.conversation, { operationId: 'a', recipient: target, body: 'First.' })
		await f.broker.send(f.conversation, { operationId: 'b', recipient: target, body: 'Second.' })
		await f.broker.send(
			{ tenantId: f.tenantId, sessionId: generateSessionId() },
			{ operationId: 'a', recipient: target, body: 'Elsewhere.' },
		)
		const snapshot = await f.store.readIngress(target)
		expect(snapshot?.messages.map((m) => m.ordinal)).toEqual([1, 2, 3])
		expect(snapshot?.routes).toHaveLength(2)
		const sessions = new Set(snapshot?.routes.map((route) => route.sessionId))
		expect(sessions.size).toBe(2)
	})

	it('refuses forged, missing, foreign or unavailable context and writes nothing', async () => {
		const f = await fixture()
		const target = f.addressOf(f.review.id)
		const send = (conversation: unknown, recipient: PalAddress = target) =>
			f.broker.send(conversation as PalOperatorConversation, {
				operationId: 'call-1',
				recipient,
				body: 'Task.',
			})
		await expect(send({ tenantId: f.tenantId })).rejects.toThrow()
		await expect(send({ sessionId: f.conversation.sessionId })).rejects.toThrow()
		await expect(send({ ...f.conversation, address: f.addressOf(f.research.id) })).rejects.toThrow()
		await expect(send({ ...f.conversation, palId: f.research.id })).rejects.toThrow()
		await expect(send({ ...f.conversation, sessionId: 'not-a-session' })).rejects.toThrow()
		await expect(
			send({ tenantId: generateTenantId(), sessionId: f.conversation.sessionId }),
		).rejects.toThrow('Cross-tenant')
		await expect(
			send(f.conversation, f.addressOf('00000000-0000-4000-8000-000000000000')),
		).rejects.toThrow('unavailable')
		expect(await f.store.readIngress(target)).toBeNull()
		expect(f.requests).toEqual([])
	})

	it('refuses a paused Pal, one paused while authorization was pending, and a declined acceptance', async () => {
		const f = await fixture()
		const target = f.addressOf(f.review.id)
		f.pals.update(f.review.id, f.review.revision, { paused: true })
		await expect(
			f.broker.send(f.conversation, { operationId: 'p', recipient: target, body: 'Task.' }),
		).rejects.toThrow('paused')
		f.pals.update(f.review.id, f.review.revision + 1, { paused: false })
		const pausing = new PalOperatorMessageBroker({
			store: f.store,
			pals: f.pals,
			authorize: async () => {
				f.pals.update(f.review.id, f.review.revision + 2, { paused: true })
				return { allow: true, grant: { id: 'g', revision: '1' } }
			},
		})
		await expect(
			pausing.send(f.conversation, { operationId: 'q', recipient: target, body: 'Task.' }),
		).rejects.toThrow('paused before acceptance')
		f.pals.update(f.review.id, f.review.revision + 3, { paused: false })
		f.policy.accept = false
		await expect(
			f.broker.send(f.conversation, { operationId: 'r', recipient: target, body: 'Task.' }),
		).rejects.toThrow('Pal send refused: Declined by the fixture.')
		expect(await f.store.readIngress(target)).toBeNull()
	})

	it('does not let a notification failure revoke the committed acceptance', async () => {
		const f = await fixture()
		const onNotificationError = vi.fn()
		const broker = new PalOperatorMessageBroker({
			store: f.store,
			pals: f.pals,
			authorize: f.authorize,
			host: {
				notify: () => {
					throw new Error('hint failed')
				},
			},
			onNotificationError,
		})
		const receipt = await broker.send(f.conversation, {
			operationId: 'n',
			recipient: f.addressOf(f.review.id),
			body: 'Task.',
		})
		expect(receipt.status).toBe('accepted')
		expect(onNotificationError).toHaveBeenCalledOnce()
	})

	it('refuses a forged operator intent: Pal-looking source, foreign route, rewritten body', async () => {
		const f = await fixture()
		const target = f.addressOf(f.review.id)
		await f.broker.send(f.conversation, { operationId: 'x', recipient: target, body: 'Task.' })
		const stored = (await f.store.readIngress(target))?.messages[0]
		if (!stored || !('kind' in stored) || stored.kind !== 'operator')
			throw new Error('Expected an operator message.')
		const intent: PalOperatorIntent = {
			kind: 'operator',
			id: stored.id,
			digest: stored.digest,
			operationId: stored.operationId,
			source: stored.source,
			recipient: stored.recipient,
			routeKey: stored.routeKey,
			body: stored.body,
			replyTo: null,
			grant: stored.grant,
			createdAt: stored.createdAt,
		}
		expect(checkedIngressIntent(intent)).toMatchObject({ kind: 'operator' })
		expect(() =>
			checkedIngressIntent({
				...intent,
				source: { address: f.addressOf(f.research.id), conversationId: f.conversation.sessionId },
			}),
		).toThrow()
		const foreign: PalOperatorIntent = {
			...intent,
			routeKey: { ...intent.routeKey, conversationId: generateSessionId() },
		}
		const foreignId = ingressIntentId(foreign)
		expect(() =>
			checkedIngressIntent({
				...foreign,
				id: foreignId,
				digest: ingressIntentDigest({ ...foreign, id: foreignId }),
			}),
		).toThrow('Foreign operator conversation')
		expect(() => checkedIngressIntent({ ...intent, body: 'Rewritten.' })).toThrow(
			'Invalid immutable Pal source operation',
		)
		const draft: PalOperatorIntent = { ...intent, body: 'Rewritten.' }
		const rewritten: PalIngressIntent = {
			...draft,
			digest: ingressIntentDigest(draft),
		}
		await expect(f.store.acceptIngress(rewritten, 1)).rejects.toThrow('different immutable intent')
	})

	it('delivers as untrusted runtime context from the owner conversation, under separate wake consent', async () => {
		const f = await fixture()
		const target = f.addressOf(f.review.id)
		await f.broker.send(f.conversation, {
			operationId: 'd',
			recipient: target,
			body: 'Check the build and report.',
		})
		f.policy.wake = false
		expect(await dispatchPalIngressOnce(f.options, target, signal())).toEqual({
			status: 'blocked',
			reason: 'No wake consent.',
		})
		expect((await f.store.readIngress(target))?.messages[0]?.phase).toBe('pending')
		expect(f.claims).toEqual([])
		f.policy.wake = true
		expect((await dispatchPalIngressOnce(f.options, target, signal())).status).toBe('ran')
		const [claim] = f.claims
		expect(claim?.ref.namespace).toBe('namzu-pal-operator/1')
		expect(claim?.message.source).toMatchObject({ type: 'runtime-context', kind: 'peer-message' })
		const text = String(claim?.message.content)
		expect(text).toContain('Check the build and report.')
		expect(text).toContain("owner's")
		expect(text).toContain('not a tool approval')
		expect(text).toContain('never answers a permission question')
		expect((await f.store.readIngress(target))?.messages[0]?.phase).toBe('recorded')
	})

	it('leaves Pal-to-Pal messages in the same ledger on their original route, namespace and phase', async () => {
		const f = await fixture()
		const target = f.addressOf(f.review.id)
		const sender = f.addressOf(f.research.id)
		const senderSession = generateSessionId()
		const peer = new PalMessageBroker({
			store: f.store,
			pals: f.pals,
			host: f.host,
			authorize: async () => ({ allow: true, grant: { id: 'peer-rule', revision: '1' } }),
			now: () => 100,
		})
		// The sender root must be a claimed Pal conversation for the peer broker.
		await f.host.ensureConversation(
			{
				sessionId: senderSession,
				profileRevision: f.research.revision,
				key: {
					v: 1,
					kind: 'pal',
					sender,
					senderConversationId: senderSession,
					recipient: sender,
					dialogKey: 'x',
				},
			} as PalIngressRouteBinding,
			signal(),
		)
		await peer
			.sender({
				address: sender,
				conversationId: senderSession,
				profileRevision: f.research.revision,
			})
			.send({ operationId: 'peer', recipient: target, body: 'Peer note.' })
		await f.broker.send(f.conversation, {
			operationId: 'op',
			recipient: target,
			body: 'Owner task.',
		})
		const snapshot = await f.store.readIngress(target)
		expect(snapshot?.messages.map((m) => ('kind' in m ? m.kind : 'pal'))).toEqual([
			'pal',
			'operator',
		])
		expect(snapshot?.routes.map((r) => r.key.kind)).toEqual(['pal', 'operator'])
		expect((await f.store.read(target))?.messages.map((m) => m.source.address.palId)).toEqual([
			f.research.id,
		])
	})
})

function toolContext(sessionId: SessionId, overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId,
		turnId: generateTurnId(),
		toolUseId: 'call-1',
		toolBatchId: 'batch-1',
		workingDirectory: '/unused',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...overrides,
	}
}

describe('operator-conversation Pal tools', () => {
	function tools() {
		const tenantId = generateTenantId()
		const palId = '82936875-9b9d-49ef-946d-987957a2c3be'
		const receipt = {
			id: 'a'.repeat(64),
			digest: 'b'.repeat(64),
			recipient: { tenantId, palId },
			routeId: 'c'.repeat(64),
			sessionId: generateSessionId(),
			ordinal: 1,
			status: 'accepted' as const,
		}
		const send = vi.fn<PalOperatorMessageSender['send']>(async () => receipt)
		const visible: PalOperatorRecipient[] = [
			{ palId, name: 'Review', description: 'Reviews pull requests.', paused: false, idle: true },
			{ palId: 'ac77ddcd-9c9a-4624-8a2c-1677b9166468', name: 'Old', paused: true, idle: true },
		]
		const list = tools_(tenantId, send, visible)
		return { tenantId, palId, send, visible, ...list }
	}
	function tools_(
		tenantId: ReturnType<typeof generateTenantId>,
		send: PalOperatorMessageSender['send'],
		visible: readonly PalOperatorRecipient[],
	) {
		const all = createPalOperatorMessagingTools({
			tenantId,
			sender: { send },
			listPals: () => visible,
			recipientName: (id) => visible.find((pal) => pal.palId === id)?.name,
		})
		const named = (name: string) => {
			const tool = all.find((candidate) => candidate.name === name)
			if (!tool) throw new Error(`Missing ${name}.`)
			return tool
		}
		return { all, named }
	}

	it('advertises the two tool names with strict inputs and no sender or reply fields', () => {
		const f = tools()
		expect(f.all.map((tool) => tool.name)).toEqual(['send_pal_message', 'list_pals'])
		const sendTool = f.named('send_pal_message')
		expect(sendTool.inputSchema.safeParse({ palId: f.palId, body: 'x' }).success).toBe(true)
		for (const extra of [
			{ replyTo: 'a'.repeat(64) },
			{ operationId: 'chosen' },
			{ sender: f.palId },
		])
			expect(sendTool.inputSchema.safeParse({ palId: f.palId, body: 'x', ...extra }).success).toBe(
				false,
			)
		expect(f.named('list_pals').inputSchema.safeParse({ all: true }).success).toBe(false)
	})

	it('always declares that a person must approve a send, whatever the input', () => {
		const f = tools()
		const sendTool = f.named('send_pal_message')
		expect(sendTool.requiresApproval?.({ palId: f.palId, body: 'x' })).toBe(true)
		expect(sendTool.requiresApproval?.({ palId: 'anything', body: '' })).toBe(true)
		expect(sendTool.isReadOnly?.(undefined)).toBe(false)
		expect(f.named('list_pals').requiresApproval).toBeUndefined()
		expect(f.named('list_pals').isReadOnly?.(undefined)).toBe(true)
	})

	it('derives the owner conversation from the executing call and returns acceptance, not delivery', async () => {
		const f = tools()
		const session = generateSessionId()
		const result = await f
			.named('send_pal_message')
			.execute({ palId: f.palId, body: 'Check the build.' }, toolContext(session))
		expect(f.send).toHaveBeenCalledExactlyOnceWith(
			{ tenantId: f.tenantId, sessionId: session },
			{
				operationId: expect.stringMatching(/^[a-f0-9]{64}$/),
				recipient: { tenantId: f.tenantId, palId: f.palId },
				body: 'Check the build.',
			},
		)
		expect(result.success).toBe(true)
		const data = result.data as { status: string; recipientName: string; note: string }
		expect(data.status).toBe('accepted')
		expect(data.recipientName).toBe('Review')
		expect(data.note).toBe(
			"Sent to Review's inbox. This is durable acceptance, not delivery, a reply or finished work.",
		)
		expect(JSON.parse(result.output)).not.toHaveProperty('delivered')
	})

	it('keeps operation identity per executor call and refuses direct or foreign-session calls', async () => {
		const f = tools()
		const session = generateSessionId()
		const tool = f.named('send_pal_message')
		const input = { palId: f.palId, body: 'Once.' }
		await tool.execute(input, toolContext(session))
		await tool.execute(input, toolContext(session))
		await tool.execute(input, toolContext(session, { toolUseId: 'call-2' }))
		const ids = f.send.mock.calls.map(([, request]) => request.operationId)
		expect(ids[0]).toBe(ids[1])
		expect(ids[2]).not.toBe(ids[0])
		const noBatch = await tool.execute(input, toolContext(session, { toolBatchId: undefined }))
		expect(noBatch).toMatchObject({ success: false })
		expect(noBatch.error).toContain('toolBatchId and toolUseId')
		const foreign = await tool.execute(input, toolContext('not-a-session' as SessionId))
		expect(foreign).toMatchObject({ success: false })
		expect(foreign.error).toContain('executing conversation')
		expect(f.send).toHaveBeenCalledTimes(3)
	})

	it('lists the tenant Pals with state and presents readable rows', async () => {
		const f = tools()
		const result = await f.named('list_pals').execute({}, toolContext(generateSessionId()))
		expect(result.data).toEqual({
			pals: [
				{
					palId: f.palId,
					name: 'Review',
					description: 'Reviews pull requests.',
					paused: false,
					idle: true,
				},
				{ palId: 'ac77ddcd-9c9a-4624-8a2c-1677b9166468', name: 'Old', paused: true, idle: true },
			],
		})
		const sendTool = f.named('send_pal_message')
		const input = { palId: f.palId, body: 'Secret body must not be in the label.' }
		expect(sendTool.presentCall?.(input)).toEqual({
			kind: 'generic',
			label: 'Message to Review',
			presentation: 'activity',
		})
		expect(sendTool.presentResult?.(input, { success: true, output: '{}' })).toEqual({
			kind: 'generic',
			label: "Sent to Review's inbox",
			presentation: 'activity',
		})
		expect(
			sendTool.presentResult?.(input, { success: false, output: '', error: 'no' }),
		).toBeUndefined()
	})
})
