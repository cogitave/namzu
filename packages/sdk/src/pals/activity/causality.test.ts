import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockLLMProvider } from '../../provider/mock.js'
import { drainQuery } from '../../runtime/query/index.js'
import { DiskLogMedium, DiskSessionLog } from '../../store/session-log/disk.js'
import type { SessionLease } from '../../store/session-log/lease.js'
import { autoApproveHandler } from '../../types/hitl/index.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import { stableDigest } from '../../utils/hash.js'
import {
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../utils/id.js'
import { createPalIngressInboxSource } from '../communication/ingress-inbound.js'
import type {
	PalIngressHostPort,
	PalIngressRouteBinding,
	PalIngressStore,
} from '../communication/ingress-types.js'
import { DiskPalCommunicationStore } from '../communication/store.js'
import { DiskPalStore } from '../store.js'
import type { PalDefinition } from '../types.js'
import {
	PalActivityCausalityUnavailableError,
	createPalActivityCausalityResolver,
} from './causality.js'
import { createPalActivitySource } from './source.js'
import { DiskPalActivitySubscriptionStore } from './subscription-store.js'
import { publishPalActivityOnce } from './subscriptions.js'
import type { PalActivityScope } from './types.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const signal = () => new AbortController().signal
const limits = () => ({ signal: signal(), maxReadBytes: 128 * 1024, maxRecords: 128 })
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-activity-causality-')))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const pals = new DiskPalStore({ root: join(root, 'pals'), workspaceRoot: join(root, 'controls') })
	const first = pals.create({ name: 'First' })
	const other = pals.create({ name: 'Other' })
	const tenantId = generateTenantId()
	const projectId = generateProjectId()
	const topicId = generateTopicId()
	const ingress = new DiskPalCommunicationStore({ root: join(root, 'inbox') })
	const subscriptions = new DiskPalActivitySubscriptionStore({ root: join(root, 'subscriptions') })
	const journals = new Map<
		SessionId,
		{ log: DiskSessionLog; bytes: DiskLogMedium; lease: SessionLease; scope: PalActivityScope }
	>()
	async function owned(pal: PalDefinition, id: SessionId = generateSessionId()) {
		const existing = journals.get(id)
		if (existing) return existing
		const file = join(root, 'logs', `${id}.jsonl`)
		const log = new DiskSessionLog({
			sessionId: id,
			file,
			sessionDir: join(root, 'logs', id),
			now: () => 100,
			sync: 'all',
		})
		const lease = await log.claim({ holder: 'fixture', now: 100, ttlMs: 60_000 })
		if (!lease) throw new Error('Missing actual fixture writer')
		cleanups.push(() => log.release(lease))
		const scope = {
			tenantId,
			projectId,
			palId: pal.id,
			profileRevision: pal.revision,
			sessionId: id,
		}
		await log.append(lease, {
			type: 'session_started',
			tenantId,
			projectId,
			topicId,
			cwd: pal.workspace,
			agent: { id: pal.id, name: pal.name },
			origin: {
				protocol: 'desktop',
				externalSessionId: JSON.stringify(['namzu-pal', pal.id, pal.revision, id]),
			},
		})
		const result = { log, bytes: new DiskLogMedium(file), lease, scope }
		journals.set(id, result)
		return result
	}
	const initial = await owned(other)
	const openJournal = async (scope: PalActivityScope) => {
		const journal = journals.get(scope.sessionId)
		if (!journal) throw new Error('Unknown original journal')
		return journal
	}
	const authorize = vi.fn(async () => true)
	const resolverOptions = {
		pals,
		ingress,
		openJournal,
		authorize,
		maxReadBytes: 128 * 1024,
		maxRecords: 128,
	}
	const resolver = createPalActivityCausalityResolver(resolverOptions)
	const host: PalIngressHostPort = {
		ensureConversation: async (binding) => {
			await owned(
				pals.getRevision(binding.key.recipient.palId, binding.profileRevision),
				binding.sessionId,
			)
		},
		openConversation: async (binding) => {
			const journal = journals.get(binding.sessionId)
			if (!journal) throw new Error('Unknown owned journal')
			return { log: journal.log, projectId }
		},
		runConversation: async () => {
			throw new Error('This deterministic fixture runs no model or guest')
		},
	}
	const messagePolicy = async () => ({
		allow: true as const,
		grant: { id: 'explicit-fixture', revision: '1' },
	})
	async function begin(journal: Awaited<ReturnType<typeof owned>>) {
		const turnId = generateTurnId()
		await journal.log.beginTurn(journal.lease, {
			turnId,
			userMessageId: generateMessageId(),
			config: { model: 'fixture', tokenBudget: 0, timeoutMs: 60_000 },
		})
		return turnId
	}
	async function marker(
		journal: Awaited<ReturnType<typeof owned>>,
		turnId: TurnId,
		digest = stableDigest([]),
	) {
		await journal.log.append(journal.lease, {
			type: 'request_envelope',
			turnId,
			iteration: 1,
			model: 'fixture',
			systemPrompt: '',
			toolNames: [],
			toolSchemaDigest: digest,
		})
	}
	async function complete(journal: Awaited<ReturnType<typeof owned>>, turnId: TurnId) {
		await journal.log.append(journal.lease, {
			type: 'turn_completed',
			turnId,
			result: 'Fixture work complete',
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
		})
	}
	async function facts(scope: PalActivityScope) {
		return (
			await createPalActivitySource({ scope, pals, openJournal, authorize: async () => true }).read(
				limits(),
			)
		).facts
	}
	async function worker(input: PalIngressRouteBinding) {
		await host.ensureConversation(input, signal())
		const journal = journals.get(input.sessionId)
		if (!journal) throw new Error('Missing owned worker journal')
		const access = await host.openConversation(input, signal())
		const binding = await ingress.activateIngress(input, {
			binding: input,
			access,
			definition: pals.getRevision(input.key.recipient.palId, input.profileRevision),
		})
		const turnId = await begin(journal)
		const source = createPalIngressInboxSource({
			binding,
			store: ingress,
			pals,
			host,
			authorize: messagePolicy,
		})
		const count =
			(await ingress.readIngress(binding.key.recipient))?.messages.filter(
				(message) => message.phase === 'pending' && message.routeId === binding.id,
			).length ?? 0
		for (let index = 0; index < count; index++) {
			const claims = await source.claim({ sessionId: binding.sessionId, turnId, signal: signal() })
			const claim = claims[0]
			if (!claim) throw new Error('Missing exact worker claim')
			const messageId = generateMessageId()
			await journal.log.append(journal.lease, {
				type: 'message',
				turnId,
				messageId,
				role: 'user',
				kind: 'context',
				content: claim.message,
			})
			const through = await journal.log.head()
			if (!through) throw new Error('Missing flushed worker head')
			await source.recorded([
				{
					claimId: claim.claimId,
					ref: claim.ref,
					sessionId: binding.sessionId,
					turnId,
					messageId,
					through,
				},
			])
		}
		await marker(journal, turnId)
		await complete(journal, turnId)
		return journal
	}
	async function published() {
		const turnId = await begin(initial)
		await marker(initial, turnId)
		await complete(initial, turnId)
		const subscription = await subscriptions.create({
			id: randomUUID(),
			scope: initial.scope,
			recipient: { tenantId, palId: first.id },
			enabled: true,
		})
		const publicationOptions = {
			subscriptions,
			ingress,
			pals,
			openJournal,
			authorize: messagePolicy,
			resolveCausality: resolver,
			now: () => 100,
		}
		await publishPalActivityOnce(publicationOptions, subscription.id, limits())
		const binding = (await ingress.readIngress({ tenantId, palId: first.id }))?.routes[0]
		if (!binding) throw new Error('Missing actual observation route')
		const journal = await worker(binding)
		const fact = (await facts(journal.scope)).find((candidate) => candidate.type === 'turn_started')
		if (!fact) throw new Error('Missing original activity fact')
		return { subscription, journal, fact, publicationOptions, binding }
	}
	return {
		root,
		pals,
		first,
		other,
		tenantId,
		projectId,
		topicId,
		ingress,
		subscriptions,
		initial,
		openJournal,
		authorize,
		resolverOptions,
		resolver,
		host,
		begin,
		marker,
		complete,
		facts,
		worker,
		published,
		messagePolicy,
	}
}

describe('bounded original activity causality', () => {
	it('accepts the actual request envelope written by an SDK query before publishing its original activity', async () => {
		const f = await fixture()
		await f.initial.log.release(f.initial.lease)
		const provider = new MockLLMProvider({ turns: [{ text: 'Original query complete' }] })
		const result = await drainQuery({
			provider,
			toolsets: [],
			sessionLog: f.initial.log,
			resumeHandler: autoApproveHandler,
			agentId: f.other.id,
			agentName: f.other.name,
			sessionId: f.initial.scope.sessionId,
			topicId: f.topicId,
			projectId: f.projectId,
			tenantId: f.tenantId,
			workingDirectory: f.other.workspace,
			messages: [createUserMessage('Complete independent fixture work')],
			turnConfig: { model: 'mock', maxIterations: 6, tokenBudget: 0, timeoutMs: 0 },
		})
		expect(result.status).toBe('completed')
		expect(provider.requests).toHaveLength(1)
		const records = await f.initial.log.readAll()
		const request = records.entries.find((entry) => entry.record.type === 'request_envelope')
		expect(request?.record).toMatchObject({ toolSchemaDigest: stableDigest([]) })
		const fact = (await f.facts(f.initial.scope)).find((entry) => entry.type === 'turn_started')
		if (!fact) throw new Error('Missing actual query activity fact')
		expect(await f.resolver(f.initial.scope, fact, signal())).toEqual([])
		const subscription = await f.subscriptions.create({
			id: randomUUID(),
			scope: f.initial.scope,
			recipient: { tenantId: f.tenantId, palId: f.first.id },
			enabled: true,
		})
		const published = await publishPalActivityOnce(
			{
				subscriptions: f.subscriptions,
				ingress: f.ingress,
				pals: f.pals,
				openJournal: f.openJournal,
				authorize: f.messagePolicy,
				resolveCausality: f.resolver,
			},
			subscription.id,
			limits(),
		)
		expect(published.accepted.length).toBeGreaterThan(0)
	})
	it('proves independence only after a valid initial intake marker and rejects missing/malformed markers', async () => {
		const f = await fixture()
		const turn = await f.begin(f.initial)
		const fact = (await f.facts(f.initial.scope))[0]
		if (!fact) throw new Error('Missing original fact')
		await expect(f.resolver(f.initial.scope, fact, signal())).rejects.toBeInstanceOf(
			PalActivityCausalityUnavailableError,
		)
		await f.marker(f.initial, turn)
		expect(await f.resolver(f.initial.scope, fact, signal())).toEqual([])
		const bad = await fixture()
		const badTurn = await bad.begin(bad.initial)
		await bad.marker(bad.initial, badTurn, 'not-a-digest')
		const badFact = (await bad.facts(bad.initial.scope))[0]
		if (!badFact) throw new Error('Missing bad original fact')
		await expect(bad.resolver(bad.initial.scope, badFact, signal())).rejects.toBeInstanceOf(
			PalActivityCausalityUnavailableError,
		)
	})
	it('resolves actual recorded observation lineage through the bounded original journal', async () => {
		const f = await fixture()
		const p = await f.published()
		expect(await f.resolver(p.journal.scope, p.fact, signal())).toEqual([p.subscription.id])
	})
	it.each(['trail', 'pointer', 'generation', 'bytes'] as const)(
		'rejects rewritten %s evidence even when a custom store reports recorded',
		async (field) => {
			const f = await fixture()
			const p = await f.published()
			const read = f.ingress.readIngress.bind(f.ingress)
			vi.spyOn(f.ingress, 'readIngress').mockImplementationOnce(async (recipient) => {
				const state = structuredClone(await read(recipient))
				const message = state?.messages.find(
					(candidate) => 'kind' in candidate && candidate.kind === 'observation',
				)
				if (!message || !('kind' in message) || message.kind !== 'observation' || !message.receipt)
					throw new Error('Missing recorded fixture')
				if (field === 'trail')
					Object.assign(message, {
						subscriptionTrail: [...message.subscriptionTrail, randomUUID()],
					})
				if (field === 'pointer')
					Object.assign(message.receipt.through.pointer, { sha256: 'f'.repeat(64) })
				if (field === 'generation')
					Object.assign(message.receipt.through, { gen: message.receipt.through.gen + 1 })
				if (field === 'bytes')
					Object.assign(message.receipt.through, { bytes: message.receipt.through.bytes + 1 })
				return state
			})
			await expect(f.resolver(p.journal.scope, p.fact, signal())).rejects.toBeInstanceOf(
				PalActivityCausalityUnavailableError,
			)
		},
	)
	it.each([undefined, 'unknown-namespace'])(
		'does not classify host observations with ref namespace %s as independent',
		async (namespace) => {
			const f = await fixture()
			const turn = await f.begin(f.initial)
			await f.initial.log.append(f.initial.lease, {
				type: 'message',
				turnId: turn,
				messageId: generateMessageId(),
				role: 'user',
				kind: 'context',
				content: {
					role: 'user',
					content: 'Unknown host observation',
					source: {
						type: 'runtime-context',
						kind: 'host-observation',
						...(namespace
							? { deliveryRef: { namespace, id: '0'.repeat(64), digest: '1'.repeat(64) } }
							: {}),
					},
				},
			})
			await f.marker(f.initial, turn)
			const fact = (await f.facts(f.initial.scope))[0]
			if (!fact) throw new Error('Missing original fact')
			await expect(f.resolver(f.initial.scope, fact, signal())).rejects.toBeInstanceOf(
				PalActivityCausalityUnavailableError,
			)
		},
	)
	it('rejects exhausted byte/record budgets and revocation during original bytes read', async () => {
		const f = await fixture()
		const p = await f.published()
		await expect(
			createPalActivityCausalityResolver({ ...f.resolverOptions, maxReadBytes: 1 })(
				p.journal.scope,
				p.fact,
				signal(),
			),
		).rejects.toBeInstanceOf(PalActivityCausalityUnavailableError)
		await expect(
			createPalActivityCausalityResolver({ ...f.resolverOptions, maxRecords: 1 })(
				p.journal.scope,
				p.fact,
				signal(),
			),
		).rejects.toBeInstanceOf(PalActivityCausalityUnavailableError)
		const read = p.journal.bytes.read.bind(p.journal.bytes)
		vi.spyOn(p.journal.bytes, 'read').mockImplementationOnce(async (...args) => {
			const raw = await read(...args)
			f.authorize.mockResolvedValue(false)
			return raw
		})
		await expect(f.resolver(p.journal.scope, p.fact, signal())).rejects.toBeInstanceOf(
			PalActivityCausalityUnavailableError,
		)
	})
	it('suppresses a real two-stage observation feedback path when its publishing subscription returns', async () => {
		const f = await fixture()
		const p = await f.published()
		const second = await f.subscriptions.create({
			id: randomUUID(),
			scope: p.journal.scope,
			recipient: { tenantId: f.tenantId, palId: f.other.id },
			enabled: true,
		})
		// This trusted fixture explicitly reuses the original owned Pal conversation. It does not open a foreign UUID.
		const routed: PalIngressStore = {
			readIngress: f.ingress.readIngress.bind(f.ingress),
			routeIngress: f.ingress.routeIngress.bind(f.ingress),
			activateIngress: f.ingress.activateIngress.bind(f.ingress),
			claimIngress: f.ingress.claimIngress.bind(f.ingress),
			recordedIngress: f.ingress.recordedIngress.bind(f.ingress),
			releaseUnrecordedIngress: f.ingress.releaseUnrecordedIngress.bind(f.ingress),
			acceptIngress: (intent, revision) =>
				f.ingress.acceptIngress(intent, revision, f.initial.scope.sessionId),
		}
		await publishPalActivityOnce({ ...p.publicationOptions, ingress: routed }, second.id, limits())
		const binding = (await f.ingress.readIngress(second.recipient))?.routes[0]
		if (!binding) throw new Error('Missing actual return route')
		await f.worker(binding)
		const before = (await f.ingress.readIngress(p.subscription.recipient))?.messages.length
		const result = await publishPalActivityOnce(p.publicationOptions, p.subscription.id, limits())
		expect(result.accepted).toEqual([])
		expect(result.suppressed.length).toBeGreaterThan(0)
		expect((await f.ingress.readIngress(p.subscription.recipient))?.messages).toHaveLength(
			before ?? 0,
		)
	})
})
