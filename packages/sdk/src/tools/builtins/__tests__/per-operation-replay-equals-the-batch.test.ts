import { describe, expect, it } from 'vitest'

import { type NormalizedEditInput, applyEdit, replayOperationsWithin } from '../edit-apply.js'

/**
 * The per-operation replay is only trustworthy if it is the batch.
 *
 * `applyEdit` is what the `edit` tool writes to disk with; `replayOperationsWithin`
 * is what a caller with no filesystem reconstructs that body with, one operation
 * at a time so each one's cost can be measured against the real string it is
 * about to be applied to. Two folds over the same operations, and the moment
 * they disagree the projection built on the second is claiming a body the file
 * does not have.
 *
 * Hand-written cases cover the shapes somebody thought of. This covers the ones
 * nobody did: a seeded generator over bodies that are LF, CRLF and deliberately
 * mixed — the mix is where the reconciliation in `normalizeLineEndings` turns
 * off, and where a predictor that assumed it was always on would be wrong — with
 * anchors that sometimes match, sometimes match twice, and sometimes match
 * nothing at all. The seed is fixed, so a failure here is a failure anybody can
 * reproduce by running the file again.
 */

/** mulberry32: a small, fast, fully deterministic PRNG. Same seed, same suite. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const TOKENS = ['alpha', 'beta', 'gamma', 'alpha beta', 'x', '\tindented', '', 'beta beta']

function makeBody(random: () => number): string {
	const style = random()
	const lineCount = 1 + Math.floor(random() * 6)
	const lines: string[] = []
	for (let i = 0; i < lineCount; i++) {
		lines.push(TOKENS[Math.floor(random() * TOKENS.length)] as string)
	}
	// A third LF, a third CRLF, a third a mix of the two in one body.
	const joined =
		style < 0.34
			? lines.join('\n')
			: style < 0.67
				? lines.join('\r\n')
				: lines
						.map((line, i) => line + (i === lines.length - 1 ? '' : i % 2 ? '\r\n' : '\n'))
						.join('')
	return random() < 0.5 ? `${joined}\n` : joined
}

function makeOperation(random: () => number, body: string): NormalizedEditInput {
	if (random() < 0.35) {
		return {
			operation: 'insert',
			insertLine: random() < 0.3 ? 'end' : Math.floor(random() * 8),
			newString: `${TOKENS[Math.floor(random() * TOKENS.length)]}${random() < 0.4 ? '\n' : ''}`,
			replace_all: false,
		}
	}
	// Half the anchors are cut out of the body itself, so they match — often
	// more than once, which is the branch `applyOne` refuses. The rest are
	// tokens that may or may not appear, and LF-spelled anchors against a CRLF
	// body, which is the reconciliation case.
	const start = Math.floor(random() * Math.max(body.length, 1))
	const oldString =
		random() < 0.5
			? body.slice(start, start + 1 + Math.floor(random() * 6))
			: (TOKENS[Math.floor(random() * TOKENS.length)] as string)
	return {
		operation: 'replace',
		oldString,
		newString: TOKENS[Math.floor(random() * TOKENS.length)] as string,
		replace_all: random() < 0.5,
	}
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER

describe('replaying one operation at a time is replaying the batch', () => {
	it('lands on the same body, or refuses in the same place, over 4,000 generated batches', () => {
		const random = seededRandom(0x5eed_4ed1)
		let replayed = 0
		let failed = 0

		for (let round = 0; round < 4_000; round++) {
			const body = makeBody(random)
			const operations: NormalizedEditInput[] = []
			const count = 1 + Math.floor(random() * 4)
			for (let i = 0; i < count; i++) operations.push(makeOperation(random, body))
			const shape = JSON.stringify({ body, operations })

			const batch = applyEdit(body, operations)
			const walked = replayOperationsWithin(body, operations, UNBOUNDED)

			if (batch.success) {
				replayed++
				expect(walked.outcome, shape).toBe('replayed')
				if (walked.outcome !== 'replayed') continue
				expect(walked.content, shape).toBe(batch.content)
				expect(walked.replacements, shape).toBe(batch.replacements)
			} else {
				failed++
				expect(walked.outcome, shape).toBe('failed')
				if (walked.outcome !== 'failed') continue
				// The same message, too: a caller that surfaced one of these would
				// otherwise be telling the model about a different refusal than the
				// tool's own.
				expect(walked.error, shape).toBe(batch.error)
			}

			// Step by step against the same fold, because a prediction wrong in
			// two places by the same amount would survive the aggregate above.
			let current = body
			let peak = 0
			for (const operation of operations) {
				const step = replayOperationsWithin(current, [operation], UNBOUNDED)
				const direct = applyEdit(current, [operation])
				if (!direct.success) {
					expect(step.outcome, shape).toBe('failed')
					break
				}
				expect(step.outcome, shape).toBe('replayed')
				if (step.outcome !== 'replayed') break
				expect(step.content, shape).toBe(direct.content)
				// The whole point of the walk: what the step was charged is what the
				// step materialised, exactly.
				expect(step.charged, shape).toBe(direct.content.length)
				current = direct.content
				peak = Math.max(peak, current.length)
			}
			if (walked.outcome === 'replayed') expect(walked.charged, shape).toBe(peak)
		}

		// A generator that only ever produced one of the two answers would pass
		// every assertion above and prove nothing about the other.
		expect(replayed).toBeGreaterThan(200)
		expect(failed).toBeGreaterThan(200)
	})

	it('never builds more than the allowance it was given', () => {
		const random = seededRandom(0x5eed_b0dd)
		let refused = 0

		for (let round = 0; round < 2_000; round++) {
			const body = makeBody(random)
			const operations: NormalizedEditInput[] = []
			const count = 1 + Math.floor(random() * 4)
			for (let i = 0; i < count; i++) operations.push(makeOperation(random, body))
			// Allowances from "nothing fits" to "everything fits", so both sides of
			// every refusal are exercised.
			const allowance = Math.floor(random() * (body.length * 2 + 4))
			const walked = replayOperationsWithin(body, operations, allowance)
			const shape = JSON.stringify({ body, operations, allowance })

			expect(walked.charged, shape).toBeLessThanOrEqual(allowance)
			expect(walked.charged, shape).toBeGreaterThanOrEqual(0)
			if (walked.outcome === 'replayed') {
				// An allowance never changes the answer, only whether there is one.
				expect(walked.content, shape).toBe(
					(applyEdit(body, operations) as { content: string }).content,
				)
				expect(walked.content.length, shape).toBeLessThanOrEqual(allowance)
			} else if (walked.outcome === 'refused') {
				refused++
			}
		}

		expect(refused).toBeGreaterThan(50)
	})
})
