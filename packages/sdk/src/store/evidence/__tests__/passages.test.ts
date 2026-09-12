import { expect, it } from 'vitest'
import { passageMatcher, passagesInWindow } from '../passages.js'

it.each([true, false])(
	'always advances on dense astral matches (caseSensitive=%s)',
	(caseSensitive) => {
		const text = '🦉'.repeat(2000)
		const match = passageMatcher('🦉', caseSensitive)
		let from = 0
		const offsets = []
		for (let pages = 0; pages < 30 && from < text.length; pages++) {
			const page = passagesInWindow(text, from, match, 1)
			expect(page.next).toBeGreaterThan(from)
			expect(page.next % 2).toBe(0)
			for (const p of page.passages) {
				expect(p.start % 2).toBe(0)
				expect(p.end % 2).toBe(0)
				offsets.push(p.hit)
			}
			from = page.next
		}
		expect(from).toBe(text.length)
		expect(new Set(offsets).size).toBe(offsets.length)
	},
)

it('does not duplicate hits wholly covered by one excerpt', () => {
	const text = 'DELTA one DELTA two'
	const page = passagesInWindow(text, 0, passageMatcher('delta', false), 4)
	expect(page.passages).toHaveLength(1)
	expect(page.next).toBe(text.length)
})

it('uses locale-independent simple Unicode case matching', () => {
	expect(passageMatcher('i', false)('İ', 0)).toBeUndefined()
	expect(passageMatcher('ss', false)('ß', 0)).toBeUndefined()
	expect(passageMatcher('k', false)('K', 0)?.hit).toBe(0)
})

it.each([
	['in', 'Packing information', 'in'],
	['code', 'decoder', 'code'],
	['3', '13000', '3'],
	['id_1', 'id_100', 'ID_1'],
	['İZMİR', 'İZMİRLİ', 'İZMİR'],
	['k', 'prefix_k', 'K'],
	['𐐀', '𐐀tail', '𐐨'],
])('discovers complete tokens for %s without changing literal search', (term, noise, target) => {
	const text = `${noise} ${target}`
	expect(passageMatcher(term, false)(text, 0)).toBeDefined()
	expect(passageMatcher(term, false, 'token')(text, 0)?.hit).toBe(noise.length + 1)
	expect(passageMatcher(term, false, 'token')(noise, 1)).toBeUndefined()
})

it('uses the ranking lowercase key rather than regex simple-folding in token mode', () => {
	expect(passageMatcher('s', false)('ſ', 0)).toBeDefined()
	expect(passageMatcher('s', false, 'token')('ſ', 0)).toBeUndefined()
	expect(passageMatcher('İ', false, 'token')('i', 0)).toBeUndefined()
	expect(passageMatcher('delta', true, 'token')('DELTA', 0)).toBeUndefined()
})

it('keeps long token matches crossing excerpt ends, without accepting mid-token suffixes', () => {
	const long = 'B'.repeat(256)
	const text = `A ${' '.repeat(430)}${long} ${' '.repeat(600)}A`
	let next = 0
	const excerpts = []
	for (let i = 0; i < 8 && next < text.length; i++) {
		const page = passagesInWindow(text, next, passageMatcher(['A', long], true, 'token'), 1)
		expect(page.next).toBeGreaterThan(next)
		excerpts.push(...page.passages.map((p) => text.slice(p.start, p.end)))
		next = page.next
	}
	expect(next).toBe(text.length)
	expect(excerpts).toHaveLength(3)
	expect(excerpts.some((text) => text.includes(long))).toBe(true)
})

it('finds mixed-length literals without regex expansion or duplicate short matches', () => {
	const text = `${'x '.repeat(240)}${'LONG'.repeat(40)} ${'[a].*'} ${'x '.repeat(400)}`
	const matcher = passageMatcher(['LONG'.repeat(40), '[a].*', 'x'], true)
	let from = 0
	const excerpts: string[] = []
	for (let i = 0; i < 10 && from < text.length; i++) {
		const page = passagesInWindow(text, from, matcher, 1)
		expect(page.next).toBeGreaterThan(from)
		excerpts.push(...page.passages.map((p) => text.slice(p.start, p.end)))
		from = page.next
	}
	expect(from).toBe(text.length)
	expect(excerpts.length).toBeLessThanOrEqual(5)
	expect(excerpts.some((text) => text.includes('LONG'.repeat(40)))).toBe(true)
	expect(excerpts.some((text) => text.includes('[a].*'))).toBe(true)
	expect(passageMatcher(['[a].*', '🦉'], false)('abc', 0)).toBeUndefined()
})
