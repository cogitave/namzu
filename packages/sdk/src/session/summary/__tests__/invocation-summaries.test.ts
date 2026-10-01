import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { StaleSessionError, TenantIsolationError } from '../../../session/errors.js'
import { DiskSessionStore } from '../../../store/session/disk.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import type { SessionId, TenantId, TurnId, UserId } from '../../../types/ids/index.js'
import type { TopicId } from '../../../types/session/ids.js'
import type { SessionStore } from '../../../types/session/store.js'
import { generateSummaryId, generateTurnId } from '../../../utils/id.js'
import { SessionAlreadySummarizedError } from '../errors.js'
import { SessionSummaryMaterializer } from '../materialize.js'

const tenant = '47e0fdf4-8745-4f36-a87a-a7312f53ace3' as TenantId
const otherTenant = 'b25f5420-55dd-4c74-8e43-ef4e72dcd54f' as TenantId
const topic = '04b13d36-bddc-42a1-b6e5-f477343fdf69' as TopicId
const dirs: string[] = []
afterEach(async () => {
	for (const dir of dirs.splice(0)) await removeTempDirAsync(dir)
})

describe.each(['memory', 'disk'] as const)('%s invocation summaries', (kind) => {
	async function fixture() {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-invocation-summary-'))
		dirs.push(directory)
		const store =
			kind === 'memory' ? new InMemorySessionStore() : new DiskSessionStore({ rootDir: directory })
		const project = await store.createProject({ tenantId: tenant, name: 'invocations' }, tenant)
		const session = await store.createSession(
			{
				projectId: project.id,
				topicId: topic,
				currentActor: {
					kind: 'user',
					tenantId: tenant,
					userId: '0c673c14-5d1d-46b1-bb92-547fd88de0b9' as UserId,
				},
			},
			tenant,
		)
		await store.updateSession({ ...session, status: 'active' }, tenant)
		const materializer = new SessionSummaryMaterializer({ store, generateSummaryId })
		const input = {
			sessionId: session.id,
			tenantId: tenant,
			finalOutcome: { status: 'succeeded' as const },
			agentSummary: 'conversation completion',
			declaredDeliverables: [],
			keyDecisions: [],
		}
		return { directory, store, session, materializer, input }
	}

	it('seals fresh invocation summaries without overwriting the conversation or another invocation', async () => {
		const h = await fixture()
		const original = await h.materializer.materialize(h.input)
		await h.store.updateSession({ ...h.session, status: 'active' }, tenant)
		const turnId = generateTurnId()
		const current = await h.materializer.materialize({
			...h.input,
			turnId,
			agentSummary: 'follow-up completion',
		})
		expect(current.turnRef).toBe(turnId)
		expect(current.id).not.toBe(original.id)
		expect(await h.store.getSummary(h.session.id, tenant)).toEqual(original)
		expect(await h.store.getSummary(h.session.id, tenant, turnId)).toEqual(current)
		expect((await h.store.getSession(h.session.id, tenant))?.status).toBe('idle')
		await expect(
			h.materializer.materialize({ ...h.input, turnId, agentSummary: 'replace completion' }),
		).rejects.toBeInstanceOf(SessionAlreadySummarizedError)
		await expect(h.materializer.materialize(h.input)).rejects.toBeInstanceOf(
			SessionAlreadySummarizedError,
		)
		const nextTurn = generateTurnId()
		expect(await h.store.getSummary(h.session.id, tenant, nextTurn)).toBeNull()
		const next = await h.materializer.materialize({
			...h.input,
			turnId: nextTurn,
			agentSummary: 'third completion',
		})
		expect(next.id).not.toBe(current.id)
		expect(await h.store.getSummary(h.session.id, tenant, turnId)).toEqual(current)
		if (kind === 'disk') {
			const reopened = new DiskSessionStore({ rootDir: h.directory })
			expect(await reopened.getSummary(h.session.id, tenant)).toEqual(original)
			expect(await reopened.getSummary(h.session.id, tenant, turnId)).toEqual(current)
		}
	})

	it('refuses owner-version changes before sealing a summary or idling its new owner', async () => {
		const h = await fixture()
		const turnId = generateTurnId()
		await h.store.updateSession({ ...h.session, ownerVersion: 1, status: 'active' }, tenant, 0)
		await expect(
			h.materializer.materialize({ ...h.input, turnId, expectedOwnerVersion: 0 }),
		).rejects.toBeInstanceOf(StaleSessionError)
		expect(await h.store.getSummary(h.session.id, tenant, turnId)).toBeNull()
		expect(await h.store.getSession(h.session.id, tenant)).toMatchObject({
			ownerVersion: 1,
			status: 'active',
		})
		await expect(
			h.store.recordSummary(
				{
					id: generateSummaryId(),
					sessionRef: h.session.id,
					turnRef: turnId,
					tenantId: tenant,
					outcome: { status: 'succeeded' },
					deliverables: [],
					agentSummary: 'stale result',
					keyDecisions: [],
					at: new Date(),
					materializedBy: 'kernel',
				},
				tenant,
				0,
			),
		).rejects.toBeInstanceOf(StaleSessionError)
		expect(await h.store.getSummary(h.session.id, tenant, turnId)).toBeNull()
	})

	it('serializes competing owner CAS writes, including two disk store instances', async () => {
		const h = await fixture()
		const second = kind === 'disk' ? new DiskSessionStore({ rootDir: h.directory }) : h.store
		const outcomes = await Promise.allSettled([
			h.store.updateSession({ ...h.session, ownerVersion: 1, status: 'active' }, tenant, 0),
			second.updateSession({ ...h.session, ownerVersion: 2, status: 'active' }, tenant, 0),
		])
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
		const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
		expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(
			StaleSessionError,
		)
		expect((await h.store.getSession(h.session.id, tenant))?.ownerVersion).toBe(1)
	})

	it('shares the writer guard between takeover and summary status mutation', async () => {
		const h = await fixture()
		const turnId = generateTurnId()
		const summary = {
			id: generateSummaryId(),
			sessionRef: h.session.id,
			turnRef: turnId,
			tenantId: tenant,
			outcome: { status: 'succeeded' as const },
			deliverables: [],
			agentSummary: 'old owner',
			keyDecisions: [],
			at: new Date(),
			materializedBy: 'kernel' as const,
		}
		const outcomes = await Promise.allSettled([
			h.store.updateSession({ ...h.session, ownerVersion: 1, status: 'active' }, tenant, 0),
			h.store.recordSummary(summary, tenant, 0),
		])
		expect(outcomes[0]?.status).toBe('fulfilled')
		expect(outcomes[1]?.status === 'rejected' ? outcomes[1].reason : undefined).toBeInstanceOf(
			StaleSessionError,
		)
		expect(await h.store.getSession(h.session.id, tenant)).toMatchObject({
			ownerVersion: 1,
			status: 'active',
		})
		expect(await h.store.getSummary(h.session.id, tenant, turnId)).toBeNull()
	})

	it('replays only the requested invocation on recovery and preserves tenant boundaries', async () => {
		const h = await fixture()
		const turnId = generateTurnId()
		const sealed = await h.materializer.materialize({ ...h.input, turnId })
		await h.store.updateSession({ ...h.session, status: 'active' }, tenant)
		expect(await h.materializer.recover(h.session.id, tenant, generateTurnId())).toBeNull()
		expect((await h.store.getSession(h.session.id, tenant))?.status).toBe('active')
		expect(await h.materializer.recover(h.session.id, tenant, turnId)).toEqual(sealed)
		expect((await h.store.getSession(h.session.id, tenant))?.status).toBe('idle')
		await expect(h.store.getSummary(h.session.id, otherTenant, turnId)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
		await expect(
			h.store.getSummary(h.session.id, tenant, '../../outside' as TurnId),
		).rejects.toThrow()
		await h.store.deleteSession(h.session.id, tenant)
		expect(await h.store.getSummary(h.session.id, tenant, turnId)).toBeNull()
	})

	it('fails closed when a host store omits support or claims support but ignores invocation keys', async () => {
		const h = await fixture()
		const unsupported = new Proxy(h.store, {
			get(target, property, receiver) {
				if (property === 'supportsInvocationSummaries') return undefined
				return Reflect.get(target, property, receiver)
			},
		})
		const turnId = generateTurnId()
		const noSupport = new SessionSummaryMaterializer({ store: unsupported, generateSummaryId })
		await expect(noSupport.materialize({ ...h.input, turnId })).rejects.toThrow(
			'does not support invocation',
		)
		await expect(noSupport.recover(h.session.id, tenant, turnId)).rejects.toThrow(
			'does not support invocation',
		)
		expect(await h.store.getSummary(h.session.id, tenant)).toBeNull()
		const legacyOnly = new Proxy(h.store, {
			get(target, property, receiver) {
				if (property === 'getSummary')
					return (id: SessionId, tid: TenantId) => target.getSummary(id, tid)
				if (property === 'recordSummary')
					return (...args: Parameters<SessionStore['recordSummary']>) =>
						target.recordSummary({ ...args[0], turnRef: undefined }, args[1])
				return Reflect.get(target, property, receiver)
			},
		})
		const lies = new SessionSummaryMaterializer({ store: legacyOnly, generateSummaryId })
		await expect(lies.materialize({ ...h.input, turnId })).rejects.toThrow(
			'did not preserve the invocation',
		)
		await expect(lies.recover(h.session.id, tenant, turnId)).rejects.toThrow('different invocation')
	})
})
