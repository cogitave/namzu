import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
	type NativeOp,
	NativeProtocolError,
	type NativeRequest,
	decodeReply,
	encodeRequest,
	formatRef,
	nameHash,
	parseRef,
} from '../native/protocol.js'

// The vectors are shared with crates/namzu-win-core: both are held to the same files.
function vectors(name: string): Record<string, any> {
	const url = new URL(`../../../../conformance/namzu-win/${name}`, import.meta.url)
	return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))
}

describe('namzu-win/1 requests', () => {
	for (const c of vectors('protocol.json').requests) {
		it(`writes ${c.name}`, () => {
			const { id, ...request } = c.wire
			const line = encodeRequest(id, request as NativeRequest)
			expect(line).not.toContain('\n')
			expect(JSON.parse(line)).toEqual(c.wire)
		})
	}

	it('leaves out an option that is not set', () => {
		const line = encodeRequest(1, { op: 'snapshot', windowId: 'w', maxNodes: undefined })
		expect(JSON.parse(line)).toEqual({ id: 1, op: 'snapshot', windowId: 'w' })
	})

	it('refuses an id that is not a non-negative integer', () => {
		for (const id of [-1, 1.5, Number.NaN, 2 ** 53]) {
			expect(() => encodeRequest(id, { op: 'quit' })).toThrow(NativeProtocolError)
		}
	})
})

describe('namzu-win/1 replies', () => {
	for (const c of vectors('protocol.json').replies) {
		it(`reads ${c.name}`, () => {
			const { id, ok, ...rest } = c.wire
			const got = decodeReply(c.op as NativeOp, JSON.stringify(c.wire))
			expect(got.id).toBe(id)
			expect(got.ok).toBe(ok)
			if (got.ok) expect(got.body).toEqual(rest)
			else expect({ code: got.code, message: got.message }).toEqual(rest)
		})
	}

	for (const c of vectors('protocol.json').badReplies) {
		it(`refuses ${c.name}`, () => {
			expect(() => decodeReply(c.op as NativeOp, c.line)).toThrow(NativeProtocolError)
		})
	}

	it('drops a field it does not know, so a newer helper can add one', () => {
		const got = decodeReply('seq', '{"id":1,"ok":true,"seq":4,"extra":true}')
		expect(got).toEqual({ id: 1, ok: true, body: { seq: 4 } })
	})
})

describe('refs', () => {
	const refs = vectors('refs.json')
	for (const c of refs.valid) {
		it(`reads ${c.ref}`, () => {
			expect(parseRef(c.ref)).toEqual({ revision: c.revision, index: c.index })
			expect(formatRef(c.revision, c.index)).toBe(c.ref)
		})
	}
	for (const ref of refs.invalid as string[]) {
		it(`refuses ${JSON.stringify(ref)}`, () => {
			expect(parseRef(ref)).toBeUndefined()
		})
	}
})

describe('fingerprint name hash', () => {
	for (const c of vectors('fingerprint.json').nameHash) {
		it(`hashes ${JSON.stringify(c.input)}`, () => {
			expect(nameHash(c.input)).toBe(c.hash)
		})
	}
})
