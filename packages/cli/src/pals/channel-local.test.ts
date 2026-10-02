import { createHmac, randomBytes } from 'node:crypto'
import type { PalChannelConnection } from '@namzu/sdk'
import { generateTenantId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { createCliPalLocalChannelVerifier } from './channel-local.js'

const signal = () => new AbortController().signal
function fixture() {
	const secret = randomBytes(32)
	const connection: PalChannelConnection = {
		tenantId: generateTenantId(),
		provider: 'local-fixture',
		connectionId: 'local-1',
		externalTenantId: 'native-tenant',
	}
	const verifier = createCliPalLocalChannelVerifier({ connection, secret })
	const event = {
		kind: 'message',
		externalTenantId: 'native-tenant',
		nativeConversationId: 'native-conversation',
		nativeChannelId: null,
		nativeThreadId: null,
		actorId: 'current-actor',
		eventId: 'native-event',
		body: 'Local authenticated fixture',
	}
	function sign(value: unknown) {
		const payload = JSON.stringify(value)
		const identity = JSON.stringify([
			connection.tenantId,
			connection.provider,
			connection.connectionId,
			connection.externalTenantId,
		])
		const signature = createHmac('sha256', secret)
			.update(`namzu-local-channel/1\0${identity}\0${payload}`)
			.digest('hex')
		return { payload, signature }
	}
	return { secret, connection, verifier, event, sign }
}
describe('private local channel authentication', () => {
	it('verifies the exact signed payload and current event actor', async () => {
		const f = fixture()
		expect(await f.verifier(f.sign(f.event), f.connection, signal())).toEqual(f.event)
		expect(
			await f.verifier(
				f.sign({ ...f.event, actorId: 'next-actor', eventId: 'next-event' }),
				f.connection,
				signal(),
			),
		).toMatchObject({ actorId: 'next-actor' })
	})
	it('refuses unsigned input, changed content, extra selectors and another connection', async () => {
		const f = fixture()
		const signed = f.sign(f.event)
		await expect(f.verifier(f.event, f.connection, signal())).rejects.toThrow(
			'authentication envelope',
		)
		await expect(
			f.verifier(
				{
					...signed,
					payload: signed.payload.replace('current-actor', 'forged-actor'),
				},
				f.connection,
				signal(),
			),
		).rejects.toThrow('signature refused')
		await expect(
			f.verifier({ ...signed, credentialId: 'other' }, f.connection, signal()),
		).rejects.toThrow('authentication envelope')
		await expect(
			f.verifier(signed, { ...f.connection, connectionId: 'other' }, signal()),
		).rejects.toThrow('another connection')
	})
	it('captures private secret bytes before callers can mutate them', async () => {
		const f = fixture()
		const signed = f.sign(f.event)
		f.secret.fill(0)
		expect(await f.verifier(signed, f.connection, signal())).toEqual(f.event)
		expect(() =>
			createCliPalLocalChannelVerifier({
				connection: f.connection,
				secret: new Uint8Array(8),
			}),
		).toThrow('32 secret bytes')
	})
	it('honors abort before any authentication or event processing', async () => {
		const f = fixture()
		const controller = new AbortController()
		controller.abort()
		await expect(f.verifier(f.sign(f.event), f.connection, controller.signal)).rejects.toThrow()
	})
})
