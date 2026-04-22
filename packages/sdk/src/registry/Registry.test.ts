/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 3):
 *
 *   - `register(id, item)` silently overwrites an existing entry —
 *     NO duplicate-error is thrown (Codex #1 verified the design
 *     §2.3 "typed DuplicateRegistrationError" claim was fiction).
 *   - `get(id)` returns `undefined` for an unknown id (NOT a typed
 *     error). `getAll`, `listIds`, `has`, `size` reflect the current
 *     `Map` state; iteration order follows insertion order.
 *   - `unregister(id)` returns true if the entry existed (and was
 *     deleted), false otherwise.
 *   - `clear()` empties the map.
 *   - The generic `Registry<T>` has no component name, no logger, no
 *     lifecycle. All enrichment (logs, idField inference, lifecycle)
 *     happens in `ManagedRegistry`, not here.
 */

import { describe, expect, it } from 'vitest'

import { Registry } from './Registry.js'

interface Item {
	id: string
	value: number
}

describe('Registry', () => {
	it('register + get + has roundtrip', () => {
		const r = new Registry<Item>()
		const a: Item = { id: 'a', value: 1 }
		r.register('a', a)
		expect(r.get('a')).toBe(a)
		expect(r.has('a')).toBe(true)
		expect(r.get('b')).toBeUndefined()
		expect(r.has('b')).toBe(false)
	})

	it('register silently overwrites an existing key', () => {
		const r = new Registry<Item>()
		r.register('a', { id: 'a', value: 1 })
		r.register('a', { id: 'a', value: 2 })
		expect(r.get('a')?.value).toBe(2)
		expect(r.size()).toBe(1)
	})

	it('listIds reflects insertion order', () => {
		const r = new Registry<Item>()
		r.register('x', { id: 'x', value: 1 })
		r.register('y', { id: 'y', value: 2 })
		r.register('z', { id: 'z', value: 3 })
		expect(r.listIds()).toEqual(['x', 'y', 'z'])
	})

	it('getAll returns every item in insertion order', () => {
		const r = new Registry<Item>()
		const items = [
			{ id: 'a', value: 1 },
			{ id: 'b', value: 2 },
		]
		for (const item of items) r.register(item.id, item)
		expect(r.getAll()).toEqual(items)
	})

	it('unregister returns true iff the key existed', () => {
		const r = new Registry<Item>()
		r.register('a', { id: 'a', value: 1 })
		expect(r.unregister('a')).toBe(true)
		expect(r.unregister('a')).toBe(false)
		expect(r.get('a')).toBeUndefined()
	})

	it('clear empties the map', () => {
		const r = new Registry<Item>()
		r.register('a', { id: 'a', value: 1 })
		r.register('b', { id: 'b', value: 2 })
		r.clear()
		expect(r.size()).toBe(0)
		expect(r.getAll()).toEqual([])
	})

	it('size matches the map size', () => {
		const r = new Registry<Item>()
		expect(r.size()).toBe(0)
		r.register('a', { id: 'a', value: 1 })
		expect(r.size()).toBe(1)
		r.register('a', { id: 'a', value: 2 }) // overwrite
		expect(r.size()).toBe(1)
		r.register('b', { id: 'b', value: 3 })
		expect(r.size()).toBe(2)
	})
})
