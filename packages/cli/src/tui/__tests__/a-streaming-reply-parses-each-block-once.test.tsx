/**
 * A reply that arrives a token at a time is parsed a block at a time.
 *
 * The pending row is the only row that re-renders, and it re-rendered the whole
 * message: a forty-block answer was parsed forty blocks deep on every token, so
 * the cost of streaming a reply grew with the square of its length. The fix is a
 * per-block cache keyed on the block's raw text.
 *
 * ## What these tests are written against
 *
 * Two things can go wrong, and each has its own test here.
 *
 * The first is CORRECTNESS: a cache that hands back a block the document no
 * longer says. The property that catches it is that a single long-lived cache,
 * fed every prefix of a document in order, must agree with a fresh
 * `parseMarkdown` on every one of those prefixes — an unterminated fence, a
 * table that only becomes a table when its separator arrives, a paragraph
 * still growing. A test that checked the finished document alone would pass
 * for a cache that is wrong for the whole length of the stream and right at
 * the end, which is the entire interval the operator is looking at.
 *
 * The second is that the cache is not REACHED. `Markdown` is where the saving
 * has to happen, so the counting tests drive the rendered component rather than
 * the cache: a unit test on the helper stays green if the component goes back
 * to calling `parseMarkdown` directly, which is the defect these exist for.
 *
 * The count is scale-checked rather than compared to one number. Parse calls
 * per token is ~1 with the cache and ~blocks/2 without, so a single fixture can
 * be passed by accident at a size where the two are close; measuring the same
 * ratio at two document sizes cannot be.
 */

import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import { createBlockCache } from '../markdown-block-cache.js'
import { parseMarkdown } from '../markdownParser.js'

/**
 * Counts real parse calls, and delegates.
 *
 * Mocked at the module the cache imports from, so what is counted is the work
 * the cache actually performs. `parseMarkdown` is left genuine — it calls its
 * own local `parseBlock` and so is both an honest oracle and uncounted.
 */
let parseCalls = 0
let inlineCalls = 0
vi.mock('../markdownParser.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../markdownParser.js')>()
	return {
		...actual,
		parseBlock: (raw: string) => {
			parseCalls++
			return actual.parseBlock(raw)
		},
		// The other half of the cost, and the one the memo on `BlockView` is
		// there for: a cached block still costs a full inline re-parse if the
		// view that renders it re-runs.
		parseInline: (text: string) => {
			inlineCalls++
			return actual.parseInline(text)
		},
	}
})

const { Markdown } = await import('../Markdown.js')

/** A document with every construct the parser knows, `blocks` blocks long. */
function document(blocks: number): string {
	const out: string[] = []
	for (let i = 0; i < blocks; i++) {
		switch (i % 5) {
			case 0:
				out.push(`## Section ${i}`)
				break
			case 1:
				out.push(`Some **prose** about section ${i} with \`code\` in it.`)
				break
			case 2:
				out.push(`- a bullet in section ${i}`)
				break
			case 3:
				out.push(`\`\`\`ts\nconst section${i} = ${i}\n\`\`\``)
				break
			default:
				out.push(`| A${i} | B${i} |\n|---|---|\n| 1 | 2 |`)
				break
		}
	}
	return out.join('\n\n')
}

/** Every prefix of `src`, in order, growing by `step` characters. */
function prefixes(src: string, step: number): string[] {
	const out: string[] = []
	for (let n = step; n < src.length; n += step) out.push(src.slice(0, n))
	out.push(src)
	return out
}

describe('the block cache', () => {
	it('agrees with a fresh parse at every point in the stream', () => {
		// Deliberately awkward: a fence that is open for several prefixes before
		// it closes, a `| … |` line that is a paragraph until its separator
		// arrives, and a paragraph that keeps growing. Each is a case where the
		// LAST block means something different a token later.
		const src = [
			'Intro line one',
			'still the same paragraph',
			'',
			'```ts',
			'const x = 1',
			'const y = 2',
			'```',
			'',
			'| A | B |',
			'|---|---|',
			'| 1 | 2 |',
			'',
			'- one',
			'- two',
			'',
			'## Heading',
			'',
			'trailing prose',
		].join('\n')

		const cache = createBlockCache()
		for (const prefix of prefixes(src, 3)) {
			expect(cache.parse(prefix), `disagreed at ${JSON.stringify(prefix.slice(-24))}`).toEqual(
				parseMarkdown(prefix),
			)
		}
	})

	it('serves a second, unrelated message without leaking the first', () => {
		// One cache outlives one message, and this is why the key is the block's
		// text rather than its position. The pending row is a single mounted
		// component at a fixed place in the tree: when one streaming reply is
		// finalized and the next begins, React reuses that instance — same
		// component, same hooks, same cache — and the text under it is replaced
		// wholesale rather than appended to.
		//
		// A cache keyed on position answers every question in the second message
		// with the first message's blocks, and is otherwise indistinguishable:
		// under append-only growth a settled block never moves. This is the case
		// that separates them.
		const first = ['# First message', '', 'about one thing', '', '- alpha', '- beta'].join('\n')
		const second = ['## Second message', '', 'about something else', '', '1. one'].join('\n')

		const cache = createBlockCache()
		for (const prefix of prefixes(first, 3)) cache.parse(prefix)
		for (const prefix of prefixes(second, 3)) {
			expect(cache.parse(prefix), `the previous message leaked into ${prefix.length}`).toEqual(
				parseMarkdown(prefix),
			)
		}
	})

	it('grows with the document, not with the stream', () => {
		// The reason the tail is never stored. A block still being written passes
		// through every one of its own prefixes, so caching it would put an entry
		// per TOKEN into a structure meant to hold an entry per block — moving the
		// cost rather than removing it.
		//
		// Asserted by delivering the SAME document at two token sizes. A count
		// against one number would have to be an exact prediction of how the
		// scanner segments a half-typed table, which is a fact about the fixture;
		// that the two counts agree is a fact about the cache.
		const src = document(12)
		const blocks = parseMarkdown(src).length
		const coarse = createBlockCache()
		const fine = createBlockCache()
		const coarseStream = prefixes(src, 16)
		const fineStream = prefixes(src, 1)
		for (const prefix of coarseStream) coarse.parse(prefix)
		for (const prefix of fineStream) fine.parse(prefix)

		expect(
			fineStream.length,
			'the two streams are too alike to tell a per-token cache apart',
		).toBeGreaterThan(coarseStream.length * 8)
		expect(fine.size, 'the cache grew with the number of tokens').toBe(coarse.size)
		expect(fine.size, 'the cache holds more than the document has blocks').toBeLessThanOrEqual(
			blocks,
		)
	})
})

describe('a message streaming into <Markdown>', () => {
	/** Stream `src` into a mounted `<Markdown>`, and return what parsing it cost. */
	function streamCost(
		src: string,
		step: number,
	): { calls: number; inline: number; renders: number } {
		const stream = prefixes(src, step)
		parseCalls = 0
		inlineCalls = 0
		const first = stream[0] ?? ''
		const harness = render(<Markdown text={first} />)
		try {
			for (const prefix of stream.slice(1)) harness.rerender(<Markdown text={prefix} />)
		} finally {
			harness.unmount()
		}
		return { calls: parseCalls, inline: inlineCalls, renders: stream.length }
	}

	it('parses each block once, so the cost tracks tokens rather than tokens × blocks', () => {
		const src = document(20)
		const blocks = parseMarkdown(src).length
		const { calls, inline, renders } = streamCost(src, 16)

		// With the cache: the two-segment tail on every render, plus one parse for
		// each block as it settles. Without it: every block on every render, which
		// at twenty blocks is an order of magnitude more.
		expect(calls, 'the whole message was re-parsed on each token').toBeLessThanOrEqual(
			renders * 2 + blocks,
		)
		// And it is doing the work, rather than returning something stale: the
		// block currently being written is parsed on every render.
		expect(calls, 'the pending block stopped being re-parsed').toBeGreaterThanOrEqual(renders)
		// Half the saving is thrown away if the views re-run over the cached
		// blocks anyway: `parseInline` is per block, per render, and it is the
		// more expensive half. A reused block object is what lets the memo hold.
		expect(inline, 'every block was re-rendered on each token').toBeLessThanOrEqual(
			renders * 3 + blocks * 2,
		)
	})

	it('costs the same per token at four times the document size', () => {
		// The axis a single fixture hides. Parse calls per token are ~1 with the
		// cache at any size, and ~blocks/2 without — so an uncached renderer looks
		// merely expensive on a short document and quadratic only when the two
		// sizes are compared. Same step, so a token means the same thing in both.
		const small = streamCost(document(6), 16)
		const large = streamCost(document(24), 16)

		const smallPerToken = small.calls / small.renders
		const largePerToken = large.calls / large.renders
		expect(
			largePerToken,
			`cost per token grew with the document: ${smallPerToken.toFixed(2)} → ${largePerToken.toFixed(2)}`,
		).toBeLessThan(smallPerToken * 1.5)

		const smallInline = small.inline / small.renders
		const largeInline = large.inline / large.renders
		expect(
			largeInline,
			`inline re-parses per token grew with the document: ${smallInline.toFixed(2)} → ${largeInline.toFixed(2)}`,
		).toBeLessThan(smallInline * 1.5)
	})
})
