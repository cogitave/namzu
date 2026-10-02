import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PalChannelConnection, PalChannelVerifier } from '@namzu/sdk'

const DOMAIN = 'namzu-local-channel/1'

/** Private local fixture authentication. It is not an external provider or a public webhook. */
export function createCliPalLocalChannelVerifier(options: {
	readonly connection: PalChannelConnection
	readonly secret: Uint8Array
}): PalChannelVerifier {
	const connection = Object.freeze({ ...options.connection })
	const secret = Buffer.from(options.secret)
	if (secret.length < 32)
		throw new Error('Local channel authentication requires at least 32 secret bytes.')
	const identity = JSON.stringify([
		connection.tenantId,
		connection.provider,
		connection.connectionId,
		connection.externalTenantId,
	])
	return async (raw, captured, signal) => {
		signal.throwIfAborted()
		if (
			JSON.stringify([
				captured.tenantId,
				captured.provider,
				captured.connectionId,
				captured.externalTenantId,
			]) !== identity
		)
			throw new Error('Local verifier cannot authenticate another connection.')
		if (!raw || typeof raw !== 'object' || Array.isArray(raw))
			throw new Error('Invalid local channel envelope.')
		const { payload, signature, ...extra } = raw as Record<string, unknown>
		if (
			Object.keys(extra).length ||
			typeof payload !== 'string' ||
			payload.length < 1 ||
			payload.length > 64_000 ||
			typeof signature !== 'string' ||
			!/^[a-f0-9]{64}$/.test(signature)
		)
			throw new Error('Invalid local channel authentication envelope.')
		const expected = createHmac('sha256', secret)
			.update(`${DOMAIN}\0${identity}\0${payload}`)
			.digest()
		if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
			throw new Error('Local channel signature refused.')
		const event = JSON.parse(payload)
		if (!event || typeof event !== 'object' || Array.isArray(event))
			throw new Error('Invalid authenticated channel event.')
		return event
	}
}
