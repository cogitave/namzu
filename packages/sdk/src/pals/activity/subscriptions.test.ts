import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiskLogMedium, DiskSessionLog } from '../../store/session-log/disk.js'
import {
	generateActivityId,
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../utils/id.js'
import { DiskPalCommunicationStore } from '../communication/store.js'
import { DiskPalStore } from '../store.js'
import { DiskPalActivitySubscriptionPolicy } from './subscription-policy.js'
import {
	DiskPalActivitySubscriptionStore,
	PalActivitySubscriptionConflictError,
} from './subscription-store.js'
import { PalActivitySubscriptionDeniedError, publishPalActivityOnce } from './subscriptions.js'
import type { PalActivitySubscriptionRunnerOptions } from './subscriptions.js'
import type { PalActivityScope } from './types.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const release of cleanup.splice(0).reverse()) await release()
})
const limits = () => ({
	signal: new AbortController().signal,
	maxRecords: 64,
	maxReadBytes: 128 * 1024,
})
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-pal-subscriptions-')))
	cleanup.push(() => rm(root, { recursive: true, force: true }))
	const pals = new DiskPalStore({
		root: join(root, 'pals'),
		workspaceRoot: join(root, 'workspaces'),
	})
	const observed = pals.create({
		name: 'Observed',
		purpose: 'PRIVATE PURPOSE',
	})
	const receiver = pals.create({ name: 'Receiver' })
	const scope: PalActivityScope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		palId: observed.id,
		profileRevision: 1,
		sessionId: generateSessionId(),
	}
	const recipient = { tenantId: scope.tenantId, palId: receiver.id }
	const file = join(root, 'journal.jsonl')
	const log = new DiskSessionLog({
		sessionId: scope.sessionId,
		file,
		sessionDir: join(root, 'journal'),
		now: () => 100,
		sync: 'all',
	})
	const lease = await log.claim({
		holder: 'subscription-test',
		now: 100,
		ttlMs: 60_000,
	})
	if (!lease) throw new Error('Missing fixture writer.')
	cleanup.push(() => log.release(lease))
	await log.append(lease, {
		type: 'session_started',
		tenantId: scope.tenantId,
		projectId: scope.projectId,
		cwd: observed.workspace,
		agent: { id: observed.id, name: observed.name },
		origin: {
			protocol: 'desktop',
			externalSessionId: JSON.stringify(['namzu-pal', observed.id, 1, scope.sessionId]),
		},
	})
	const turnId = generateTurnId()
	await log.beginTurn(lease, {
		turnId,
		userMessageId: generateMessageId(),
		systemPrompt: 'PRIVATE PROMPT',
		config: { model: 'fixture', tokenBudget: 0, timeoutMs: 60_000 },
	})
	await log.append(lease, {
		type: 'activity_created',
		turnId,
		activityId: generateActivityId(),
		activityType: 'tool_call',
		description: 'PRIVATE TOOL DESCRIPTION',
	})
	const subscriptions = new DiskPalActivitySubscriptionStore({
		root: join(root, 'subscriptions'),
	})
	const subscription = await subscriptions.create({
		id: randomUUID(),
		scope,
		recipient,
		enabled: true,
	})
	const ingress = new DiskPalCommunicationStore({ root: join(root, 'inbox') })
	const authorize = vi.fn(async () => ({
		allow: true as const,
		grant: { id: 'fixture-grant', revision: '1' },
	}))
	const openJournal = vi.fn(async () => ({
		log,
		bytes: new DiskLogMedium(file),
	}))
	const resolveCausality = vi.fn(async () => [] as string[])
	const options: PalActivitySubscriptionRunnerOptions = {
		subscriptions,
		ingress,
		pals,
		authorize,
		openJournal,
		resolveCausality,
		now: () => 100,
	}
	return {
		root,
		pals,
		observed,
		receiver,
		scope,
		recipient,
		subscription,
		subscriptions,
		ingress,
		options,
		authorize,
		openJournal,
		resolveCausality,
	}
}

describe('durable authorized activity publication', () => {
	it('accepts closed host observations before committing the cursor and survives a new store instance', async () => {
		const f = await fixture()
		const publication = await publishPalActivityOnce(f.options, f.subscription.id, limits())
		expect(publication.accepted).toHaveLength(2)
		const state = await f.ingress.readIngress(f.recipient)
		expect(state?.messages.map((m) => ('kind' in m ? m.kind : 'peer'))).toEqual([
			'observation',
			'observation',
		])
		expect(JSON.stringify(state)).not.toContain('PRIVATE')
		expect(state?.messages.map((m) => m.ordinal)).toEqual([1, 2])
		expect(state?.routes).toHaveLength(1)
		const restarted = new DiskPalActivitySubscriptionStore({
			root: join(f.root, 'subscriptions'),
		})
		const again = await publishPalActivityOnce(
			{ ...f.options, subscriptions: restarted },
			f.subscription.id,
			limits(),
		)
		expect(again.accepted).toEqual([])
		expect(again.subscription.cursor).toEqual(publication.subscription.cursor)
		expect((await f.ingress.readIngress(f.recipient))?.messages).toHaveLength(2)
		expect(
			f.authorize.mock.calls.map((call) => (call as unknown as [{ phase: string }])[0].phase),
		).toEqual(expect.arrayContaining(['observe', 'disclose', 'receive']))
	})
	it('replays an incompletely accepted page with stable IDs instead of skipping or duplicating it', async () => {
		const f = await fixture()
		const original = f.ingress.acceptIngress.bind(f.ingress)
		let calls = 0
		vi.spyOn(f.ingress, 'acceptIngress').mockImplementation(async (...args) => {
			if (++calls === 2) throw new Error('recipient commit failed')
			return original(...args)
		})
		await expect(publishPalActivityOnce(f.options, f.subscription.id, limits())).rejects.toThrow(
			'recipient commit failed',
		)
		expect((await f.subscriptions.get(f.subscription.id))?.cursor).toBeNull()
		expect((await f.ingress.readIngress(f.recipient))?.messages).toHaveLength(1)
		await publishPalActivityOnce(f.options, f.subscription.id, limits())
		expect((await f.ingress.readIngress(f.recipient))?.messages).toHaveLength(2)
		expect((await f.subscriptions.get(f.subscription.id))?.cursor).not.toBeNull()
	})
	it('retains accepted messages and the old cursor when progress publication fails', async () => {
		const f = await fixture()
		vi.spyOn(f.subscriptions, 'advance').mockRejectedValueOnce(new Error('progress write failed'))
		await expect(publishPalActivityOnce(f.options, f.subscription.id, limits())).rejects.toThrow(
			'progress write failed',
		)
		expect((await f.subscriptions.get(f.subscription.id))?.cursor).toBeNull()
		await publishPalActivityOnce(f.options, f.subscription.id, limits())
		expect((await f.ingress.readIngress(f.recipient))?.messages).toHaveLength(2)
	})
	for (const deniedPhase of ['observe', 'disclose', 'receive', 'accept'] as const) {
		it(`requires independent current ${deniedPhase} permission`, async () => {
			const f = await fixture()
			const authorize: PalActivitySubscriptionRunnerOptions['authorize'] = async (request) =>
				request.phase === deniedPhase
					? { allow: false, reason: 'revoked' }
					: { allow: true, grant: { id: request.phase, revision: '1' } }
			await expect(
				publishPalActivityOnce({ ...f.options, authorize }, f.subscription.id, limits()),
			).rejects.toBeInstanceOf(PalActivitySubscriptionDeniedError)
			expect((await f.subscriptions.get(f.subscription.id))?.cursor).toBeNull()
			expect(await f.ingress.readIngress(f.recipient)).toBeNull()
			if (deniedPhase === 'observe') expect(f.openJournal).not.toHaveBeenCalled()
		})
	}
	it.each(['observe', 'disclose'] as const)(
		'rechecks joint acceptance when %s is revoked during recipient authorization',
		async (revokedPermission) => {
			const f = await fixture()
			const policy = new DiskPalActivitySubscriptionPolicy({
				root: join(f.root, 'policy'),
				subscriptions: f.subscriptions,
			})
			const flags = {
				subscriptionId: f.subscription.id,
				observe: true,
				disclose: true,
				receive: true,
				wake: false,
			}
			await policy.update({ ...flags, expectedRevision: 0 })
			const phases: string[] = []
			const authorize: PalActivitySubscriptionRunnerOptions['authorize'] = async (request) => {
				phases.push(request.phase)
				if (request.phase === 'receive') {
					await policy.update({
						...flags,
						expectedRevision: 1,
						[revokedPermission]: false,
					})
				}
				return policy.authorizeSubscription(request)
			}
			await expect(
				publishPalActivityOnce({ ...f.options, authorize }, f.subscription.id, limits()),
			).rejects.toBeInstanceOf(PalActivitySubscriptionDeniedError)
			expect(phases).toEqual(expect.arrayContaining(['disclose', 'receive', 'accept']))
			expect((await policy.get(f.subscription.id))?.[revokedPermission]).toBe(false)
			expect((await f.subscriptions.get(f.subscription.id))?.cursor).toBeNull()
			expect(await f.ingress.readIngress(f.recipient)).toBeNull()
		},
	)
	it('detects revocation during acceptance before publishing progress or a second fact', async () => {
		const f = await fixture()
		const original = f.ingress.acceptIngress.bind(f.ingress)
		vi.spyOn(f.ingress, 'acceptIngress').mockImplementationOnce(async (...args) => {
			const result = await original(...args)
			await f.subscriptions.setEnabled({
				id: f.subscription.id,
				expectedRevision: 1,
				enabled: false,
			})
			return result
		})
		await expect(
			publishPalActivityOnce(f.options, f.subscription.id, limits()),
		).rejects.toBeInstanceOf(PalActivitySubscriptionDeniedError)
		expect((await f.subscriptions.get(f.subscription.id))?.cursor).toBeNull()
		expect((await f.ingress.readIngress(f.recipient))?.messages).toHaveLength(1)
	})
	it('suppresses an observation feedback path without publishing another input', async () => {
		const f = await fixture()
		f.resolveCausality.mockResolvedValue([f.subscription.id])
		const result = await publishPalActivityOnce(f.options, f.subscription.id, limits())
		expect(result.accepted).toEqual([])
		expect(result.suppressed).toHaveLength(2)
		expect(result.subscription.cursor).not.toBeNull()
		expect(await f.ingress.readIngress(f.recipient)).toBeNull()
	})
	it('fails closed on unknown causality without advancing the cursor', async () => {
		const f = await fixture()
		f.resolveCausality.mockRejectedValue(new Error('unverified original delivery'))
		await expect(publishPalActivityOnce(f.options, f.subscription.id, limits())).rejects.toThrow(
			'unverified original delivery',
		)
		expect((await f.subscriptions.get(f.subscription.id))?.cursor).toBeNull()
		expect(await f.ingress.readIngress(f.recipient)).toBeNull()
	})
	it('does not await a hanging notification observer', async () => {
		const f = await fixture()
		const notify = vi.fn(() => new Promise<void>(() => {}))
		const result = await publishPalActivityOnce(
			{ ...f.options, notify },
			f.subscription.id,
			limits(),
		)
		expect(result.accepted).toHaveLength(2)
		expect(notify).toHaveBeenCalledTimes(2)
	})
	it('uses exclusive revision publication for competing consent changes', async () => {
		const f = await fixture()
		const other = new DiskPalActivitySubscriptionStore({
			root: join(f.root, 'subscriptions'),
		})
		const outcomes = await Promise.allSettled([
			f.subscriptions.setEnabled({
				id: f.subscription.id,
				expectedRevision: 1,
				enabled: false,
			}),
			other.setEnabled({
				id: f.subscription.id,
				expectedRevision: 1,
				enabled: false,
			}),
		])
		expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
		expect(outcomes.filter((o) => o.status === 'rejected')[0]).toMatchObject({
			reason: expect.any(PalActivitySubscriptionConflictError),
		})
		expect((await other.get(f.subscription.id))?.configurationRevision).toBe(2)
	})
})
