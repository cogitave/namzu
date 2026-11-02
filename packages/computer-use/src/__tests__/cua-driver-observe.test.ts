import { describe, expect, it } from 'vitest'
import {
	type Observation,
	changeBetween,
	foldText,
	isCut,
	judgeEdit,
	judgeEditBetween,
	judgeObserved,
	observationOf,
	sameObservation,
} from '../adapters/cua-driver/observe.js'

const SEP = '\u0000'
const seen = (...texts: [role: string, text: string][]): Observation => {
	const out = new Map<string, number>()
	for (const [role, text] of texts) {
		const key = `${role}${SEP}${text}`
		out.set(key, (out.get(key) ?? 0) + 1)
	}
	return out
}

describe('verifying an input by what the window shows', () => {
	it('verifies typed text that now appears, whatever its case, spacing or operator glyphs', () => {
		const before = seen(['Text', 'Expression is'], ['Text', 'Display is 0'])
		const after = seen(['Text', 'Expression is 7 × 6='], ['Text', 'Display is 42'])
		const verdict = judgeObserved({ typed: '7*6=' }, { before, after })
		expect(verdict).toMatchObject({
			delivery: 'delivered_verified',
			retrySafety: 'unsafe',
			observed: 'Expression is 7 × 6=',
		})
	})

	it('does not verify typed text from a change that does not show it', () => {
		const before = seen(['Text', 'Clock 10:01'])
		const after = seen(['Text', 'Clock 10:02'])
		expect(judgeObserved({ typed: 'hello' }, { before, after })).toBeUndefined()
	})

	it('does not verify a short typed text from an unrelated label that happens to contain it', () => {
		const before = seen(['Text', 'Ready'])
		const after = seen(['Text', 'Saved at 10:01'])
		expect(judgeObserved({ typed: 'a' }, { before, after })).toBeUndefined()
		// the letter shown as a text of its own is evidence
		expect(
			judgeObserved(
				{ typed: 'a' },
				{ before: seen(['Text', 'Ready']), after: seen(['Text', 'Ready'], ['Text', 'a']) },
			),
		).toMatchObject({ delivery: 'delivered_verified' })
	})

	it('does not verify typed text that was already shown as often', () => {
		const before = seen(['Text', 'hello world'])
		const after = seen(['Text', 'hello world!!'])
		expect(judgeObserved({ typed: 'hello' }, { before, after })).toBeUndefined()
	})

	it('verifies a press by a change that held still and was not there before', () => {
		const before = seen(['Text', 'none'])
		const after = seen(['Text', 'submitted 1'])
		const verdict = judgeObserved({}, { before, after, earlier: before, later: after })
		expect(verdict).toMatchObject({ delivery: 'delivered_verified', observed: 'submitted 1' })
		expect(verdict?.detail).toMatch(/none/)
	})

	it('does not verify a press when nothing changed', () => {
		const same = seen(['Text', 'none'])
		expect(judgeObserved({}, { before: same, after: same })).toBeUndefined()
	})

	it('does not verify a press in a window that was changing by itself', () => {
		const before = seen(['Text', '10:01'])
		const after = seen(['Text', '10:02'])
		expect(judgeObserved({}, { before, after, earlier: seen(['Text', '10:00']) })).toBeUndefined()
		expect(judgeObserved({}, { before, after, later: seen(['Text', '10:03']) })).toBeUndefined()
	})

	it('counts repeated texts, so a second identical line is a change', () => {
		const before = seen(['Text', 'row'])
		const after = seen(['Text', 'row'], ['Text', 'row'])
		expect(changeBetween(before, after).added).toEqual(['row'])
		expect(sameObservation(before, after)).toBe(false)
	})

	it('folds case, spaces and operator glyphs', () => {
		expect(foldText('7 * 6 =')).toBe(foldText('7×6='))
		expect(foldText('A / B')).toBe(foldText('a÷b'))
	})
})

describe('verifying text sent to a classic edit control', () => {
	const read = { found: true, reason: '', done: true, seen: 'hello world' }

	it('verifies what the control reads back, and a set is safe to repeat', () => {
		expect(judgeEdit('set', 'hello world', read)).toMatchObject({
			ok: true,
			delivery: 'delivered_verified',
			retrySafety: 'safe',
			readBack: { expected: 'hello world', observed: 'hello world' },
		})
		expect(judgeEdit('type', 'abc', read)).toMatchObject({
			delivery: 'delivered_verified',
			retrySafety: 'unsafe',
		})
	})

	it('refuses a program with higher rights, and a read-only control, as not delivered', () => {
		for (const reason of ['uipi', 'read_only'])
			expect(judgeEdit('type', 'abc', { ...read, reason, done: false })).toMatchObject({
				ok: false,
				delivery: 'not_delivered',
				retrySafety: 'safe',
			})
	})

	it('never calls an unreadable or unanswered control not delivered', () => {
		for (const reason of ['hung', 'unreadable', 'refused'])
			expect(judgeEdit('set', 'abc', { ...read, reason, done: false })).toMatchObject({
				ok: true,
				delivery: 'delivered_unverified',
				retrySafety: 'unsafe',
			})
	})

	it('leaves a control that reads otherwise unconfirmed, with what it reads', () => {
		const verdict = judgeEdit('set', 'abc', { ...read, done: false, seen: 'ABC' })
		expect(verdict).toMatchObject({
			delivery: 'delivered_unverified',
			readBack: { observed: 'ABC' },
		})
	})

	it('judges a keyboard delivery by the control text before and after', () => {
		const before = { text: 'ab', len: 2 }
		expect(judgeEditBetween('cd', before, { text: 'abcd', len: 4 })).toMatchObject({
			delivery: 'delivered_verified',
			observed: 'abcd',
		})
		expect(judgeEditBetween('cd', before, { text: 'ab', len: 2 })).toBeUndefined()
		expect(judgeEditBetween('cd', before, { text: 'xy', len: 2 })).toBeUndefined()
		// A document longer than the read: growth alone is not evidence the text went in.
		expect(judgeEditBetween('cd', before, { text: 'ab', len: 4 })).toBeUndefined()
	})

	it('verifies keys typed one by one against the text so far', () => {
		let text = ''
		for (const key of ['a', 'b', 'c', 'a']) {
			const next = `${text}${key}`
			expect(
				judgeEditBetween(key, { text, len: text.length }, { text: next, len: next.length }),
			).toMatchObject({ delivery: 'delivered_verified' })
			// The same key typed again into text that already has it counts only when the text gained one.
			expect(
				judgeEditBetween(key, { text: next, len: next.length }, { text: next, len: next.length }),
			).toBeUndefined()
			text = next
		}
		expect(text).toBe('abca')
	})

	it('verifies by length when both reads were cut and the text grew by what was typed', () => {
		const cut = (len: number) => ({ text: 'x'.repeat(100), len })
		expect(judgeEditBetween('abc', cut(70000), cut(70003))).toMatchObject({
			delivery: 'delivered_verified',
		})
		expect(judgeEditBetween('abc', cut(70000), cut(70010))).toBeUndefined()
	})

	it('does not verify a control that already held the text and changed elsewhere', () => {
		const before = { text: 'hello world', len: 11 }
		expect(judgeEditBetween('hello', before, { text: 'hello world!!', len: 13 })).toBeUndefined()
		expect(judgeEditBetween('hello', before, { text: 'hello world hello', len: 17 })).toMatchObject(
			{
				delivery: 'delivered_verified',
			},
		)
	})
})

describe('a read that cannot show everything', () => {
	const tree = (value: string, count = 1) =>
		({
			nodes: [{ role: 'Edit', name: 'Body', element: { value } }],
			count,
		}) as unknown as Parameters<typeof observationOf>[0]

	it('is marked cut when a text is longer than what is kept, or the walk was cut', () => {
		expect(isCut(observationOf(tree('short')))).toBe(false)
		expect(isCut(observationOf(tree('x'.repeat(300))))).toBe(true)
		expect(isCut(observationOf(tree('short'), { walkCut: true }))).toBe(true)
	})

	it('does not count the mark as text that changed', () => {
		const a = observationOf(tree('short'), { walkCut: true })
		const b = observationOf(tree('short'))
		expect(sameObservation(a, b)).toBe(true)
	})
})
