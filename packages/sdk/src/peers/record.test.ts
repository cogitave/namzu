import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PEER_PROTOCOL_VERSION } from './protocol.js'
import { PEER_RECORD_VERSION, PeerRecordSchema, derivePeerRef } from './record.js'

function validRecord() {
	return {
		v: PEER_RECORD_VERSION as 1,
		sessionId: 'sess-1',
		ref: derivePeerRef('sess-1'),
		pid: process.pid,
		startedAt: Date.now(),
		kind: 'tui' as const,
		cwd: '/home/user/project',
		permissionMode: 'default',
		state: 'idle' as const,
		acceptsMessages: true,
		address: 'uds:/run/namzu/sess-1.sock',
		token: 't'.repeat(32),
		protocol: PEER_PROTOCOL_VERSION,
		cliVersion: '1.0.0',
	}
}

describe('derivePeerRef', () => {
	it('is the first 6 hex characters of sha256(sessionId)', () => {
		const expected = createHash('sha256').update('sess-1', 'utf8').digest('hex').slice(0, 6)
		expect(derivePeerRef('sess-1')).toBe(expected)
		expect(derivePeerRef('sess-1')).toMatch(/^[0-9a-f]{6}$/)
	})

	it('is deterministic and distinguishes different session ids', () => {
		expect(derivePeerRef('a')).toBe(derivePeerRef('a'))
		expect(derivePeerRef('a')).not.toBe(derivePeerRef('b'))
	})
})

describe('PeerRecordSchema', () => {
	it('accepts a well-formed record', () => {
		expect(PeerRecordSchema.safeParse(validRecord()).success).toBe(true)
	})

	it('accepts a record with no title (falls back to a computed display name)', () => {
		const { title: _unused, ...rest } = { ...validRecord(), title: undefined }
		expect(PeerRecordSchema.safeParse(rest).success).toBe(true)
	})

	it('accepts a record with a title', () => {
		expect(
			PeerRecordSchema.safeParse({ ...validRecord(), title: 'Fix the flaky test' }).success,
		).toBe(true)
	})

	it('is a closed shape: refuses an unknown field', () => {
		expect(PeerRecordSchema.safeParse({ ...validRecord(), extra: true }).success).toBe(false)
	})

	it('refuses a record version other than 1', () => {
		expect(PeerRecordSchema.safeParse({ ...validRecord(), v: 2 }).success).toBe(false)
	})

	it('refuses a malformed ref', () => {
		expect(PeerRecordSchema.safeParse({ ...validRecord(), ref: 'ZZZZZZ' }).success).toBe(false)
	})

	it.each(['tui', 'exec', 'resident', 'scheduled'])('accepts session kind %s', (kind) => {
		expect(PeerRecordSchema.safeParse({ ...validRecord(), kind }).success).toBe(true)
	})

	it('refuses an unrecognised session kind', () => {
		expect(PeerRecordSchema.safeParse({ ...validRecord(), kind: 'daemon' }).success).toBe(false)
	})

	it.each(['busy', 'idle', 'awaiting-permission'])('accepts state %s', (state) => {
		expect(PeerRecordSchema.safeParse({ ...validRecord(), state }).success).toBe(true)
	})

	it('refuses a non-positive pid', () => {
		expect(PeerRecordSchema.safeParse({ ...validRecord(), pid: 0 }).success).toBe(false)
		expect(PeerRecordSchema.safeParse({ ...validRecord(), pid: -1 }).success).toBe(false)
	})

	it('refuses a protocol other than namzu-peer/1', () => {
		expect(PeerRecordSchema.safeParse({ ...validRecord(), protocol: 'namzu-peer/2' }).success).toBe(
			false,
		)
	})
})
