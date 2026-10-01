import { appendFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
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
import {
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../utils/id.js'
import { DiskPalStore } from '../store.js'
import { PalMessageBroker } from './broker.js'
import { dispatchPalMessagesOnce } from './dispatch.js'
import { createPalInboxSource, reconcilePalDelivery } from './inbound.js'
import { DiskPalCommunicationStore } from './store.js'
import type {
	PalAddress,
	PalInboxSourceOptions,
	PalMessageBrokerOptions,
	PalMessageHostPort,
	PalRouteBinding,
	PalVerificationContext,
} from './types.js'

const temporary: string[] = []
afterEach(async () => {
	for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})
const signal = () => new AbortController().signal

function deferred<T>() {
	let resolve: (value: T) => void = () => {
		throw new Error('Deferred resolver not initialized.')
	}
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function completed(turnId: TurnId): SessionRecordDraft {
	return {
		type: 'turn_completed',
		turnId,
		result: 'Processed explicit message',
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
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-pal-communication-')))
	temporary.push(root)
	const pals = new DiskPalStore({ root: join(root, 'pals'), workspaceRoot: join(root, 'controls') })
	const a = pals.create({ name: 'Research' })
	const b = pals.create({ name: 'Review' })
	const tenantId = generateTenantId()
	const addressA: PalAddress = { tenantId, palId: a.id }
	const addressB: PalAddress = { tenantId, palId: b.id }
	const conversationA = generateSessionId()
	const projectId = generateProjectId()
	const logs = new Map<SessionId, { log: DiskSessionLog; lease: SessionLease }>()
	const openLog = (id: SessionId) =>
		new DiskSessionLog({
			now: () => 100,
			sessionId: id,
			file: join(root, 'logs', `${id}.jsonl`),
			sessionDir: join(root, 'logs', id),
		})
	async function claimRoot(
		binding: Pick<PalRouteBinding, 'sessionId' | 'profileRevision' | 'key'>,
	) {
		if (logs.has(binding.sessionId)) return
		const definition = pals.getRevision(binding.key.recipient.palId, binding.profileRevision)
		const log = openLog(binding.sessionId)
		const lease = await log.claim({
			holder: `fixture-${binding.sessionId}`,
			ttlMs: 60_000,
			now: 100,
		})
		if (!lease) throw new Error('Fixture writer was not admitted.')
		const existing = await log.readAll()
		if (!existing.entries.length)
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
	await claimRoot({
		sessionId: conversationA,
		profileRevision: a.revision,
		key: {
			v: 1,
			kind: 'pal',
			sender: addressA,
			senderConversationId: conversationA,
			recipient: addressA,
			dialogKey: 'initial',
		},
	})
	const storeRoot = join(root, 'mail')
	const store = new DiskPalCommunicationStore({ root: storeRoot })
	const observed: { binding: PalRouteBinding; claim: InboundDeliveryClaim }[] = []
	const host: PalMessageHostPort = {
		ensureConversation: async (binding) => claimRoot(binding),
		openConversation: async (binding) => {
			const owned = logs.get(binding.sessionId)
			if (!owned) throw new Error('Fixture conversation is not claimed.')
			return { log: owned.log, projectId }
		},
		runConversation: async (binding, source) => {
			const turn = await begin(binding)
			const claims = await source.claim({
				sessionId: binding.sessionId,
				turnId: turn.turnId,
				signal: signal(),
			})
			for (const claim of claims) {
				observed.push({ binding, claim })
				await source.recorded([await appendClaim(binding, turn.turnId, claim)])
			}
			await turn.log.append(turn.lease, completed(turn.turnId))
		},
	}
	const authorize: PalMessageBrokerOptions['authorize'] = async () => ({
		allow: true,
		grant: { id: 'explicit-local-test-policy', revision: '1' },
	})
	const options = { store, pals, host, authorize, now: () => 100 }
	const broker = new PalMessageBroker(options)
	const sender = broker.sender({
		address: addressA,
		conversationId: conversationA,
		profileRevision: a.revision,
	})
	async function begin(binding: PalRouteBinding) {
		const owned = logs.get(binding.sessionId)
		if (!owned) throw new Error('Missing fixture conversation.')
		const turnId = generateTurnId()
		await owned.log.beginTurn(owned.lease, {
			turnId,
			userMessageId: generateMessageId(),
			config: { model: 'fixture', tokenBudget: 0, timeoutMs: 60_000 },
		})
		return { ...owned, turnId }
	}
	async function appendClaim(
		binding: PalRouteBinding,
		turnId: TurnId,
		claim: InboundDeliveryClaim,
	): Promise<InboundDeliveryReceipt> {
		const owned = logs.get(binding.sessionId)
		if (!owned) throw new Error('Missing fixture conversation.')
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
		return {
			claimId: claim.claimId,
			ref: claim.ref,
			sessionId: binding.sessionId,
			turnId,
			messageId,
			through,
		}
	}
	async function prepare() {
		const accepted = await sender.send({
			operationId: 'call-1',
			recipient: addressB,
			body: 'Review this finding.',
		})
		const snapshot = await store.read(addressB)
		const reserved = snapshot?.routes[0]
		if (!reserved) throw new Error('No route was reserved.')
		await host.ensureConversation(reserved, signal())
		const verification: PalVerificationContext = {
			binding: reserved,
			access: await host.openConversation(reserved, signal()),
			definition: pals.getRevision(b.id, reserved.profileRevision),
		}
		const binding = await store.activate(reserved, verification)
		const sourceOptions: PalInboxSourceOptions = { ...options, binding }
		return {
			accepted,
			binding,
			source: createPalInboxSource(sourceOptions),
			sourceOptions,
			verification: { ...verification, binding },
		}
	}
	return {
		root,
		pals,
		a,
		b,
		addressA,
		addressB,
		conversationA,
		storeRoot,
		store,
		host,
		options,
		broker,
		sender,
		logs,
		openLog,
		observed,
		begin,
		appendClaim,
		prepare,
	}
}

describe('durable Pal communication', () => {
	it('captures all request values and deeply freezes verified sender identity before authorization awaits', async () => {
		const f = await fixture()
		const c = f.pals.create({ name: 'Other Pal' })
		const entered = deferred<void>()
		const continuePolicy = deferred<void>()
		const captured = {
			address: { ...f.addressA },
			conversationId: f.conversationA,
			profileRevision: 1,
		}
		const sender = new PalMessageBroker({
			...f.options,
			authorize: async (context) => {
				expect(context.source.address.palId).toBe(f.a.id)
				expect(Object.isFrozen(context)).toBe(true)
				expect(Object.isFrozen(context.source.address)).toBe(true)
				expect(Reflect.set(context.source.address, 'palId', c.id)).toBe(false)
				expect(Reflect.set(context.routeKey.recipient, 'palId', c.id)).toBe(false)
				expect(context.body).toBe('Authorized body')
				entered.resolve()
				await continuePolicy.promise
				return { allow: true, grant: { id: 'exact-body', revision: '1' } }
			},
		}).sender(captured)
		captured.address.palId = c.id
		const request = {
			operationId: 'immutable-call',
			recipient: { ...f.addressB },
			body: 'Authorized body',
			dialogKey: 'authorized-dialog',
			replyTo: undefined as string | undefined,
		}
		const sending = sender.send(request)
		await entered.promise
		request.body = 'Unauthorized mutation'
		request.operationId = 'changed-call'
		request.recipient.palId = c.id
		request.dialogKey = 'changed-dialog'
		request.replyTo = 'a'.repeat(64)
		continuePolicy.resolve()
		await sending
		const message = (await f.store.read(f.addressB))?.messages[0]
		expect(message).toMatchObject({
			body: 'Authorized body',
			operationId: 'immutable-call',
			source: { address: f.addressA },
			routeKey: { dialogKey: 'authorized-dialog' },
			replyTo: null,
		})
		expect(await f.store.read({ ...f.addressB, palId: c.id })).toBeNull()
	})
	it('globally reserves one immutable source operation across different recipient partitions', async () => {
		const f = await fixture()
		const c = f.pals.create({ name: 'Other recipient' })
		const addressC = { ...f.addressB, palId: c.id }
		const second = new PalMessageBroker({
			...f.options,
			store: new DiskPalCommunicationStore({ root: f.storeRoot }),
		}).sender({ address: f.addressA, conversationId: f.conversationA, profileRevision: 1 })
		const outcomes = await Promise.allSettled([
			f.sender.send({
				operationId: 'one-source-call',
				recipient: f.addressB,
				body: 'One immutable intent',
			}),
			second.send({
				operationId: 'one-source-call',
				recipient: addressC,
				body: 'One immutable intent',
			}),
		])
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
		expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
		const bState = await f.store.read(f.addressB)
		const cState = await f.store.read(addressC)
		expect((bState?.messages.length ?? 0) + (cState?.messages.length ?? 0)).toBe(1)
		const acceptedRecipient = bState?.messages.length ? f.addressB : addressC
		const otherRecipient = bState?.messages.length ? addressC : f.addressB
		expect(
			(
				await second.send({
					operationId: 'one-source-call',
					recipient: acceptedRecipient,
					body: 'One immutable intent',
				})
			).status,
		).toBe('accepted')
		await expect(
			second.send({
				operationId: 'one-source-call',
				recipient: otherRecipient,
				body: 'One immutable intent',
			}),
		).rejects.toThrow('different immutable intent or recipient')
	})
	it('retains a reserve-only operation through restart and finishes only its original recipient commit', async () => {
		const f = await fixture()
		const c = f.pals.create({ name: 'Conflicting recipient' })
		const store = new DiskPalCommunicationStore({ root: f.storeRoot, maxPending: 1 })
		const options = { ...f.options, store }
		const sender = new PalMessageBroker(options).sender({
			address: f.addressA,
			conversationId: f.conversationA,
			profileRevision: 1,
		})
		await sender.send({ operationId: 'fills-queue', recipient: f.addressB, body: 'Process first' })
		const original = {
			operationId: 'reserved-before-crash',
			recipient: f.addressB,
			body: 'Preserve exact intent',
			dialogKey: 'independent-route',
		}
		await expect(sender.send(original)).rejects.toThrow('full')
		const reopened = new DiskPalCommunicationStore({ root: f.storeRoot, maxPending: 1 })
		const resumedOptions = { ...options, store: reopened }
		const resumed = new PalMessageBroker(resumedOptions).sender({
			address: f.addressA,
			conversationId: f.conversationA,
			profileRevision: 1,
		})
		await expect(
			resumed.send({ ...original, recipient: { ...f.addressB, palId: c.id } }),
		).rejects.toThrow('different immutable intent or recipient')
		expect(await reopened.read({ ...f.addressB, palId: c.id })).toBeNull()
		f.pals.update(f.b.id, 1, { name: 'Later profile' })
		await dispatchPalMessagesOnce(resumedOptions, f.addressB, signal())
		const accepted = await resumed.send(original)
		const state = await reopened.read(f.addressB)
		expect(state?.messages).toHaveLength(2)
		expect(state?.routes.find((route) => route.id === accepted.routeId)?.profileRevision).toBe(1)
		expect(await resumed.send(original)).toEqual(accepted)
	})
	it('rechecks the actual writer after delivery policy suspends and fences it', async () => {
		const f = await fixture()
		const { binding, sourceOptions } = await f.prepare()
		const turn = await f.begin(binding)
		const source = createPalInboxSource({
			...sourceOptions,
			authorize: async () => {
				await turn.log.release(turn.lease)
				await turn.log.claim({ holder: 'fenced-during-policy', ttlMs: 60_000, now: 100 })
				return { allow: true, grant: { id: 'policy', revision: '1' } }
			},
		})
		await expect(
			source.claim({ sessionId: binding.sessionId, turnId: turn.turnId, signal: signal() }),
		).rejects.toThrow('writer changed during delivery authorization')
		expect((await f.store.read(f.addressB))?.messages[0]?.phase).toBe('pending')
	})
	it('returns durable acceptance without waiting for a notification listener to finish', async () => {
		const f = await fixture()
		const wake = deferred<void>()
		const sender = new PalMessageBroker({
			...f.options,
			host: { ...f.host, notify: () => wake.promise },
		}).sender({ address: f.addressA, conversationId: f.conversationA, profileRevision: 1 })
		const accepted = await sender.send({
			operationId: 'nonblocking-wake',
			recipient: f.addressB,
			body: 'Durably queued',
		})
		expect(accepted.status).toBe('accepted')
		wake.resolve()
	})
	it('atomically reserves one route and accepts one immutable intent across store instances', async () => {
		const f = await fixture()
		const second = new PalMessageBroker({
			...f.options,
			store: new DiskPalCommunicationStore({ root: f.storeRoot }),
		}).sender({
			address: f.addressA,
			conversationId: f.conversationA,
			profileRevision: f.a.revision,
		})
		const request = { operationId: 'same-tool-call', recipient: f.addressB, body: 'One finding.' }
		const receipts = await Promise.all([f.sender.send(request), second.send(request)])
		expect(receipts[0]).toEqual(receipts[1])
		const state = await f.store.read(f.addressB)
		expect(state?.routes).toHaveLength(1)
		expect(state?.messages).toHaveLength(1)
		expect(state?.messages[0]?.phase).toBe('pending')
		await expect(second.send({ ...request, body: 'Different finding.' })).rejects.toThrow(
			'immutable intent',
		)
		expect((await f.store.read(f.addressB))?.messages).toHaveLength(1)
	})
	it('serializes different intents and preserves the first pinned route through edits and restart', async () => {
		const f = await fixture()
		await Promise.all(
			['one', 'two', 'three'].map((operationId) =>
				f.sender.send({ operationId, recipient: f.addressB, body: operationId }),
			),
		)
		const before = await f.store.read(f.addressB)
		f.pals.update(f.b.id, f.b.revision, { name: 'New profile' })
		const reopened = new DiskPalCommunicationStore({ root: f.storeRoot })
		expect(await reopened.read(f.addressB)).toEqual(before)
		await new PalMessageBroker({ ...f.options, store: reopened })
			.sender({
				address: f.addressA,
				conversationId: f.conversationA,
				profileRevision: f.a.revision,
			})
			.send({ operationId: 'four', recipient: f.addressB, body: 'Later.' })
		const after = await reopened.read(f.addressB)
		expect(after?.routes).toEqual(before?.routes)
		expect(after?.messages.map((m) => m.ordinal)).toEqual([1, 2, 3, 4])
	})
	it('keeps tenant, dialog and sender conversations separate without leaking private transcripts', async () => {
		const f = await fixture()
		await f.sender.send({
			operationId: 'one',
			recipient: f.addressB,
			body: 'Visible body.',
			dialogKey: 'A/B',
		})
		await f.sender.send({
			operationId: 'two',
			recipient: f.addressB,
			body: 'Other body.',
			dialogKey: 'a/b',
		})
		const state = await f.store.read(f.addressB)
		expect(state?.routes).toHaveLength(2)
		expect(new Set(state?.routes.map((r) => r.sessionId)).size).toBe(2)
		expect(await f.store.read({ ...f.addressB, tenantId: generateTenantId() })).toBeNull()
		await expect(
			f.sender.send({
				operationId: 'foreign',
				recipient: { ...f.addressB, tenantId: generateTenantId() },
				body: 'No.',
			}),
		).rejects.toThrow('Cross-tenant')
		expect(JSON.stringify(state)).not.toContain('Private source conversation history')
	})
	it.each([false, true])(
		'isolates notification and diagnostic failures (async=%s) from a committed acceptance receipt',
		async (asyncFailure) => {
			const f = await fixture()
			const notify = vi.fn(() => {
				if (asyncFailure) return Promise.reject(new Error('Wake unavailable'))
				throw new Error('Wake unavailable')
			})
			const diagnostics = vi.fn(() => {
				if (asyncFailure) return Promise.reject(new Error('Reporter unavailable'))
				throw new Error('Reporter unavailable')
			})
			const sender = new PalMessageBroker({
				...f.options,
				host: { ...f.host, notify },
				onNotificationError: diagnostics,
			}).sender({
				address: f.addressA,
				conversationId: f.conversationA,
				profileRevision: f.a.revision,
			})
			const receipt = await sender.send({
				operationId: 'notify-fails',
				recipient: f.addressB,
				body: 'Still accepted.',
			})
			expect(receipt.status).toBe('accepted')
			expect(notify).toHaveBeenCalledOnce()
			expect(diagnostics).toHaveBeenCalledOnce()
			expect((await f.store.read(f.addressB))?.messages[0]?.id).toBe(receipt.id)
		},
	)
	it('requires current policy for send and idle wake; a denial leaves accepted work pending', async () => {
		const f = await fixture()
		const denied = new PalMessageBroker({
			...f.options,
			authorize: async () => ({ allow: false, reason: 'No disclosure grant' }),
		})
		await expect(
			denied
				.sender({
					address: f.addressA,
					conversationId: f.conversationA,
					profileRevision: f.a.revision,
				})
				.send({ operationId: 'no', recipient: f.addressB, body: 'No.' }),
		).rejects.toThrow('No disclosure grant')
		expect(await f.store.read(f.addressB)).toBeNull()
		await f.sender.send({ operationId: 'later', recipient: f.addressB, body: 'Pending.' })
		const run = vi.fn(f.host.runConversation)
		expect(
			await dispatchPalMessagesOnce(
				{
					...f.options,
					host: { ...f.host, runConversation: run },
					authorize: async () => ({ allow: false, reason: 'No wake grant' }),
				},
				f.addressB,
				signal(),
			),
		).toEqual({ status: 'blocked', reason: 'No wake grant' })
		expect(run).not.toHaveBeenCalled()
		expect((await f.store.read(f.addressB))?.messages[0]?.phase).toBe('pending')
	})
	it('records context only through the exact owned writer and rejects acknowledgements before append', async () => {
		const f = await fixture()
		const { binding, source } = await f.prepare()
		const turn = await f.begin(binding)
		const [claim] = await source.claim({
			sessionId: binding.sessionId,
			turnId: turn.turnId,
			signal: signal(),
		})
		if (!claim) throw new Error('No incoming claim.')
		expect(claim.message.source).toMatchObject({
			type: 'runtime-context',
			kind: 'peer-message',
			deliveryRef: claim.ref,
		})
		expect(claim.message.content).toContain('NOT a message from the operator')
		const head = await turn.log.head()
		if (!head) throw new Error('No fixture head.')
		await expect(
			source.recorded([
				{
					claimId: claim.claimId,
					ref: claim.ref,
					sessionId: binding.sessionId,
					turnId: turn.turnId,
					messageId: generateMessageId(),
					through: head,
				},
			]),
		).rejects.toThrow('No matching recorded')
		const receipt = await f.appendClaim(binding, turn.turnId, claim)
		await expect(
			source.recorded([
				{ ...receipt, through: { ...receipt.through, gen: receipt.through.gen + 1 } },
			]),
		).rejects.toThrow('actual verified log head')
		await expect(source.recorded([{ ...receipt, claimId: generateSessionId() }])).rejects.toThrow(
			'exact Pal delivery claim',
		)
		await source.recorded([receipt])
		expect((await f.store.read(f.addressB))?.messages[0]?.phase).toBe('recorded')
		await source.recorded([receipt])
		await expect(
			source.claim({ sessionId: f.conversationA, turnId: turn.turnId, signal: signal() }),
		).rejects.toThrow('Foreign query')
	})
	it('recovers an append before acknowledgement after reopening, including original records removed by compaction', async () => {
		const f = await fixture()
		const { binding, source } = await f.prepare()
		const turn = await f.begin(binding)
		const [claim] = await source.claim({
			sessionId: binding.sessionId,
			turnId: turn.turnId,
			signal: signal(),
		})
		if (!claim) throw new Error('No incoming claim.')
		const receipt = await f.appendClaim(binding, turn.turnId, claim)
		await turn.log.append(turn.lease, {
			type: 'compaction',
			turnId: turn.turnId,
			compactionId: 'delivery-compaction',
			strategy: 'summarize',
			trigger: 'manual',
			tokensBefore: 100,
			tokensAfter: 1,
			replacesSeqRange: [1, receipt.through.pointer.seq],
			summary: [{ role: 'system', content: 'Summary only.' }],
			keptMessageIds: [],
		})
		expect((await turn.log.messages()).some((m) => m.content === claim.message.content)).toBe(false)
		const store = new DiskPalCommunicationStore({ root: f.storeRoot })
		const recovered = createPalInboxSource({ ...f.options, store, binding })
		expect(
			await recovered.claim({
				sessionId: binding.sessionId,
				turnId: turn.turnId,
				signal: signal(),
			}),
		).toEqual([])
		expect((await store.read(f.addressB))?.messages[0]?.phase).toBe('recorded')
		expect(
			(await turn.log.readAll()).entries.filter((e) => e.record.type === 'message'),
		).toHaveLength(1)
	})
	it('keeps unresolved claims without time-based theft, and only releases with verified stopped/fenced evidence', async () => {
		const f = await fixture()
		const { binding, source, verification, sourceOptions } = await f.prepare()
		const turn = await f.begin(binding)
		await source.claim({ sessionId: binding.sessionId, turnId: turn.turnId, signal: signal() })
		const claimed = (await f.store.read(f.addressB))?.messages[0]
		if (!claimed) throw new Error('No claim.')
		expect(
			await createPalInboxSource(sourceOptions).claim({
				sessionId: binding.sessionId,
				turnId: turn.turnId,
				signal: signal(),
			}),
		).toEqual([])
		await expect(f.store.releaseUnrecorded(claimed, verification)).rejects.toThrow(
			'fenced and stopped',
		)
		await turn.log.release(turn.lease)
		const replacement = await turn.log.claim({ holder: 'recovery', ttlMs: 60_000, now: 100 })
		if (!replacement) throw new Error('No recovery lease.')
		await expect(f.store.releaseUnrecorded(claimed, verification)).rejects.toThrow(
			'fenced and stopped',
		)
		await turn.log.abandonTurn(replacement, turn.turnId, 'Verified recovery')
		expect((await f.store.releaseUnrecorded(claimed, verification)).phase).toBe('pending')
		await expect(
			f.store.recorded(
				claimed,
				{
					claimId: claimed.claim?.id ?? '',
					ref: { namespace: 'namzu-pal-message/1', id: claimed.id, digest: claimed.digest },
					sessionId: binding.sessionId,
					turnId: turn.turnId,
					messageId: generateMessageId(),
					through: (await turn.log.head()) as InboundDeliveryReceipt['through'],
				},
				verification,
			),
		).rejects.toThrow()
	})
	it('does not accept foreign-profile roots or torn evidence as delivery proof', async () => {
		const f = await fixture()
		const { binding, source, sourceOptions } = await f.prepare()
		const turn = await f.begin(binding)
		const [claim] = await source.claim({
			sessionId: binding.sessionId,
			turnId: turn.turnId,
			signal: signal(),
		})
		if (!claim) throw new Error('No incoming claim.')
		const receipt = await f.appendClaim(binding, turn.turnId, claim)
		await appendFile(join(f.root, 'logs', `${binding.sessionId}.jsonl`), '{"torn":')
		await expect(source.recorded([receipt])).rejects.toThrow('incomplete')
		const message = (await f.store.read(f.addressB))?.messages[0]
		if (!message) throw new Error('Missing intent.')
		await expect(reconcilePalDelivery(sourceOptions, message, signal())).rejects.toThrow(
			'incomplete',
		)
		expect((await f.store.read(f.addressB))?.messages[0]?.phase).toBe('claimed')
		const foreign = createPalInboxSource({
			...sourceOptions,
			host: {
				...f.host,
				openConversation: async () => ({
					log: f.logs.get(f.conversationA)?.log as DiskSessionLog,
					projectId: generateProjectId(),
				}),
			},
		})
		await expect(
			foreign.claim({ sessionId: binding.sessionId, turnId: turn.turnId, signal: signal() }),
		).rejects.toThrow('Foreign Pal')
	})
	it('runs a finite two-Pal exchange and routes an authorized reply to the original sender conversation', async () => {
		const f = await fixture()
		const accepted = await f.sender.send({
			operationId: 'question',
			recipient: f.addressB,
			body: 'Please review this finding.',
		})
		expect((await dispatchPalMessagesOnce(f.options, f.addressB, signal())).status).toBe('ran')
		expect(f.observed).toHaveLength(1)
		const bConversation = f.observed[0]?.binding.sessionId
		if (!bConversation) throw new Error('No recipient conversation.')
		const bSender = f.broker.sender({
			address: f.addressB,
			conversationId: bConversation,
			profileRevision: f.b.revision,
		})
		const response = await bSender.send({
			operationId: 'answer',
			recipient: f.addressA,
			body: 'Review completed.',
			replyTo: accepted.id,
		})
		expect(response.sessionId).toBe(f.conversationA)
		await dispatchPalMessagesOnce(f.options, f.addressA, signal())
		expect(f.observed).toHaveLength(2)
		expect(f.observed[1]?.claim.message.content).toContain('Review completed.')
		expect(f.observed[1]?.binding.sessionId).toBe(f.conversationA)
		expect((await f.store.read(f.addressA))?.messages[0]?.phase).toBe('recorded')
		expect(await dispatchPalMessagesOnce(f.options, f.addressB, signal())).toEqual({
			status: 'idle',
			reason: 'empty',
		})
		await expect(
			bSender.send({
				operationId: 'fake-reply',
				recipient: f.addressA,
				body: 'No.',
				replyTo: 'a'.repeat(64),
			}),
		).rejects.toThrow('observed')
	})
	it('accepts while recipient is paused but never wakes it or changes its pinned revision', async () => {
		const f = await fixture()
		f.pals.update(f.b.id, 1, { paused: true })
		await f.sender.send({ operationId: 'paused', recipient: f.addressB, body: 'Wait safely.' })
		expect((await f.store.read(f.addressB))?.messages[0]?.phase).toBe('pending')
		await expect(dispatchPalMessagesOnce(f.options, f.addressB, signal())).rejects.toThrow('paused')
		f.pals.update(f.b.id, 2, { paused: false })
		await dispatchPalMessagesOnce(f.options, f.addressB, signal())
		expect((await f.store.read(f.addressB))?.routes[0]?.profileRevision).toBe(2)
	})
	it('enforces pending quota without evicting accepted intents or forgetting recorded deduplication', async () => {
		const f = await fixture()
		const store = new DiskPalCommunicationStore({ root: f.storeRoot, maxPending: 1 })
		const options = { ...f.options, store }
		const sender = new PalMessageBroker(options).sender({
			address: f.addressA,
			conversationId: f.conversationA,
			profileRevision: f.a.revision,
		})
		const request = { operationId: 'one', recipient: f.addressB, body: 'Keep me.' }
		const accepted = await sender.send(request)
		await expect(sender.send({ ...request, operationId: 'two' })).rejects.toThrow('full')
		await dispatchPalMessagesOnce(options, f.addressB, signal())
		expect(await sender.send(request)).toEqual(accepted)
		await sender.send({ ...request, operationId: 'two' })
		expect((await store.read(f.addressB))?.messages).toHaveLength(2)
		const raw = await readFile(join(f.root, 'logs', `${accepted.sessionId}.jsonl`), 'utf8')
		expect(raw).toContain('deliveryRef')
	})
})
