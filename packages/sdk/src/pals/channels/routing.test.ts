import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSessionId } from '../../utils/id.js'
import { channelFixture } from './__fixtures__/channel.js'
import { PalChannelRouter } from './routing.js'
import type {
	PalChannelActionContext,
	PalChannelRouterOptions,
	PalChannelVerifiedAction,
} from './types.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
	const f = await channelFixture()
	cleanups.push(f.cleanup)
	return f
}
function action(
	event: Awaited<ReturnType<typeof channelFixture>>['event'],
	ref: PalChannelVerifiedAction['deliveryRef'],
): PalChannelVerifiedAction {
	const { body: _body, ...identity } = event
	const payload = JSON.stringify({
		kind: 'tool_review',
		answer: 'approve_once',
	})
	return {
		...identity,
		kind: 'action',
		actorId: 'actor-two',
		eventId: 'action-event',
		actionId: 'native-action',
		deliveryRef: ref,
		payload,
		payloadDigest: createHash('sha256').update(payload).digest('hex'),
	}
}
function options(f: Awaited<ReturnType<typeof channelFixture>>): PalChannelRouterOptions {
	return {
		connection: f.connection,
		pals: f.pals,
		store: f.store,
		host: f.host,
		verify: f.options.verify,
		authorize: async () => ({
			allow: true,
			grant: { id: 'current-explicit-route-policy', revision: '1' },
		}),
	}
}
describe('recorded native channel response and action routes', () => {
	it('rejects accepted but unrecorded input before any route authorization', async () => {
		const f = await fixture()
		const accepted = await f.ingress.accept(f.event)
		const authorize = vi.fn(options(f).authorize)
		const router = new PalChannelRouter({ ...options(f), authorize })
		await expect(
			router.replyRoute(
				{
					namespace: 'namzu-pal-channel/1',
					id: accepted.id,
					digest: accepted.digest,
				},
				{
					recipient: f.recipient,
					sessionId: accepted.sessionId,
					profileRevision: 1,
				},
			),
		).rejects.toThrow('exact recorded')
		expect(authorize).not.toHaveBeenCalled()
	})
	it('resolves the original tuple and exact log receipt after real durable recording', async () => {
		const f = await fixture()
		await f.ingress.accept(f.event)
		const { receipt, context } = await f.record()
		const route = await new PalChannelRouter(options(f)).replyRoute(receipt.ref, context)
		expect(route.identity.nativeConversationId).toBe(f.event.nativeConversationId)
		expect(route.eventActorId).toBe(f.event.actorId)
		expect(route.recordedReceipt).toEqual(receipt)
		expect(Object.isFrozen(route.identity)).toBe(true)
	})
	it('rejects different session, revision, connection and forged reference digest', async () => {
		const f = await fixture()
		await f.ingress.accept(f.event)
		const { receipt, context } = await f.record()
		const router = new PalChannelRouter(options(f))
		await expect(
			router.replyRoute(receipt.ref, {
				...context,
				sessionId: generateSessionId(),
			}),
		).rejects.toThrow('another Pal conversation')
		await expect(
			router.replyRoute({ ...receipt.ref, digest: '0'.repeat(64) }, context),
		).rejects.toThrow('exact recorded')
		await expect(
			new PalChannelRouter({
				...options(f),
				connection: { ...f.connection, connectionId: 'other' },
			}).replyRoute(receipt.ref, context),
		).rejects.toThrow('another connection')
	})
	it('authenticates each action actor instead of inheriting the ingress actor', async () => {
		const f = await fixture()
		await f.ingress.accept(f.event)
		const { receipt, context } = await f.record()
		const authorize = vi.fn(async (request) => ({
			allow: false as const,
			reason: `Current actor ${request.actorId} denied`,
		}))
		const router = new PalChannelRouter({ ...options(f), authorize })
		await expect(router.actionRoute(action(f.event, receipt.ref), context)).rejects.toThrow(
			'actor-two denied',
		)
		expect(authorize.mock.calls[0]?.[0].actorId).toBe('actor-two')
	})
	it('rejects action route and payload changes even with a valid original receipt', async () => {
		const f = await fixture()
		await f.ingress.accept(f.event)
		const { receipt, context } = await f.record()
		const router = new PalChannelRouter(options(f))
		await expect(
			router.actionRoute({ ...action(f.event, receipt.ref), nativeThreadId: 'other' }, context),
		).rejects.toThrow('another native')
		await expect(
			router.actionRoute({ ...action(f.event, receipt.ref), payload: 'changed' }, context),
		).rejects.toThrow('authenticated digest')
	})
	it('refuses absent action execution and passes exact authenticated data only to an explicit action host', async () => {
		const f = await fixture()
		await f.ingress.accept(f.event)
		const { receipt, context } = await f.record()
		const input = action(f.event, receipt.ref)
		await expect(new PalChannelRouter(options(f)).executeAction(input, context)).rejects.toThrow(
			'unsupported',
		)
		const execute = vi.fn(async (_context: PalChannelActionContext) => ({
			status: 'applied' as const,
			receiptId: 'native-confirmed-decision',
		}))
		await expect(
			new PalChannelRouter({
				...options(f),
				actions: { execute },
			}).executeAction(input, context),
		).resolves.toEqual({
			status: 'applied',
			receiptId: 'native-confirmed-decision',
		})
		expect(execute.mock.calls[0]?.[0].route.currentActorId).toBe('actor-two')
	})
	it('rechecks pause after awaited authorization and never forwards a paused action', async () => {
		const f = await fixture()
		await f.ingress.accept(f.event)
		const { receipt, context } = await f.record()
		const execute = vi.fn(async () => ({
			status: 'applied' as const,
			receiptId: 'never',
		}))
		const router = new PalChannelRouter({
			...options(f),
			actions: { execute },
			authorize: async () => {
				f.pals.update(f.first.id, 1, { paused: true })
				return { allow: true, grant: { id: 'explicit', revision: '1' } }
			},
		})
		await expect(router.executeAction(action(f.event, receipt.ref), context)).rejects.toThrow(
			'paused',
		)
		expect(execute).not.toHaveBeenCalled()
	})
})
