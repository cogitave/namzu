import { describe, expect, it } from 'vitest'
import { currentPlace, parseTurnHolder, placeOf, turnHolder } from '../turn-holder.js'

describe('a turn holder name', () => {
	it('round-trips the process id, the turn id and the place', () => {
		const holder = turnHolder('turn_abc123', {
			pid: 4242,
			place: 'a1b2c3d4e5f6',
		})
		expect(holder).toBe('namzu:4242:turn_abc123@a1b2c3d4e5f6')
		expect(parseTurnHolder(holder)).toEqual({
			pid: 4242,
			turnId: 'turn_abc123',
			place: 'a1b2c3d4e5f6',
		})
	})

	it('keeps its old beginning, so a reader of `namzu:<pid>:` still matches', () => {
		expect(turnHolder('turn_1', { pid: 77 }).startsWith('namzu:77:')).toBe(true)
		expect(/^namzu:(\d+):/.exec(turnHolder('turn_1', { pid: 77 }))?.[1]).toBe('77')
	})

	it('reads a holder written before the place existed as having none', () => {
		const parsed = parseTurnHolder('namzu:4242:turn_abc123')
		expect(parsed).toEqual({ pid: 4242, turnId: 'turn_abc123' })
		expect(parsed).not.toHaveProperty('place')
	})

	it('keeps a turn id with unusual characters whole', () => {
		for (const id of [
			'turn:with:colons',
			'a@b',
			'x@0123456789ab-not-a-place',
			'line\nbreak',
			'é ü',
		]) {
			const holder = turnHolder(id, { pid: 9, place: '0123456789ab' })
			expect(parseTurnHolder(holder)).toEqual({
				pid: 9,
				turnId: id,
				place: '0123456789ab',
			})
		}
	})

	it('does not read another writer name as a turn holder', () => {
		expect(parseTurnHolder('namzu:agent-manager:task_1')).toBeNull()
		expect(parseTurnHolder('host-that-is-gone')).toBeNull()
		expect(parseTurnHolder('namzu:12:')).toBeNull()
		expect(parseTurnHolder('namzu:12:@0123456789ab')).toBeNull()
		expect(parseTurnHolder('namzu:99999999999999999999:turn_1')).toBeNull()
	})
})

describe('the place of a process', () => {
	it('is 12 hex characters and stable within a process', () => {
		expect(currentPlace()).toMatch(/^[0-9a-f]{12}$/)
		expect(currentPlace()).toBe(currentPlace())
		expect(turnHolder('t')).toBe(turnHolder('t'))
		expect(turnHolder('t').endsWith(`@${currentPlace()}`)).toBe(true)
	})

	it('differs when the host name differs, and when the namespace identity differs', () => {
		const base = placeOf({
			hostName: 'alpha',
			pidNamespace: 'pid:[4026531836]',
		})
		expect(placeOf({ hostName: 'alpha', pidNamespace: 'pid:[4026531836]' })).toBe(base)
		expect(placeOf({ hostName: 'beta', pidNamespace: 'pid:[4026531836]' })).not.toBe(base)
		expect(placeOf({ hostName: 'alpha', pidNamespace: 'pid:[4026532999]' })).not.toBe(base)
	})

	it('falls back to the host name alone where the namespace cannot be read', () => {
		const alone = placeOf({ hostName: 'alpha' })
		expect(alone).toMatch(/^[0-9a-f]{12}$/)
		expect(placeOf({ hostName: 'alpha', pidNamespace: undefined })).toBe(alone)
		expect(placeOf({ hostName: 'alpha', pidNamespace: 'pid:[1]' })).not.toBe(alone)
		expect(placeOf({ hostName: 'beta' })).not.toBe(alone)
	})

	it('differs for two machines that share a host name and the initial namespace, when each has an identity', () => {
		const ns = 'pid:[4026531836]'
		const one = placeOf({ hostName: 'ubuntu', pidNamespace: ns, machineId: 'a'.repeat(32) })
		const two = placeOf({ hostName: 'ubuntu', pidNamespace: ns, machineId: 'b'.repeat(32) })
		expect(one).not.toBe(two)
		expect(placeOf({ hostName: 'ubuntu', pidNamespace: ns, machineId: 'a'.repeat(32) })).toBe(one)
		// A machine whose identity cannot be read keeps the old material.
		expect(placeOf({ hostName: 'ubuntu', pidNamespace: ns })).not.toBe(one)
	})

	it('does not carry the host name or the machine identity in the token', () => {
		const token = placeOf({ hostName: 'ubuntu', machineId: 'c'.repeat(32) })
		expect(token).not.toContain('ubuntu')
		expect(token).not.toContain('cccc')
	})
})
