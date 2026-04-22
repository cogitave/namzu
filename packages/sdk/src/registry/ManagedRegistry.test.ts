/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 3):
 *
 *   - `ManagedRegistry` extends `Registry` with a component-named
 *     logger + two optional id-extraction strategies: `idField` or
 *     `computeId`. `computeId` takes precedence when both are set.
 *   - `register(id, item)` (2-arg): throws when `item` is missing;
 *     warn-logs + overwrites on duplicate id (no typed error).
 *   - `register(item)` (1-arg): extracts id via computeId/idField;
 *     throws when neither is configured.
 *   - `register(items[])`: batch-registers (recursively calls the
 *     single-arg path for each). Any failure in a single register
 *     throws and aborts the batch (no partial-success semantics).
 *   - `getOrThrow(id)`: returns the item; throws
 *     `new Error("Not found: <id>. Available: <csv of known ids>")`
 *     — a plain `Error`, NOT a typed `XYZNotFoundError` (Codex #1).
 *   - No start / stop lifecycle exists (design §2.3 claim was
 *     fictional).
 */

import { describe, expect, it, vi } from 'vitest'

import type { Logger } from '../utils/logger.js'

import { ManagedRegistry } from './ManagedRegistry.js'

function makeLogger(): Logger {
	const self = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn(),
	} as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

interface Item {
	id: string
	info: { id: string }
	value: number
}

describe('ManagedRegistry', () => {
	describe('register (2-arg form)', () => {
		it('throws when called with (id) only', () => {
			const r = new ManagedRegistry<Item>({ componentName: 't' })
			// biome-ignore lint/suspicious/noExplicitAny: exercises the no-item-arg path
			expect(() => (r as any).register('a')).toThrow(/requires an item argument/)
		})

		it('warn-logs then overwrites on duplicate id', () => {
			const logger = makeLogger()
			const r = new ManagedRegistry<Item>({ componentName: 't', logger })
			const a = { id: 'a', info: { id: 'a' }, value: 1 }
			const b = { id: 'a', info: { id: 'a' }, value: 2 }
			r.register('a', a)
			r.register('a', b)
			expect(r.get('a')?.value).toBe(2)
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"a" already registered'))
		})
	})

	describe('register (single-item form)', () => {
		it('uses idField when computeId is not set', () => {
			const r = new ManagedRegistry<Item>({ componentName: 't', idField: 'id' })
			r.register({ id: 'a', info: { id: 'nested' }, value: 1 })
			expect(r.get('a')).toBeDefined()
			expect(r.get('nested')).toBeUndefined()
		})

		it('computeId takes precedence over idField when both are set', () => {
			const r = new ManagedRegistry<Item>({
				componentName: 't',
				idField: 'id',
				computeId: (item) => item.info.id,
			})
			r.register({ id: 'top', info: { id: 'nested' }, value: 1 })
			expect(r.get('nested')).toBeDefined()
			expect(r.get('top')).toBeUndefined()
		})

		it('throws when neither idField nor computeId is configured', () => {
			const r = new ManagedRegistry<Item>({ componentName: 't' })
			expect(() => r.register({ id: 'a', info: { id: 'a' }, value: 1 })).toThrow(
				/requires idField or computeId/,
			)
		})
	})

	describe('register (array form)', () => {
		it('batch-registers via the single-item path', () => {
			const r = new ManagedRegistry<Item>({ componentName: 't', idField: 'id' })
			r.register([
				{ id: 'a', info: { id: 'a' }, value: 1 },
				{ id: 'b', info: { id: 'b' }, value: 2 },
			])
			expect(r.listIds()).toEqual(['a', 'b'])
		})
	})

	describe('getOrThrow', () => {
		it('returns the item when present', () => {
			const r = new ManagedRegistry<Item>({ componentName: 't', idField: 'id' })
			const a = { id: 'a', info: { id: 'a' }, value: 1 }
			r.register(a)
			expect(r.getOrThrow('a')).toBe(a)
		})

		it('throws a plain Error naming the missing id + available ids', () => {
			const r = new ManagedRegistry<Item>({ componentName: 't', idField: 'id' })
			r.register({ id: 'a', info: { id: 'a' }, value: 1 })
			r.register({ id: 'b', info: { id: 'b' }, value: 2 })
			expect(() => r.getOrThrow('missing')).toThrow(/Not found: "missing"\. Available: a, b/)
		})
	})
})
