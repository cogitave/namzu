/**
 * Provenance against a reference model: random edits, each character of the
 * model remembering whether it was typed, and the span bookkeeping has to
 * agree after every step. Seeded, so a failure names its seed and replays.
 */

import { describe, expect, it } from 'vitest'

import {
	type Edit,
	type EditOrigin,
	type Span,
	applyEdit,
	diffEdit,
	overrideMap,
	replaceAll,
	shiftOverrides,
} from './provenance.js'

/** Mulberry32: small, seeded, good enough to drive edits. */
function random(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const ORIGINS: readonly EditOrigin[] = [
	'typed',
	'typed',
	'typed',
	'burst',
	'pasted',
	'yank',
	'completion',
]

function spansOf(typed: readonly boolean[]): Span[] {
	const spans: [number, number][] = []
	typed.forEach((isTyped, index) => {
		if (isTyped) return
		const last = spans[spans.length - 1]
		if (last && last[1] === index) last[1] = index + 1
		else spans.push([index, index + 1])
	})
	return spans
}

describe('provenance', () => {
	it.each([1, 2, 3, 4, 5, 6, 7, 8])(
		'agrees with a per-character model over 400 random edits (seed %i)',
		(seed) => {
			const next = random(seed)
			let text = ''
			let typed: boolean[] = []
			let spans: Span[] = []
			for (let step = 0; step < 400; step += 1) {
				const start = Math.floor(next() * (text.length + 1))
				const deleteEnd = start + Math.floor(next() * Math.min(4, text.length - start + 1))
				const insert = 'abcxyz '.slice(0, Math.floor(next() * 4))
				const origin = ORIGINS[Math.floor(next() * ORIGINS.length)] as EditOrigin
				const edit: Edit = { start, deleteEnd, insertLength: insert.length }
				text = text.slice(0, start) + insert + text.slice(deleteEnd)
				typed = [
					...typed.slice(0, start),
					...Array.from({ length: insert.length }, () => origin === 'typed'),
					...typed.slice(deleteEnd),
				]
				spans = applyEdit(spans, edit, origin)
				expect(spans, `seed ${seed}, step ${step}`).toEqual(spansOf(typed))
			}
		},
	)

	it.each([11, 12, 13, 14])('finds an edit that rebuilds the next draft (seed %i)', (seed) => {
		const next = random(seed)
		let text = 'save it as a skill'
		for (let step = 0; step < 300; step += 1) {
			const start = Math.floor(next() * (text.length + 1))
			const deleteEnd = start + Math.floor(next() * Math.min(3, text.length - start + 1))
			const insert = 'aas '.slice(0, Math.floor(next() * 3))
			const after = text.slice(0, start) + insert + text.slice(deleteEnd)
			// The cursor before the edit: where it started (typing) or ended (backspace).
			const cursor = next() < 0.5 ? start : deleteEnd
			const edit = diffEdit(text, after, cursor)
			expect(
				text.slice(0, edit.start) +
					after.slice(edit.start, edit.start + edit.insertLength) +
					text.slice(edit.deleteEnd),
				`seed ${seed}, step ${step}`,
			).toBe(after)
			expect(edit.start).toBeLessThanOrEqual(cursor)
			text = after
		}
	})

	it('places an insertion at the cursor, not at the first matching character', () => {
		// "ab" + "b" at 1: the shared prefix would say 2; the cursor says 1.
		expect(diffEdit('ab', 'abb', 1)).toEqual({ start: 1, deleteEnd: 1, insertLength: 1 })
	})

	it('replaces a whole draft as typed or not', () => {
		expect(replaceAll(5, 'typed')).toEqual([])
		expect(replaceAll(5, 'recalled')).toEqual([[0, 5]])
		expect(replaceAll(0, 'editor')).toEqual([])
	})

	it('keeps an Alt+W decision through edits around the words, and forgets it on an edit inside them', () => {
		const dropped = [{ id: 'hypermode', start: 4, end: 13, state: 'dropped' as const }]
		// Typing before the words moves the decision with them.
		expect(shiftOverrides(dropped, { start: 0, deleteEnd: 0, insertLength: 2 })).toEqual([
			{ id: 'hypermode', start: 6, end: 15, state: 'dropped' },
		])
		// Typing right after the words keeps it where it is.
		expect(shiftOverrides(dropped, { start: 13, deleteEnd: 13, insertLength: 1 })).toEqual(dropped)
		// A keystroke inside the words is the operator saying them again.
		expect(shiftOverrides(dropped, { start: 8, deleteEnd: 8, insertLength: 1 })).toEqual([])
		expect(shiftOverrides(dropped, { start: 12, deleteEnd: 13, insertLength: 0 })).toEqual([])
		expect(overrideMap(dropped).get('hypermode@4')).toBe('dropped')
	})
})
