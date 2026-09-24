import { describe, expect, it } from 'vitest'
import {
	DeliverRequestSchema,
	DeliverResponseSchema,
	MAX_PEER_MESSAGE_TEXT_BYTES,
	NoticeRequestSchema,
	PEER_PROTOCOL_VERSION,
	PeerFromSchema,
	PeerRefSchema,
	PeerRequestSchema,
	PingRequestSchema,
	PingResponseSchema,
	SubscribeIdleRequestSchema,
	SubscribeIdleResponseSchema,
} from './protocol.js'

const validFrom = {
	sessionId: 'sess-1',
	ref: 'ab12cd',
	name: 'alice',
	address: 'uds:/run/namzu/sess-1.sock',
	mode: 'default',
	kind: 'tui' as const,
}

describe('PeerRefSchema', () => {
	it('accepts exactly 6 lowercase hex characters', () => {
		expect(PeerRefSchema.safeParse('0123ab').success).toBe(true)
	})

	it.each(['ABCDEF', '12345', '1234567', 'zzzzzz', ''])('rejects %s', (value) => {
		expect(PeerRefSchema.safeParse(value).success).toBe(false)
	})
})

describe('PeerFromSchema', () => {
	it('accepts a well-formed sender identity', () => {
		expect(PeerFromSchema.safeParse(validFrom).success).toBe(true)
	})

	it('is a closed shape: refuses an unknown field', () => {
		expect(PeerFromSchema.safeParse({ ...validFrom, extra: 'nope' }).success).toBe(false)
	})

	it('refuses an unrecognised session kind', () => {
		expect(PeerFromSchema.safeParse({ ...validFrom, kind: 'daemon' }).success).toBe(false)
	})
})

describe('PingRequestSchema', () => {
	it('accepts the bare ping envelope with no token', () => {
		const result = PingRequestSchema.safeParse({ protocol: PEER_PROTOCOL_VERSION, op: 'ping' })
		expect(result.success).toBe(true)
	})

	it('refuses an extra field', () => {
		expect(
			PingRequestSchema.safeParse({ protocol: PEER_PROTOCOL_VERSION, op: 'ping', token: 'x' })
				.success,
		).toBe(false)
	})
})

describe('PingResponseSchema', () => {
	it('accepts ok + a closed session state', () => {
		expect(PingResponseSchema.safeParse({ ok: true, state: 'idle' }).success).toBe(true)
	})

	it('refuses an unrecognised state', () => {
		expect(PingResponseSchema.safeParse({ ok: true, state: 'sleeping' }).success).toBe(false)
	})
})

describe('DeliverRequestSchema', () => {
	const base = {
		protocol: PEER_PROTOCOL_VERSION,
		op: 'deliver' as const,
		token: 't'.repeat(32),
		id: 'msg-1',
		from: validFrom,
		text: 'hello',
	}

	it('accepts a well-formed deliver request', () => {
		expect(DeliverRequestSchema.safeParse(base).success).toBe(true)
	})

	it('accepts the optional inReplyTo and subscribeIdle fields', () => {
		expect(
			DeliverRequestSchema.safeParse({ ...base, inReplyTo: 'msg-0', subscribeIdle: true }).success,
		).toBe(true)
	})

	it('refuses empty text', () => {
		expect(DeliverRequestSchema.safeParse({ ...base, text: '' }).success).toBe(false)
	})

	it('refuses text over the 32 KiB byte cap, counted in UTF-8 bytes not characters', () => {
		// Each '€' is 3 bytes in UTF-8 but 1 UTF-16 code unit, so a naive
		// character-length check would accept this when it must not.
		const oneOverInBytes = Math.ceil((MAX_PEER_MESSAGE_TEXT_BYTES + 1) / 3)
		const text = '€'.repeat(oneOverInBytes)
		expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(MAX_PEER_MESSAGE_TEXT_BYTES)
		expect(DeliverRequestSchema.safeParse({ ...base, text }).success).toBe(false)
	})

	it('accepts text exactly at the 32 KiB byte cap', () => {
		const text = 'a'.repeat(MAX_PEER_MESSAGE_TEXT_BYTES)
		expect(DeliverRequestSchema.safeParse({ ...base, text }).success).toBe(true)
	})

	it('is a closed shape: refuses an unknown field', () => {
		expect(DeliverRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
	})
})

describe('DeliverResponseSchema', () => {
	it.each(['queued', 'held', 'refused'])('accepts status %s', (status) => {
		expect(DeliverResponseSchema.safeParse({ status }).success).toBe(true)
	})

	it('accepts an optional reason', () => {
		expect(
			DeliverResponseSchema.safeParse({ status: 'refused', reason: 'not accepting' }).success,
		).toBe(true)
	})

	it('refuses an unrecognised status', () => {
		expect(DeliverResponseSchema.safeParse({ status: 'delivered' }).success).toBe(false)
	})
})

describe('SubscribeIdleRequestSchema / SubscribeIdleResponseSchema', () => {
	it('accepts a well-formed request', () => {
		expect(
			SubscribeIdleRequestSchema.safeParse({
				protocol: PEER_PROTOCOL_VERSION,
				op: 'subscribe_idle',
				token: 't'.repeat(32),
				id: 'msg-1',
				from: validFrom,
			}).success,
		).toBe(true)
	})

	it.each(['subscribed', 'refused'])('accepts response status %s with no other field', (status) => {
		expect(SubscribeIdleResponseSchema.safeParse({ status }).success).toBe(true)
	})

	it('response is a closed shape: refuses a reason field the design does not list', () => {
		expect(SubscribeIdleResponseSchema.safeParse({ status: 'refused', reason: 'x' }).success).toBe(
			false,
		)
	})
})

describe('NoticeRequestSchema', () => {
	const about = { sessionId: 'sess-2', name: 'bob', ref: '112233' }

	it.each(['idle', 'exited'])('accepts kind %s with no outcome', (kind) => {
		expect(
			NoticeRequestSchema.safeParse({
				protocol: PEER_PROTOCOL_VERSION,
				op: 'notice',
				token: 't'.repeat(32),
				from: validFrom,
				kind,
				about,
			}).success,
		).toBe(true)
	})

	it.each(['queued', 'held', 'refused'])('accepts a delivery notice with outcome %s', (outcome) => {
		expect(
			NoticeRequestSchema.safeParse({
				protocol: PEER_PROTOCOL_VERSION,
				op: 'notice',
				token: 't'.repeat(32),
				from: validFrom,
				kind: 'delivery',
				about,
				outcome,
				detail: 'allowed by the operator',
			}).success,
		).toBe(true)
	})

	it('refuses an unrecognised notice kind', () => {
		expect(
			NoticeRequestSchema.safeParse({
				protocol: PEER_PROTOCOL_VERSION,
				op: 'notice',
				token: 't'.repeat(32),
				from: validFrom,
				kind: 'started',
				about,
			}).success,
		).toBe(false)
	})

	it('refuses a notice with no `from`: it must be verified the same as deliver and subscribe_idle', () => {
		expect(
			NoticeRequestSchema.safeParse({
				protocol: PEER_PROTOCOL_VERSION,
				op: 'notice',
				token: 't'.repeat(32),
				kind: 'idle',
				about,
			}).success,
		).toBe(false)
	})
})

describe('PeerRequestSchema (the closed op set)', () => {
	it('discriminates on op across all four operations', () => {
		expect(
			PeerRequestSchema.safeParse({ protocol: PEER_PROTOCOL_VERSION, op: 'ping' }).success,
		).toBe(true)
		expect(
			PeerRequestSchema.safeParse({
				protocol: PEER_PROTOCOL_VERSION,
				op: 'deliver',
				token: 't'.repeat(32),
				id: 'm1',
				from: validFrom,
				text: 'hi',
			}).success,
		).toBe(true)
	})

	it('refuses an op outside the closed set', () => {
		expect(
			PeerRequestSchema.safeParse({ protocol: PEER_PROTOCOL_VERSION, op: 'shutdown' }).success,
		).toBe(false)
	})

	it('refuses a request naming a different protocol version', () => {
		expect(PeerRequestSchema.safeParse({ protocol: 'namzu-peer/2', op: 'ping' }).success).toBe(
			false,
		)
	})

	it('refuses malformed input outright', () => {
		expect(PeerRequestSchema.safeParse(null).success).toBe(false)
		expect(PeerRequestSchema.safeParse('ping').success).toBe(false)
		expect(PeerRequestSchema.safeParse({}).success).toBe(false)
	})
})
