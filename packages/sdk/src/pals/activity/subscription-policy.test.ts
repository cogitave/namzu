import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../utils/id.js'
import type { PalIngressAuthorizationRequest } from '../communication/ingress-types.js'
import {
	DiskPalActivitySubscriptionPolicy,
	PalActivitySubscriptionPermissionConflictError,
} from './subscription-policy.js'
import { DiskPalActivitySubscriptionStore } from './subscription-store.js'

const temporary: string[] = []
afterEach(async () => {
	for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-observation-policy-')))
	temporary.push(root)
	const tenantId = generateTenantId()
	const subscriptions = new DiskPalActivitySubscriptionStore({ root: join(root, 'subscriptions') })
	const subscription = await subscriptions.create({
		id: randomUUID(),
		enabled: true,
		scope: {
			tenantId,
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			palId: randomUUID(),
			profileRevision: 1,
		},
		recipient: { tenantId, palId: randomUUID() },
	})
	const policy = new DiskPalActivitySubscriptionPolicy({
		root: join(root, 'policy'),
		subscriptions,
	})
	const flags = {
		subscriptionId: subscription.id,
		observe: true,
		disclose: true,
		receive: true,
		wake: false,
	}
	const request: PalIngressAuthorizationRequest = {
		kind: 'observation',
		phase: 'deliver',
		source: {
			kind: 'host-observation',
			subscriptionId: subscription.id,
			scope: subscription.scope,
		},
		recipient: subscription.recipient,
		routeKey: {
			v: 1,
			kind: 'observation',
			recipient: subscription.recipient,
			subscriptionId: subscription.id,
			scope: subscription.scope,
		},
		replyTo: null,
		fact: {
			id: '0'.repeat(64),
			type: 'turn_started',
			sessionId: subscription.scope.sessionId,
			turnId: generateTurnId(),
			seq: 2,
			generation: 1,
			at: '2026-10-02T00:00:00.000Z',
			status: 'running',
		},
		subscriptionTrail: [subscription.id],
	}
	return { root, subscriptions, subscription, policy, flags, request }
}
describe('current independent activity subscription consent', () => {
	it('denies missing rules and grants observation/disclosure/receive separately from wake', async () => {
		const f = await fixture()
		expect(
			await f.policy.authorizeSubscription({ phase: 'observe', subscription: f.subscription }),
		).toMatchObject({ allow: false })
		await f.policy.update({ ...f.flags, expectedRevision: 0 })
		for (const phase of ['observe', 'disclose', 'receive', 'accept'] as const)
			expect(
				await f.policy.authorizeSubscription({ phase, subscription: f.subscription }),
			).toMatchObject({ allow: true })
		expect(await f.policy.authorizeIngress(f.request)).toMatchObject({ allow: true })
		expect(await f.policy.authorizeIngress({ ...f.request, phase: 'wake' })).toMatchObject({
			allow: false,
		})
		await f.policy.update({ ...f.flags, expectedRevision: 1, receive: false, wake: true })
		expect(
			await f.policy.authorizeSubscription({ phase: 'observe', subscription: f.subscription }),
		).toMatchObject({ allow: true })
		expect(
			await f.policy.authorizeSubscription({ phase: 'receive', subscription: f.subscription }),
		).toMatchObject({ allow: false })
		expect(await f.policy.authorizeIngress({ ...f.request, phase: 'wake' })).toMatchObject({
			allow: false,
		})
	})
	it.each(['observe', 'disclose', 'receive'] as const)(
		'requires current %s together with the other permissions at acceptance',
		async (revokedPermission) => {
			const f = await fixture()
			await f.policy.update({ ...f.flags, expectedRevision: 0, [revokedPermission]: false })
			expect(
				await f.policy.authorizeSubscription({ phase: 'accept', subscription: f.subscription }),
			).toMatchObject({ allow: false })
		},
	)
	it.each(['subscription', 'ingress'] as const)(
		'rechecks subscription revocation during %s policy storage awaits',
		async (kind) => {
			const f = await fixture()
			await f.policy.update({ ...f.flags, expectedRevision: 0 })
			const get = f.policy.get.bind(f.policy)
			vi.spyOn(f.policy, 'get').mockImplementationOnce(async (id) => {
				const current = await get(id)
				await f.subscriptions.setEnabled({
					id: f.subscription.id,
					expectedRevision: 1,
					enabled: false,
				})
				return current
			})
			const result =
				kind === 'subscription'
					? await f.policy.authorizeSubscription({ phase: 'observe', subscription: f.subscription })
					: await f.policy.authorizeIngress(f.request)
			expect(result).toMatchObject({ allow: false })
		},
	)
	it('rechecks permission revocation during the final subscription read', async () => {
		const f = await fixture()
		await f.policy.update({ ...f.flags, expectedRevision: 0 })
		const get = f.subscriptions.get.bind(f.subscriptions)
		vi.spyOn(f.subscriptions, 'get')
			.mockImplementationOnce(get)
			.mockImplementationOnce(async (id) => {
				const current = await get(id)
				await f.policy.update({ ...f.flags, expectedRevision: 1, observe: false })
				return current
			})
		expect(
			await f.policy.authorizeSubscription({ phase: 'observe', subscription: f.subscription }),
		).toMatchObject({ allow: false })
	})
	it('captures mutable authorization input before the first awaited lookup', async () => {
		const f = await fixture()
		await f.policy.update({ ...f.flags, expectedRevision: 0 })
		const original = { ...f.subscription, recipient: { ...f.subscription.recipient } }
		const get = f.subscriptions.get.bind(f.subscriptions)
		vi.spyOn(f.subscriptions, 'get').mockImplementationOnce(async (id) => {
			original.recipient.palId = randomUUID()
			return get(id)
		})
		expect(
			await f.policy.authorizeSubscription({ phase: 'observe', subscription: original }),
		).toMatchObject({ allow: true })
		expect(original.recipient.palId).not.toBe(f.subscription.recipient.palId)
	})
	it('does not reuse an audit grant after revoke/restart or accept another exact scope', async () => {
		const f = await fixture()
		await f.policy.update({ ...f.flags, expectedRevision: 0 })
		expect(await f.policy.authorizeIngress(f.request)).toMatchObject({ allow: true })
		await f.policy.update({ ...f.flags, expectedRevision: 1, disclose: false })
		const restarted = new DiskPalActivitySubscriptionPolicy({
			root: join(f.root, 'policy'),
			subscriptions: f.subscriptions,
		})
		expect(await restarted.authorizeIngress(f.request)).toMatchObject({ allow: false })
		await f.policy.update({ ...f.flags, expectedRevision: 2 })
		if (!('kind' in f.request) || f.request.kind !== 'observation')
			throw new Error('Missing observation fixture')
		expect(
			await restarted.authorizeIngress({
				...f.request,
				source: {
					...f.request.source,
					scope: { ...f.request.source.scope, sessionId: generateSessionId() },
				},
			}),
		).toMatchObject({ allow: false })
	})
	it('has one exclusive permission editor at an expected revision', async () => {
		const f = await fixture()
		await f.policy.update({ ...f.flags, expectedRevision: 0 })
		const other = new DiskPalActivitySubscriptionPolicy({
			root: join(f.root, 'policy'),
			subscriptions: f.subscriptions,
		})
		const results = await Promise.allSettled([
			f.policy.update({ ...f.flags, expectedRevision: 1, wake: true }),
			other.update({ ...f.flags, expectedRevision: 1, receive: false }),
		])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(results.find((result) => result.status === 'rejected')).toMatchObject({
			reason: expect.any(PalActivitySubscriptionPermissionConflictError),
		})
	})
})
