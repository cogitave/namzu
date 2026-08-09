/**
 * Parse a growing markdown document without re-parsing what has not changed.
 *
 * ## The cost this removes
 *
 * A streaming assistant reply is one message whose text grows by a token at a
 * time, and the row rendering it re-renders on every one of them. Parsing the
 * whole message each time makes the work quadratic in the reply's length: a
 * forty-block answer is parsed forty blocks deep on every token, when
 * thirty-nine of those blocks are byte-for-byte what they were a token ago.
 *
 * So the document is scanned into top-level blocks — cheap, one pass over the
 * lines — and only the blocks that are new are parsed. The rest come back as
 * **the same objects**, which is the half that matters to the renderer:
 * `BlockView` is memoised, so an unchanged block is not re-rendered, not
 * re-split into inline spans, and not turned into fresh elements either.
 *
 * ## Why raw text is a sound key
 *
 * `parseBlock` reads only the segment it is given: nothing in this markdown
 * subset makes one block's meaning depend on another (there are no
 * reference-style link definitions, which is the construct that would). Same
 * segment ⇒ same block, so a hit cannot differ from a fresh parse. The
 * `markdownParser` docblock states that property; it is the contract this file
 * depends on, and it is why there is no "give up on caching when the document
 * contains X" escape hatch here. There is no such X.
 *
 * ## Why the last two blocks are never cached
 *
 * Not for correctness — a key is a whole segment, so a block whose text grows
 * simply misses under its new text and is parsed. It is to keep the cache from
 * accumulating garbage: a block that is still being written passes through
 * every one of its own prefixes, and storing them would put an entry per TOKEN
 * into a structure meant to hold an entry per block. That is the memory the
 * quadratic parse was costing, moved rather than removed.
 *
 * Two, not one, because the block still being written is not always the last
 * segment. A half-typed table row is not yet a table row — `| 1 | 2` has no
 * closing pipe — so it scans as a paragraph of its own, and the table above it
 * becomes the second-to-last segment while still growing a row at a time. One
 * excluded segment would have cached that table once per row, at increasing
 * size. The line being typed can reach back exactly one segment and no further:
 * it can be absorbed by the block above it, and that block is maximal, so there
 * is nothing for it to reach past.
 *
 * The cost of the wider exclusion is one extra parse per block over the life of
 * the message, against a saving of one per block per token.
 */

import { type MdBlock, parseBlock, scanBlocks } from './markdownParser.js'

export interface BlockCache {
	/** Blocks of `src`, reusing the block objects of unchanged segments. */
	parse(src: string): MdBlock[]
	/** How many segments are being held. One per completed block. */
	readonly size: number
}

export function createBlockCache(): BlockCache {
	const blocks = new Map<string, MdBlock>()
	return {
		parse(src: string): MdBlock[] {
			const segments = scanBlocks(src)
			const settled = segments.length - 2
			return segments.map((segment, i) => {
				// The tail is where the text is still being written, so it is parsed
				// every time and stored never.
				if (i >= settled) return parseBlock(segment)
				const hit = blocks.get(segment)
				if (hit) return hit
				const parsed = parseBlock(segment)
				blocks.set(segment, parsed)
				return parsed
			})
		},
		get size() {
			return blocks.size
		},
	}
}
