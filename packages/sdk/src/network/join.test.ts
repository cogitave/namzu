import { describe, expect, it } from 'vitest'
import { createManualClock } from './clock.js'
import {
	JOIN_ADDRESS_WINDOW_MS,
	JOIN_EXPIRY_MS,
	JoinTable,
	MAX_PENDING_JOINS,
	type PendingJoin,
	formatJoinCode,
	joinCode,
} from './join.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

describe('join code', () => {
	it('is the same on both screens for the same channel facts', () => {
		expect(joinCode(A, B, 'n1', 'n2')).toBe(joinCode(A, B, 'n1', 'n2'))
		expect(joinCode(A, B, 'n1', 'n2')).toMatch(/^\d{6}$/)
		expect(formatJoinCode('482913')).toBe('482 913')
	})

	it('differs when a relay shows each side a different certificate or a nonce is replayed', () => {
		const honest = joinCode(A, B, 'n1', 'n2')
		expect(joinCode(A, C, 'n1', 'n2')).not.toBe(honest)
		expect(joinCode(C, B, 'n1', 'n2')).not.toBe(honest)
		expect(joinCode(A, B, 'n1', 'n3')).not.toBe(honest)
	})
})

describe('JoinTable', () => {
	const make = () => {
		const clock = createManualClock()
		const expired: PendingJoin[] = []
		return { clock, expired, table: new JoinTable({ clock, onExpire: (e) => expired.push(e) }) }
	}
	const req = (n: number, addr = `10.0.0.${n}`) => ({
		requestId: `r${n}`,
		name: `m${n}`,
		code: '123456',
		sourceAddr: addr,
		viaMachineId: A,
	})

	it('expires a request after ten minutes everywhere and refuses a late decision', () => {
		const { clock, table, expired } = make()
		table.addLocal(req(1))
		clock.advance(JOIN_EXPIRY_MS)
		expect(expired.map((e) => e.requestId)).toEqual(['r1'])
		expect(table.decide('r1', 'allow')).toBe('already')
	})

	it('finds by name only while the name is unique, and never later than now', () => {
		const { clock, table } = make()
		table.addLocal({ ...req(1), name: 'kitchen' })
		expect(table.find('kitchen')?.requestId).toBe('r1')
		table.addLocal({ ...req(2), name: 'Kitchen' })
		expect(table.find('kitchen')).toBeUndefined()
		expect(table.find('r2')?.requestId).toBe('r2')
		const future = table.addRemote({ ...req(3), createdAt: clock.now() + 3_600_000 })
		expect(future?.createdAt).toBe(clock.now())
		expect(future?.expiresAt).toBe(clock.now() + JOIN_EXPIRY_MS)
	})

	it('lets the first decision win', () => {
		const { table } = make()
		table.addLocal(req(1))
		expect(table.decide('r1', 'allow')).toBe('ok')
		expect(table.decide('r1', 'deny')).toBe('already')
		expect(table.decide('nope', 'allow')).toBe('unknown')
	})

	it('rate-limits one address and caps the table', () => {
		const { clock, table } = make()
		expect(table.addLocal(req(1, '10.0.0.9')).ok).toBe(true)
		expect(table.addLocal(req(2, '10.0.0.9'))).toEqual({ ok: false, reason: 'rate' })
		clock.advance(JOIN_ADDRESS_WINDOW_MS)
		expect(table.addLocal(req(2, '10.0.0.9')).ok).toBe(true)
		for (let i = 3; i <= MAX_PENDING_JOINS; i++) expect(table.addLocal(req(i)).ok).toBe(true)
		expect(table.addLocal(req(99))).toEqual({ ok: false, reason: 'full' })
	})

	it('finds a request by code, name or id, and keeps a gossiped one out of the local count', () => {
		const { clock, table } = make()
		table.addRemote({
			requestId: 'x',
			name: 'Desk Mini',
			code: '482913',
			sourceAddr: '10.0.0.5',
			createdAt: clock.now(),
			viaMachineId: B,
		})
		expect(table.find('482 913')?.requestId).toBe('x')
		expect(table.find('desk mini')?.requestId).toBe('x')
		expect(table.find('x')?.local).toBe(false)
		table.settle('x', 'deny')
		expect(table.list()).toHaveLength(0)
		expect(
			table.addRemote({
				requestId: 'x',
				name: 'n',
				code: '111111',
				sourceAddr: 'a',
				createdAt: clock.now(),
				viaMachineId: B,
			}),
		).toBeUndefined()
	})
})
