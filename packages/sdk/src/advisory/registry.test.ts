/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 6):
 *
 *   - `AdvisorRegistry` extends the plain `Registry<AdvisorDefinition>`
 *     (NOT `ManagedRegistry` — no warn-log, direct register via `Map.set`).
 *   - Constructor registers every advisor immediately.
 *   - `resolve(advisorId?, domain?)` resolution priority:
 *     1. Explicit `advisorId` (even if unknown — returns undefined).
 *     2. Domain match — first advisor whose `domains[]` includes the domain.
 *     3. Explicit `defaultId`.
 *     4. First registered advisor.
 *     5. Undefined when nothing is registered.
 *   - `listAll()` returns everything in insertion order.
 */

import { describe, expect, it } from 'vitest'

import type { AdvisorDefinition } from '../types/advisory/index.js'
import type { LLMProvider } from '../types/provider/index.js'

import { AdvisorRegistry } from './registry.js'

const provider = {} as LLMProvider

function makeAdvisor(id: string, domains?: string[]): AdvisorDefinition {
	return {
		id,
		name: id,
		provider,
		model: 'opus',
		domains,
	}
}

describe('AdvisorRegistry', () => {
	it('registers every advisor from the constructor array', () => {
		const r = new AdvisorRegistry([makeAdvisor('a'), makeAdvisor('b')])
		expect(r.listAll().map((a) => a.id)).toEqual(['a', 'b'])
	})

	describe('resolve priority', () => {
		it('returns the advisor for an explicit advisorId', () => {
			const r = new AdvisorRegistry([makeAdvisor('a'), makeAdvisor('b')])
			expect(r.resolve('b')?.id).toBe('b')
		})

		it('returns undefined for an explicit unknown advisorId (does NOT fall through)', () => {
			const r = new AdvisorRegistry([makeAdvisor('a')])
			expect(r.resolve('unknown')).toBeUndefined()
		})

		it('matches first advisor with a matching domain when no advisorId', () => {
			const r = new AdvisorRegistry([
				makeAdvisor('sec', ['security']),
				makeAdvisor('perf', ['performance']),
			])
			expect(r.resolve(undefined, 'performance')?.id).toBe('perf')
		})

		it('falls back to defaultId when no advisorId and no matching domain', () => {
			const r = new AdvisorRegistry([makeAdvisor('a'), makeAdvisor('b')], 'b')
			expect(r.resolve(undefined, 'nope')?.id).toBe('b')
		})

		it('falls back to first registered advisor when no default', () => {
			const r = new AdvisorRegistry([makeAdvisor('first'), makeAdvisor('second')])
			expect(r.resolve(undefined, 'nope')?.id).toBe('first')
		})

		it('returns undefined on an empty registry with no context', () => {
			const r = new AdvisorRegistry([])
			expect(r.resolve()).toBeUndefined()
		})
	})
})
