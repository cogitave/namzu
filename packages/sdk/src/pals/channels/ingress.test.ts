import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSessionId } from '../../utils/id.js'
import { channelFixture, deferred } from './__fixtures__/channel.js'
import { PalChannelIngress } from './ingress.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
	const f = await channelFixture()
	cleanups.push(f.cleanup)
	return f
}

describe('authenticated channel ingress', () => {
	it('requires verification and authorization before any durable acceptance', async () => {
		const f = await fixture()
		const verify = vi.fn(async () => {
			throw new Error('Invalid signature.')
		})
		const selectRecipient = vi.fn(f.options.selectRecipient)
		const ingress = new PalChannelIngress({
			...f.options,
			verify,
			selectRecipient,
		})
		await expect(ingress.accept(f.event)).rejects.toThrow('Invalid signature')
		expect(selectRecipient).not.toHaveBeenCalled()
		expect(await f.store.readIngress(f.recipient)).toBeNull()
	})
	it('captures every actor independently without inheriting the first participant authority', async () => {
		const f = await fixture()
		const authorize = vi.fn(async (request) =>
			request.source.actorId === 'actor-one'
				? { allow: true as const, grant: { id: 'per-actor', revision: '1' } }
				: { allow: false as const, reason: 'Actor revoked' },
		)
		const ingress = new PalChannelIngress({ ...f.options, authorize })
		await ingress.accept(f.event)
		await expect(
			ingress.accept({
				...f.event,
				eventId: 'event-two',
				actorId: 'actor-two',
			}),
		).rejects.toThrow('Actor revoked')
		expect(authorize.mock.calls.map(([request]) => request.source.actorId)).toEqual([
			'actor-one',
			'actor-one',
			'actor-two',
		])
		expect((await f.store.readIngress(f.recipient))?.messages).toHaveLength(1)
	})
	it('retains a stable pinned target and conversation after model edits, restart and selector changes', async () => {
		const f = await fixture()
		const first = await f.ingress.accept(f.event)
		f.pals.update(f.first.id, 1, {
			name: 'Updated',
			model: { provider: 'fixture', model: 'other' },
		})
		const selector = vi.fn(async () => ({
			tenantId: f.recipient.tenantId,
			palId: f.other.id,
		}))
		const restarted = new PalChannelIngress({
			...f.options,
			selectRecipient: selector,
		})
		const second = await restarted.accept({ ...f.event, eventId: 'event-two' })
		expect(second.sessionId).toBe(first.sessionId)
		expect(selector).not.toHaveBeenCalled()
		expect((await f.binding()).profileRevision).toBe(1)
	})
	it('makes an exact event retry idempotent and refuses changed actor or body under the same event id', async () => {
		const f = await fixture()
		const first = await f.ingress.accept(f.event)
		expect(await f.ingress.accept(f.event)).toEqual(first)
		await expect(f.ingress.accept({ ...f.event, actorId: 'actor-two' })).rejects.toThrow()
		await expect(f.ingress.accept({ ...f.event, body: 'changed' })).rejects.toThrow()
		expect((await f.store.readIngress(f.recipient))?.messages).toHaveLength(1)
	})
	it.each(['nativeConversationId', 'nativeChannelId', 'nativeThreadId'] as const)(
		'keeps distinct %s routes even when event ids match',
		async (field) => {
			const f = await fixture()
			const first = await f.ingress.accept(f.event)
			const second = await f.ingress.accept({
				...f.event,
				[field]: 'different',
			})
			expect(second.sessionId).not.toBe(first.sessionId)
		},
	)
	it('keeps null channel/thread distinct and never treats a native Namzu UUID as a local session', async () => {
		const f = await fixture()
		const native = generateSessionId()
		const first = await f.ingress.accept({
			...f.event,
			nativeConversationId: native,
			nativeThreadId: null,
		})
		const second = await f.ingress.accept({
			...f.event,
			nativeConversationId: native,
			nativeThreadId: 'null',
		})
		expect(first.sessionId).not.toBe(native)
		expect(second.sessionId).not.toBe(first.sessionId)
	})
	it('rejects a verified foreign external tenant and a selector foreign Namzu tenant', async () => {
		const f = await fixture()
		await expect(
			f.ingress.accept({ ...f.event, externalTenantId: 'other-tenant' }),
		).rejects.toThrow('authenticated connection')
		expect(await f.store.readIngress(f.recipient)).toBeNull()
	})
	it('captures raw input and trusted callback results across awaited authorization', async () => {
		const f = await fixture()
		const entered = deferred<void>()
		const release = deferred<void>()
		const raw = { ...f.event }
		const ingress = new PalChannelIngress({
			...f.options,
			authorize: async (request) => {
				expect(Object.isFrozen(request.source)).toBe(true)
				entered.resolve()
				await release.promise
				return { allow: true, grant: { id: 'explicit', revision: '1' } }
			},
		})
		const accepted = ingress.accept(raw)
		await entered.promise
		raw.actorId = 'forged'
		raw.body = 'changed'
		release.resolve()
		await accepted
		const message = (await f.store.readIngress(f.recipient))?.messages[0]
		expect(
			message && 'kind' in message && message.kind === 'channel' && message.source.actorId,
		).toBe('actor-one')
	})
	it('does not turn postcommit notification failure into failed acceptance', async () => {
		const f = await fixture()
		const error = new Error('Notification failed')
		const report = deferred<unknown>()
		const ingress = new PalChannelIngress({
			...f.options,
			host: {
				...f.host,
				notify: () => {
					throw error
				},
			},
			onNotificationError: async (e) => report.resolve(e),
		})
		const receipt = await ingress.accept(f.event)
		expect(receipt.status).toBe('accepted')
		expect(await report.promise).toBe(error)
	})
	it('aborts after awaited verification without publishing routing or inbox records', async () => {
		const f = await fixture()
		const controller = new AbortController()
		const ingress = new PalChannelIngress({
			...f.options,
			verify: async () => {
				controller.abort()
				return f.event
			},
		})
		await expect(ingress.accept(f.event, controller.signal)).rejects.toThrow()
		expect(await f.store.readIngress(f.recipient)).toBeNull()
	})
	it('rechecks actor consent after awaited route publication before committing input', async () => {
		const f = await fixture()
		let enabled = true
		const ingress = new PalChannelIngress({
			...f.options,
			routes: {
				get: f.routes.get.bind(f.routes),
				reserve: async (decision) => {
					const reserved = await f.routes.reserve(decision)
					enabled = false
					return reserved
				},
			},
			authorize: async () =>
				enabled
					? { allow: true, grant: { id: 'explicit', revision: '1' } }
					: { allow: false, reason: 'Revoked before commit' },
		})
		await expect(ingress.accept(f.event)).rejects.toThrow('Revoked before commit')
		expect(await f.store.readIngress(f.recipient)).toBeNull()
	})
})
