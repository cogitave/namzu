import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateMessageId, generateTurnId } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import { createCliPalLocalChannelVerifier } from './channel-local.js'
import { createCliPalChannel } from './channel.js'
import { palConversationBinding } from './conversations.js'
import { createPal } from './store.js'

const temporary: string[] = []
afterEach(async () => {
	vi.unstubAllEnvs()
	for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('local channel composition over actual CLI conversation storage', () => {
	it('authenticates, accepts, claims and records channel context without a model or guest', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-cli-channel-'))
		temporary.push(root)
		await mkdir(join(root, 'state'))
		vi.stubEnv('NAMZU_HOME', join(root, 'state'))
		const pal = createPal({ name: 'Local channel recipient' })
		const state = await openSessions(pal.workspace)
		const tenantId = state.tenantId
		closeSessions(state)
		const connection = {
			tenantId,
			provider: 'local-fixture',
			connectionId: 'private-local-1',
			externalTenantId: 'native-tenant',
		}
		const secret = randomBytes(32)
		const verify = createCliPalLocalChannelVerifier({ connection, secret })
		const event = {
			kind: 'message',
			externalTenantId: connection.externalTenantId,
			nativeConversationId: 'native-conversation',
			nativeChannelId: null,
			nativeThreadId: 'native-thread',
			actorId: 'current-actor',
			eventId: 'native-event',
			body: 'Local authenticated context',
		}
		const payload = JSON.stringify(event)
		const identity = JSON.stringify([
			tenantId,
			connection.provider,
			connection.connectionId,
			connection.externalTenantId,
		])
		const signature = createHmac('sha256', secret)
			.update(`namzu-local-channel/1\0${identity}\0${payload}`)
			.digest('hex')
		let allowActor = true
		const context = createCliPalChannel({
			connection,
			verify,
			selectRecipient: async () => ({ tenantId, palId: pal.id }),
			authorize: async (request) =>
				allowActor && request.source.actorId === 'current-actor'
					? { allow: true, grant: { id: 'explicit-fixture-policy', revision: '1' } }
					: { allow: false, reason: 'Current actor denied' },
			authorizeRoute: async () => ({
				allow: true,
				grant: { id: 'explicit-fixture-reply', revision: '1' },
			}),
		})
		await expect(context.ingress.accept({ payload, signature: '0'.repeat(64) })).rejects.toThrow(
			'signature refused',
		)
		const accepted = await context.ingress.accept({ payload, signature })
		const binding = (await context.store.readIngress({ tenantId, palId: pal.id }))?.routes[0]
		if (!binding) throw new Error('Missing accepted route')
		const signal = new AbortController().signal
		await context.host.ensureConversation(binding, signal)
		expect((await palConversationBinding(pal.workspace, accepted.sessionId))?.definition.id).toBe(
			pal.id,
		)
		const access = await context.host.openConversation(binding, signal)
		const active = await context.store.activateIngress(binding, {
			binding,
			access,
			definition: pal,
		})
		const lease = await access.log.claim({ holder: 'local-channel-fixture', ttlMs: 60_000 })
		if (!lease) throw new Error('Missing actual session writer')
		try {
			const turnId = generateTurnId()
			await access.log.beginTurn(lease, {
				turnId,
				userMessageId: generateMessageId(),
				config: { model: 'fixture', tokenBudget: 0, timeoutMs: 60_000 },
			})
			const source = context.source(active)
			const claims = await source.claim({ sessionId: active.sessionId, turnId, signal })
			expect(claims).toHaveLength(1)
			const claim = claims[0]
			if (!claim) throw new Error('Missing local delivery')
			expect(claim.message.source).toMatchObject({
				type: 'runtime-context',
				kind: 'channel-message',
			})
			const messageId = generateMessageId()
			await access.log.append(lease, {
				type: 'message',
				turnId,
				messageId,
				role: 'user',
				kind: 'context',
				content: claim.message,
			})
			const through = await access.log.head()
			if (!through) throw new Error('Missing actual flushed head')
			await source.recorded([
				{
					claimId: claim.claimId,
					ref: claim.ref,
					sessionId: active.sessionId,
					turnId,
					messageId,
					through,
				},
			])
			const response = await context.router.replyRoute(claim.ref, {
				recipient: { tenantId, palId: pal.id },
				sessionId: active.sessionId,
				profileRevision: pal.revision,
			})
			expect(response.identity.nativeConversationId).toBe(event.nativeConversationId)
			expect(response.currentActorId).toBe('current-actor')
			const nextPayload = JSON.stringify({ ...event, eventId: 'next-event' })
			const nextSignature = createHmac('sha256', secret)
				.update(`namzu-local-channel/1\0${identity}\0${nextPayload}`)
				.digest('hex')
			const pending = await context.ingress.accept({
				payload: nextPayload,
				signature: nextSignature,
			})
			allowActor = false
			await expect(source.claim({ sessionId: active.sessionId, turnId, signal })).rejects.toThrow(
				'Current actor denied',
			)
			expect(
				(await context.store.readIngress({ tenantId, palId: pal.id }))?.messages.find(
					(message) => message.id === pending.id,
				)?.phase,
			).toBe('pending')
		} finally {
			await access.log.release(lease)
		}
	})
})
