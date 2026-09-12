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
