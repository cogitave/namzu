import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiskRevisionRecordStore } from '../../store/kv/revision-record-store.js'
import { defineSchema } from '../../store/schema.js'
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
import type { PalActivityFact, PalActivityScope } from '../activity/types.js'
import { DiskPalStore } from '../store.js'
import { PalMessageBroker } from './broker.js'
import { dispatchPalMessagesOnce } from './dispatch.js'
import { createPalInboxSource } from './inbound.js'
import { dispatchPalIngressOnce } from './ingress-dispatch.js'
import { createPalIngressInboxSource, reconcilePalIngressDelivery } from './ingress-inbound.js'
import { ingressIntentDigest, ingressIntentId } from './ingress-schema.js'
import type {
	PalIngressHostPort,
	PalIngressIntent,
	PalIngressIntentDraft,
	PalIngressOptions,
	PalIngressRouteBinding,
} from './ingress-types.js'
import { addressTuple, hash, intentDigest, messageId, routeId } from './schema.js'
import { DiskPalCommunicationStore, PalIngressBlockedError } from './store.js'
import type {
	PalAddress,
	PalInboxSourceOptions,
	PalMessageBrokerOptions,
	PalVerificationContext,
} from './types.js'
import { verifyIngressRecorded } from './verify.js'

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
		binding: Pick<PalIngressRouteBinding, 'sessionId' | 'profileRevision' | 'key'>,
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
	const observed: { binding: PalIngressRouteBinding; claim: InboundDeliveryClaim }[] = []
	const host: PalIngressHostPort = {
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
	async function begin(binding: PalIngressRouteBinding) {
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
		binding: PalIngressRouteBinding,
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

function observation(
	f: Awaited<ReturnType<typeof fixture>>,
	subscriptionId = randomUUID(),
): PalIngressIntent {
	const scope: PalActivityScope = {
		tenantId: f.addressA.tenantId,
		projectId: generateProjectId(),
		palId: f.a.id,
		profileRevision: 1,
		sessionId: f.conversationA,
	}
	const fact: PalActivityFact = {
		id: 'a'.repeat(64),
		sessionId: scope.sessionId,
		seq: 2,
		generation: 1,
		turnId: generateTurnId(),
		type: 'turn_started',
		at: '2026-10-02T00:00:00.000Z',
		status: 'running',
	}
	const draft: PalIngressIntentDraft = {
		kind: 'observation',
		source: { kind: 'host-observation', subscriptionId, scope },
		recipient: f.addressB,
		routeKey: { v: 1, kind: 'observation', recipient: f.addressB, subscriptionId, scope },
		fact,
		subscriptionTrail: [subscriptionId],
		replyTo: null,
		operationId: fact.id,
		grant: { id: 'explicit-observe-disclose-receive', revision: '1' },
		createdAt: 100,
	}
	const id = ingressIntentId(draft)
	return { ...draft, id, digest: ingressIntentDigest({ ...draft, id }) }
}
function channel(
	f: Awaited<ReturnType<typeof fixture>>,
	eventId = 'native-event-1',
): PalIngressIntent {
	const native = {
		provider: 'local-test',
		connectionId: 'captured-connection',
		externalTenantId: 'verified-tenant',
		nativeConversationId: 'conversation',
		nativeChannelId: null,
		nativeThreadId: null,
	}
	const draft: PalIngressIntentDraft = {
		kind: 'channel',
		source: {
			kind: 'channel',
			tenantId: f.addressB.tenantId,
			...native,
			actorId: 'verified-actor',
			eventId,
		},
		recipient: f.addressB,
		routeKey: { v: 1, kind: 'channel', recipient: f.addressB, ...native },
		body: 'Untrusted external text',
		replyTo: null,
		operationId: eventId,
		grant: { id: 'explicit-channel-receive', revision: '1' },
		createdAt: 100,
	}
	const id = ingressIntentId(draft)
	return { ...draft, id, digest: ingressIntentDigest({ ...draft, id }) }
}
async function activate(f: Awaited<ReturnType<typeof fixture>>, intent: PalIngressIntent) {
	await f.store.acceptIngress(intent, 1)
	const reserved = await f.store.routeIngress(intent.routeKey)
	if (!reserved) throw new Error('Missing reserved route')
	await f.host.ensureConversation(reserved, signal())
	const context = {
		binding: reserved,
		access: await f.host.openConversation(reserved, signal()),
		definition: f.b,
	}
	return f.store.activateIngress(reserved, context)
}
function generic(f: Awaited<ReturnType<typeof fixture>>): PalIngressOptions {
	return {
		...f.options,
		authorize: async () => ({
			allow: true,
			grant: { id: 'current-all-test-authority', revision: '1' },
		}),
	}
}

describe('shared Pal input ledger', () => {
	it('keeps legacy IDs, route IDs, shape and digest while preserving non-Pal rows through legacy writes', async () => {
		const f = await fixture()
		const obs = observation(f)
		await f.store.acceptIngress(obs, 1)
		const prepared = await f.prepare()
		const pal = (await f.store.read(f.addressB))?.messages[0]
		expect(pal).toBeDefined()
		if (!pal) throw new Error('Missing Pal row')
		expect(pal.id).toBe(messageId(pal.source, pal.operationId))
		expect(pal.digest).toBe(intentDigest(pal))
		expect(prepared.binding.id).toBe(routeId(pal.routeKey))
		expect('kind' in pal).toBe(false)
		expect((await f.store.readIngress(f.addressB))?.messages.map((m) => m.ordinal)).toEqual([1, 2])
		const turn = await f.begin(prepared.binding)
		const claims = await prepared.source.claim({
			sessionId: prepared.binding.sessionId,
			turnId: turn.turnId,
			signal: signal(),
		})
		const claim = claims[0]
		if (!claim) throw new Error('Missing delivery claim')
		await prepared.source.recorded([await f.appendClaim(prepared.binding, turn.turnId, claim)])
		const reloaded = new DiskPalCommunicationStore({ root: f.storeRoot })
		const rows = (await reloaded.readIngress(f.addressB))?.messages
		expect(rows).toHaveLength(2)
		expect(rows?.[0]).toMatchObject({ kind: 'observation', phase: 'pending' })
		expect(rows?.[1]?.phase).toBe('recorded')
	})
	it('serializes mixed acceptance and counts every family against one pending bound', async () => {
		const f = await fixture()
		const bounded = new DiskPalCommunicationStore({ root: f.storeRoot, maxPending: 2 })
		const other = new DiskPalCommunicationStore({ root: f.storeRoot, maxPending: 2 })
		const out = await Promise.all([
			bounded.acceptIngress(observation(f), 1),
			other.acceptIngress(channel(f), 1),
		])
		expect(out.map((r) => r.ordinal).sort()).toEqual([1, 2])
		expect((await f.store.readIngress(f.addressB))?.messages).toHaveLength(2)
		await expect(bounded.acceptIngress(channel(f, 'native-event-2'), 1)).rejects.toThrow(
			'queue is full',
		)
	})
	it('blocks hidden non-Pal claims atomically and prevents legacy source and dispatcher loops', async () => {
		const f = await fixture()
		const obs = observation(f)
		const binding = await activate(f, obs)
		const prepared = await f.prepare()
		const turn = await f.begin(binding)
		const source = createPalIngressInboxSource({ ...generic(f), binding, host: f.host })
		const claims = await source.claim({
			sessionId: binding.sessionId,
			turnId: turn.turnId,
			signal: signal(),
		})
		expect(claims).toHaveLength(1)
		const palTurn = await f.begin(prepared.binding)
		await expect(
			f.store.claim(prepared.binding, {
				turnId: palTurn.turnId,
				generation: palTurn.lease.fence,
				content: () => '',
			}),
		).rejects.toBeInstanceOf(PalIngressBlockedError)
		await expect(
			prepared.source.claim({
				sessionId: prepared.binding.sessionId,
				turnId: palTurn.turnId,
				signal: signal(),
			}),
		).rejects.toBeInstanceOf(PalIngressBlockedError)
		const ensure = vi.spyOn(f.host, 'ensureConversation')
		expect(await dispatchPalMessagesOnce(f.options, f.addressB, signal())).toEqual({
			status: 'idle',
			reason: 'unresolved',
		})
		expect(ensure).not.toHaveBeenCalled()
		expect((await f.store.read(f.addressB))?.messages[0]?.phase).toBe('pending')
	})
	it.each(['observation', 'channel'] as const)(
		'records and recovers an exact %s receipt without changing its source into a Pal',
		async (kind) => {
			const f = await fixture()
			const intent = kind === 'observation' ? observation(f) : channel(f)
			const binding = await activate(f, intent)
			const turn = await f.begin(binding)
			const opts = { ...generic(f), binding, host: f.host }
			const source = createPalIngressInboxSource(opts)
			const claims = await source.claim({
				sessionId: binding.sessionId,
				turnId: turn.turnId,
				signal: signal(),
			})
			const claim = claims[0]
			if (!claim) throw new Error('Missing delivery claim')
			expect(claim.message.source).toMatchObject({
				type: 'runtime-context',
				kind: kind === 'observation' ? 'host-observation' : 'channel-message',
				deliveryRef: { namespace: `namzu-pal-${kind}/1` },
			})
			expect(claim.message.content).toContain('no operator authority')
			expect(claim.message.content).not.toContain('Explicit message from another Pal')
			const receipt = await f.appendClaim(binding, turn.turnId, claim)
			const message = (await f.store.readIngress(f.addressB))?.messages[0]
			if (!message) throw new Error('Missing inbox message')
			await expect(
				f.store.recordedIngress(
					message,
					{ ...receipt, ref: { ...receipt.ref, namespace: 'namzu-pal-message/1' } },
					{ binding, access: await f.host.openConversation(binding, signal()), definition: f.b },
				),
			).rejects.toThrow('Receipt does not match')
			const restarted = new DiskPalCommunicationStore({ root: f.storeRoot })
			expect(
				await reconcilePalIngressDelivery({ ...opts, store: restarted }, message, signal()),
			).toBe(true)
			expect((await restarted.readIngress(f.addressB))?.messages[0]?.phase).toBe('recorded')
			expect((await restarted.read(f.addressB))?.messages).toEqual([])
		},
	)
	it('uses current family authorization before allocating a guest or consuming a pending input', async () => {
		const f = await fixture()
		await f.store.acceptIngress(channel(f), 1)
		const authorize = vi.fn(async () => ({
			allow: false as const,
			reason: 'Current channel receive revoked',
		}))
		const ensure = vi.spyOn(f.host, 'ensureConversation')
		expect(
			await dispatchPalIngressOnce({ ...generic(f), authorize }, f.addressB, signal()),
		).toEqual({ status: 'blocked', reason: 'Current channel receive revoked' })
		expect(authorize.mock.calls).toHaveLength(1)
		expect(ensure).not.toHaveBeenCalled()
	})
	it('rechecks the session writer after current family policy awaits', async () => {
		const f = await fixture()
		const binding = await activate(f, channel(f))
		const turn = await f.begin(binding)
		const entered = deferred<void>()
		const proceed = deferred<void>()
		const source = createPalIngressInboxSource({
			...generic(f),
			binding,
			host: f.host,
			authorize: async () => {
				entered.resolve()
				await proceed.promise
				return { allow: true, grant: { id: 'current', revision: '1' } }
			},
		})
		const pending = source.claim({
			sessionId: binding.sessionId,
			turnId: turn.turnId,
			signal: signal(),
		})
		await entered.promise
		await turn.log.append(turn.lease, completed(turn.turnId))
		proceed.resolve()
		await expect(pending).rejects.toThrow('writer changed')
		expect((await f.store.readIngress(f.addressB))?.messages[0]?.phase).toBe('pending')
	})
	it('deduplicates native event globally without actor or target in its identity and rejects changed immutable intent', async () => {
		const f = await fixture()
		const original = channel(f)
		await f.store.acceptIngress(original, 1)
		if (!('kind' in original) || original.kind !== 'channel') throw new Error('Expected channel')
		const changed = { ...original, source: { ...original.source, actorId: 'another-actor' } }
		expect(ingressIntentId(changed)).toBe(original.id)
		const changedIntent = { ...changed, digest: ingressIntentDigest(changed) }
		await expect(f.store.acceptIngress(changedIntent, 1)).rejects.toThrow(
			'different immutable intent',
		)
		expect((await f.store.readIngress(f.addressB))?.messages).toHaveLength(1)
	})
	it('rejects arbitrary observation payloads, foreign scopes and repeated subscription lineage', async () => {
		const f = await fixture()
		const original = observation(f)
		if (!('kind' in original) || original.kind !== 'observation')
			throw new Error('Expected observation')
		await expect(
			f.store.acceptIngress(
				{ ...original, fact: { ...original.fact, body: 'private' } } as PalIngressIntent,
				1,
			),
		).rejects.toThrow()
		const trail = {
			...original,
			subscriptionTrail: [...original.subscriptionTrail, ...original.subscriptionTrail],
		}
		await expect(
			f.store.acceptIngress({ ...trail, digest: ingressIntentDigest(trail) }, 1),
		).rejects.toThrow()
		const foreign = {
			...original,
			source: {
				...original.source,
				scope: { ...original.source.scope, tenantId: generateTenantId() },
			},
		}
		await expect(
			f.store.acceptIngress({ ...foreign, digest: ingressIntentDigest(foreign) }, 1),
		).rejects.toThrow()
		expect(await f.store.readIngress(f.addressB)).toBeNull()
	})
	it('migrates an original v1 recipient commit and prevents an old binary from mutating a v2 mixed commit', async () => {
		const f = await fixture()
		await f.prepare()
		const directory = join(f.storeRoot, hash(addressTuple(f.addressB)), 'revisions')
		const names = (await readdir(directory)).sort(
			(a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]),
		)
		for (const name of names) {
			const path = join(directory, name)
			const value = JSON.parse(await readFile(path, 'utf8'))
			value.schemaVersion = 1
			await writeFile(path, JSON.stringify(value))
		}
		const upgraded = new DiskPalCommunicationStore({ root: f.storeRoot })
		expect((await upgraded.read(f.addressB))?.messages).toHaveLength(1)
		await upgraded.acceptIngress(channel(f), 1)
		const old = new DiskRevisionRecordStore<{ revision: number }>(
			defineSchema({ kind: 'pal-communication', current: 1, migrations: {} }),
			'old reader',
			(r) => r.revision,
		)
		await expect(
			old.read({
				legacyPath: join(f.storeRoot, hash(addressTuple(f.addressB)), 'state.json'),
				revisionsDir: directory,
				publishLegacyProjection: false,
			}),
		).rejects.toThrow()
		expect((await upgraded.readIngress(f.addressB))?.messages).toHaveLength(2)
	})
	it('captures exact factory binding and dependencies before a suspending authorization callback', async () => {
		const f = await fixture()
		const original = await activate(f, channel(f))
		const foreign = await activate(f, observation(f))
		const turn = await f.begin(original)
		const entered = deferred<void>()
		const proceed = deferred<void>()
		const callerBinding = structuredClone(original)
		const callerOptions = {
			...generic(f),
			binding: callerBinding,
			host: { ...f.host },
			authorize: async () => {
				entered.resolve()
				await proceed.promise
				return { allow: true as const, grant: { id: 'captured-current', revision: '1' } }
			},
		}
		const source = createPalIngressInboxSource(callerOptions)
		const claiming = source.claim({
			sessionId: original.sessionId,
			turnId: turn.turnId,
			signal: signal(),
		})
		await entered.promise
		Object.assign(callerBinding, structuredClone(foreign))
		callerOptions.host.openConversation = async () => {
			throw new Error('Changed host dependency')
		}
		Reflect.set(callerOptions, 'authorize', async () => ({
			allow: false,
			reason: 'Changed caller callback',
		}))
		proceed.resolve()
		const claims = await claiming
		expect(claims).toHaveLength(1)
		const rows = (await f.store.readIngress(f.addressB))?.messages
		expect(rows?.[0]).toMatchObject({
			kind: 'channel',
			routeId: original.id,
			phase: 'claimed',
			claim: { sessionId: original.sessionId },
		})
		expect(rows?.[1]).toMatchObject({ kind: 'observation', routeId: foreign.id, phase: 'pending' })
		await source.recorded([
			await f.appendClaim(original, turn.turnId, claims[0] as InboundDeliveryClaim),
		])
		expect((await f.store.readIngress(f.addressB))?.messages[0]?.phase).toBe('recorded')
	})
	it('recovers mixed original delivery evidence after compaction and forbids a forged cross-kind receipt', async () => {
		const f = await fixture()
		const binding = await activate(f, observation(f))
		const turn = await f.begin(binding)
		const options = { ...generic(f), binding, host: f.host }
		const source = createPalIngressInboxSource(options)
		const [claim] = await source.claim({
			sessionId: binding.sessionId,
			turnId: turn.turnId,
			signal: signal(),
		})
		if (!claim) throw new Error('Missing observation claim')
		const receipt = await f.appendClaim(binding, turn.turnId, claim)
		await turn.log.append(turn.lease, {
			type: 'compaction',
			turnId: turn.turnId,
			compactionId: 'mixed-input-compaction',
			strategy: 'summarize',
			trigger: 'manual',
			tokensBefore: 100,
			tokensAfter: 1,
			replacesSeqRange: [1, receipt.through.pointer.seq],
			summary: [{ role: 'system', content: 'Summary only' }],
			keptMessageIds: [],
		})
		expect((await turn.log.messages()).some((m) => m.content === claim.message.content)).toBe(false)
		const reopened = new DiskPalCommunicationStore({ root: f.storeRoot })
		const recovered = createPalIngressInboxSource({ ...options, store: reopened })
		expect(
			await recovered.claim({
				sessionId: binding.sessionId,
				turnId: turn.turnId,
				signal: signal(),
			}),
		).toEqual([])
		expect((await reopened.readIngress(f.addressB))?.messages[0]?.phase).toBe('recorded')
		expect(
			(await turn.log.readAll()).entries.filter((e) => e.record.type === 'message'),
		).toHaveLength(1)
	})
	it('retains one shared unresolved claim until complete stopped/fenced evidence permits release', async () => {
		const f = await fixture()
		const binding = await activate(f, channel(f))
		const other = await activate(f, observation(f))
		const turn = await f.begin(binding)
		const source = createPalIngressInboxSource({ ...generic(f), binding, host: f.host })
		await source.claim({ sessionId: binding.sessionId, turnId: turn.turnId, signal: signal() })
		const message = (await f.store.readIngress(f.addressB))?.messages[0]
		if (!message) throw new Error('Missing claimed channel input')
		expect(
			await f.store.claimIngress(other, {
				turnId: generateTurnId(),
				generation: turn.lease.fence,
				content: () => '',
			}),
		).toBeNull()
		const context = {
			binding,
			access: await f.host.openConversation(binding, signal()),
			definition: f.b,
		}
		await expect(f.store.releaseUnrecordedIngress(message, context)).rejects.toThrow(
			'fenced and stopped',
		)
		await turn.log.release(turn.lease)
		const replacement = await turn.log.claim({ holder: 'shared-recovery', ttlMs: 60000, now: 100 })
		if (!replacement) throw new Error('Missing replacement writer')
		await expect(f.store.releaseUnrecordedIngress(message, context)).rejects.toThrow(
			'fenced and stopped',
		)
		await turn.log.abandonTurn(replacement, turn.turnId, 'Verified recovery')
		const restarted = new DiskPalCommunicationStore({ root: f.storeRoot })
		expect((await restarted.releaseUnrecordedIngress(message, context)).phase).toBe('pending')
		expect((await restarted.readIngress(f.addressB))?.messages.map((m) => m.phase)).toEqual([
			'pending',
			'pending',
		])
		expect(
			await restarted.claimIngress(other, {
				turnId: generateTurnId(),
				generation: replacement.fence,
				content: () => 'Authorized observation context',
			}),
		).toMatchObject({ kind: 'observation', phase: 'claimed' })
	})
	it('dispatches each family using its own current wake/delivery policy and original root', async () => {
		const f = await fixture()
		await f.store.acceptIngress(channel(f), 1)
		await f.store.acceptIngress(observation(f), 1)
		await f.prepare()
		const phases: string[] = []
		const options = {
			...generic(f),
			authorize: async (request: Parameters<PalIngressOptions['authorize']>[0]) => {
				phases.push(`${'kind' in request ? request.kind : 'pal'}:${request.phase}`)
				return { allow: true as const, grant: { id: 'explicit-per-family', revision: '1' } }
			},
		}
		for (let count = 0; count < 3; count++)
			expect((await dispatchPalIngressOnce(options, f.addressB, signal())).status).toBe('ran')
		expect(phases).toEqual([
			'channel:wake',
			'channel:wake',
			'channel:deliver',
			'observation:wake',
			'observation:wake',
			'observation:deliver',
			'pal:wake',
			'pal:wake',
			'pal:deliver',
		])
		expect((await f.store.readIngress(f.addressB))?.messages.map((m) => m.phase)).toEqual([
			'recorded',
			'recorded',
			'recorded',
		])
		expect(await dispatchPalIngressOnce(options, f.addressB, signal())).toEqual({
			status: 'idle',
			reason: 'empty',
		})
	})
	it('rejects rewritten channel actor metadata even when a custom store keeps a real delivery receipt', async () => {
		const f = await fixture()
		const binding = await activate(f, channel(f))
		const turn = await f.begin(binding)
		const source = createPalIngressInboxSource({ ...generic(f), binding, host: f.host })
		const [claim] = await source.claim({
			sessionId: binding.sessionId,
			turnId: turn.turnId,
			signal: signal(),
		})
		if (!claim) throw new Error('Missing channel claim')
		const receipt = await f.appendClaim(binding, turn.turnId, claim)
		const message = (await f.store.readIngress(f.addressB))?.messages[0]
		if (!message || !('kind' in message) || message.kind !== 'channel')
			throw new Error('Missing channel input')
		const changed = { ...message, source: { ...message.source, actorId: 'forged-actor' } }
		await expect(
			verifyIngressRecorded(changed, receipt, {
				binding,
				access: await f.host.openConversation(binding, signal()),
				definition: f.b,
			}),
		).rejects.toThrow('Invalid immutable')
		await verifyIngressRecorded(message, receipt, {
			binding,
			access: await f.host.openConversation(binding, signal()),
			definition: f.b,
		})
	})
	it('retains an uncertain new-family claim when original evidence has a torn suffix', async () => {
		const f = await fixture()
		const binding = await activate(f, channel(f))
		const turn = await f.begin(binding)
		const options = { ...generic(f), binding, host: f.host }
		const source = createPalIngressInboxSource(options)
		const [claim] = await source.claim({
			sessionId: binding.sessionId,
			turnId: turn.turnId,
			signal: signal(),
		})
		if (!claim) throw new Error('Missing channel claim')
		const receipt = await f.appendClaim(binding, turn.turnId, claim)
		await appendFile(join(f.root, 'logs', `${binding.sessionId}.jsonl`), '{"torn":')
		await expect(source.recorded([receipt])).rejects.toThrow('incomplete')
		const message = (await f.store.readIngress(f.addressB))?.messages[0]
		if (!message) throw new Error('Missing channel input')
		await expect(reconcilePalIngressDelivery(options, message, signal())).rejects.toThrow(
			'incomplete',
		)
		expect((await f.store.readIngress(f.addressB))?.messages[0]?.phase).toBe('claimed')
	})
})
