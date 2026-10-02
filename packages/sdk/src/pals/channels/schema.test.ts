import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import {
	captureConnection,
	checkedIdentity,
	verifiedActionSchema,
	verifiedMessageSchema,
} from './schema.js'

describe('channel identity validation', () => {
	it('requires an exact bounded native tuple and refuses credential/recipient selectors', () => {
		const event = {
			kind: 'message',
			externalTenantId: 'tenant',
			nativeConversationId: 'conversation',
			nativeChannelId: null,
			nativeThreadId: null,
			actorId: 'actor',
			eventId: 'event',
			body: 'text',
		}
		expect(verifiedMessageSchema.parse(event)).toEqual(event)
		expect(() => verifiedMessageSchema.parse({ ...event, credentialId: 'key' })).toThrow()
		expect(() => verifiedMessageSchema.parse({ ...event, actorId: '' })).toThrow()
		expect(() => verifiedMessageSchema.parse({ ...event, nativeThreadId: undefined })).toThrow()
	})
	it('binds verified native identity to the captured host connection', () => {
		const connection = captureConnection({
			tenantId: generateTenantId(),
			provider: 'fixture',
			connectionId: 'one',
			externalTenantId: 'tenant',
		})
		const source = {
			...connection,
			kind: 'channel',
			nativeConversationId: 'conversation',
			nativeChannelId: null,
			nativeThreadId: null,
			actorId: 'actor',
			eventId: 'event',
		}
		expect(checkedIdentity(connection, source).actorId).toBe('actor')
		expect(() => checkedIdentity(connection, { ...source, connectionId: 'two' })).toThrow(
			'authenticated connection',
		)
		expect(Object.isFrozen(connection)).toBe(true)
	})
	it('requires an exact authenticated serialized action payload and delivery namespace', () => {
		const payload = JSON.stringify({ decision: 'approve_once' })
		const action = {
			kind: 'action',
			externalTenantId: 'tenant',
			nativeConversationId: 'conversation',
			nativeChannelId: null,
			nativeThreadId: null,
			actorId: 'actor',
			eventId: 'event',
			actionId: 'action',
			payload,
			payloadDigest: createHash('sha256').update(payload).digest('hex'),
			deliveryRef: { namespace: 'namzu-pal-channel/1', id: '0'.repeat(64), digest: '1'.repeat(64) },
		}
		expect(verifiedActionSchema.parse(action).payload).toBe(payload)
		expect(() => verifiedActionSchema.parse({ ...action, payload: `${payload} ` })).toThrow(
			'authenticated digest',
		)
		expect(() =>
			verifiedActionSchema.parse({
				...action,
				deliveryRef: { ...action.deliveryRef, namespace: 'namzu-pal-message/1' },
			}),
		).toThrow()
	})
})
