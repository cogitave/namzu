/**
 * Renders parsed markdown blocks into Ink elements — the way assistant
 * replies are shown (code blocks, inline code, bold/italic, headings,
 * lists, tables). Only the constructs a terminal can render faithfully.
 *
 * Prose is wrapped here, to the width {@link ContentWidth} says the row has,
 * rather than left to Ink: Ink's wrap starts a row with the space it broke at
 * (see `markdown-wrap.ts`). Tables are laid out to the same width by
 * `markdown-table.ts`: a box when it fits, stacked records when it does not.
 *
 * Stylistic choices:
 *  - code blocks: code-colored lines and nothing beside them (no syntax
 *    highlighter dependency), so a selection copies the code and only the code.
 *  - inline code: a single code color, no background, so it stays legible.
 *  - headings: bold, told apart by level with attributes every terminal has:
 *    1 underlined accent, 2 accent, 3 body colour, 4-6 muted.
 *  - quotes: a border-colour bar (one cell and one space) on every row, text in
 *    the body colour, italic; a quote may hold any block, another quote too.
 *  - rules: a line of `─` in the border colour, up to 40 cells wide.
 *  - bullets: a fixed-width marker gutter so wrapped lines hang-indent.
 */

import { Box, Text } from 'ink'
import { Fragment, createContext, memo, useContext, useRef } from 'react'

import { type BlockCache, createBlockCache } from './markdown-block-cache.js'
import { QUOTE_BAR_WIDTH, headingStyle, ruleWidth } from './markdown-structure.js'
import { type TableSource, type TableSpan, layoutTable } from './markdown-table.js'
import {
	type DisplayLine,
	type DisplaySpan,
	inlineDisplaySpans,
	wrapSpans,
} from './markdown-wrap.js'
import type { MdBlock } from './markdownParser.js'
import { terminalDisplayText } from './terminal-display.js'
import { terminalWebHyperlink } from './terminal-hyperlinks.js'
import { useThemeEpoch } from './theme-store.js'
import { theme } from './theme.js'

/**
 * How many terminal cells the text beside a transcript gutter has.
 *
 * Provided by the transcript, which knows its padding and gutter and is the
 * one component that listens for resizes. Every row reads it from here rather
 * than subscribing itself: a listener per row put Node's "possible memory
 * leak" warning on the operator's screen past ten rows. Outside a transcript
 * it is an 80-column terminal less a transcript's margins.
 */
export const ContentWidth = createContext<number>(76)

/** The width text drawn here has, from the nearest {@link ContentWidth}. */
export function useContentWidth(): number {
	return Math.max(10, useContext(ContentWidth))
}

export interface MarkdownProps {
	readonly text: string
	/**
	 * How this text joins what was printed before it, for a reply drawn in parts:
	 * a new block (the default), the rest of an open paragraph, or the rest of an
	 * open code fence (whose language is `lang`). The parts drawn one under another
	 * are the rows the whole reply has.
	 */
	readonly join?: 'block' | 'text' | 'code'
	readonly lang?: string
	/** The type of the block printed before this text, for the blank row between them. */
	readonly lead?: MdBlock['type'] | null
	readonly color?: string
	/** Emit admitted HTTP(S) labels as OSC 8 links on a known-capable terminal. */
	readonly hyperlinks?: boolean
}

/**
 * A message's markdown, parsed incrementally.
 *
 * The cache is per mounted component, so it lives exactly as long as the row
 * it serves and is collected with it — a module-level one would hold every
 * block of every message for the life of the process, which is the shape of
 * the retention problem the transcript already had to solve once.
 *
 * The blocks it returns are reused between renders when their source text has
 * not changed, and {@link BlockView} is memoised on them, so a streaming reply
 * re-renders only the block currently being written. See
 * `markdown-block-cache.ts` for why the key is the block's raw text and why
 * the tail of the document is never stored.
 */
export function Markdown({
	text,
	color = theme.text.primary,
	hyperlinks = false,
	join = 'block',
	lang,
	lead = null,
}: MarkdownProps) {
	const cache = useRef<BlockCache>(undefined)
	cache.current ??= createBlockCache()
	const shown = terminalDisplayText(text)
	// The rest of an open code fence is read with the opener it lost.
	const source = join === 'code' ? `\`\`\`${lang ?? ''}\n${shown}` : shown
	const blocks = cache.current.parse(source, join === 'text' ? 'text' : undefined)
	const width = useContentWidth()
	return (
		<BlockList
			blocks={blocks}
			color={color}
			hyperlinks={hyperlinks}
			width={width}
			lead={join === 'block' ? lead : 'join'}
		/>
	)
}

/** Blocks one under another with the blank row between them; a quote holds one of these. */
function BlockList({
	blocks,
	color,
	hyperlinks,
	width,
	italic = false,
	lead = null,
}: {
	readonly blocks: readonly MdBlock[]
	readonly color: string
	readonly hyperlinks: boolean
	readonly width: number
	readonly italic?: boolean
	/** What stands before the first block: nothing, a block, or the text this continues. */
	readonly lead?: MdBlock['type'] | 'join' | null
}) {
	return (
		<Box flexDirection="column">
			{blocks.map((block, i) => (
				<BlockView
					// biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own and hold no state, so the index is the key.
					key={`b-${i}`}
					block={block}
					prev={blocks[i - 1]?.type ?? (i === 0 ? lead : null)}
					color={color}
					hyperlinks={hyperlinks}
					width={width}
					italic={italic}
				/>
			))}
		</Box>
	)
}

/**
 * One block.
 *
 * Memoised on its props, all three of which are stable across a token when the
 * block is: the cache hands back the same `block` and `prev` objects and
 * `color` is a constant. Without this the cache would still save the parse and
 * then throw the saving away — `parseInline` runs here, per span, on every
 * render, and it is the more expensive half.
 */
const BlockView = memo(function BlockView({
	block,
	prev,
	color,
	hyperlinks,
	width,
	italic,
}: {
	readonly block: MdBlock
	readonly prev: MdBlock['type'] | 'join' | null
	readonly color: string
	readonly hyperlinks: boolean
	/** Cells this block has; a resize re-renders every block at the new width. */
	readonly width: number
	/** Drawn in italics, as the text of a quote is. */
	readonly italic: boolean
}) {
	// A memoised block would otherwise keep the colours it was drawn with.
	useThemeEpoch()
	// One blank line between blocks, except: nothing before the first block,
	// and consecutive list items stay tight (no gap between bullets).
	const gap = !prev || prev === 'join' || (block.type === 'bullet' && prev === 'bullet') ? 0 : 1
	switch (block.type) {
		case 'heading': {
			const style = headingStyle(block.level)
			// The spans are drawn in the heading's own colour: a span names its
			// colour, and one that named the body colour would hide the level.
			const headingColor =
				style.color === 'accent'
					? theme.accent.user
					: style.color === 'muted'
						? theme.text.muted
						: color
			return (
				<Box marginTop={gap}>
					<Text bold underline={style.underline} italic={italic} color={headingColor}>
						<WrappedInline
							source={block.text}
							width={width}
							color={headingColor}
							hyperlinks={hyperlinks}
						/>
					</Text>
				</Box>
			)
		}
		case 'rule':
			return (
				<Box marginTop={gap}>
					<Text color={theme.border.default}>{'─'.repeat(ruleWidth(width))}</Text>
				</Box>
			)
		case 'quote':
			// A bar down the left edge, one space, then the quote's own blocks at the
			// width that is left. Ink's left border is the bar, and it is as tall as
			// the quote, so every row carries it, wrapped rows included.
			return (
				<Box
					marginTop={gap}
					borderStyle="single"
					borderColor={theme.border.default}
					borderTop={false}
					borderBottom={false}
					borderRight={false}
					paddingLeft={QUOTE_BAR_WIDTH - 1}
				>
					{block.blocks.length > 0 ? (
						<BlockList
							blocks={block.blocks}
							color={color}
							hyperlinks={hyperlinks}
							width={width - QUOTE_BAR_WIDTH}
							italic
						/>
					) : (
						<Text> </Text>
					)}
				</Box>
			)
		case 'bullet': {
			const marker = block.ordered ? `${block.marker}.` : block.marker
			return (
				<Box marginTop={gap} flexDirection="row">
					<Box width={marker.length + 1} flexShrink={0}>
						<Text color={theme.text.muted}>{marker} </Text>
					</Box>
					<Box flexGrow={1}>
						<Text color={color} italic={italic} wrap="wrap">
							<WrappedInline
								source={block.text}
								width={width - marker.length - 1}
								color={color}
								hyperlinks={hyperlinks}
							/>
						</Text>
					</Box>
				</Box>
			)
		}
		case 'table':
			return (
				<Box marginTop={gap}>
					<TableView table={block} width={width} color={color} hyperlinks={hyperlinks} />
				</Box>
			)
		case 'code':
			// Nothing is drawn beside the code: a rule or a label would be copied with
			// it, a `│` at the start of every line and a stray word above the first, and
			// what is pasted into a terminal has to be the command and nothing else. The
			// colour and the blank line above set the block apart; `/copy` takes a block
			// exactly as written.
			return (
				<Box marginTop={gap} flexDirection="column">
					{(block.lines.length > 0 ? block.lines : ['']).map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own and hold no state, so the index is the key.
						<Text key={`c-${i}`} color={theme.status.ok}>
							{line.length > 0 ? line : ' '}
						</Text>
					))}
				</Box>
			)
		default:
			return (
				<Box marginTop={gap}>
					<Text color={color} italic={italic} wrap="wrap">
						<WrappedInline
							source={block.text}
							width={width}
							color={color}
							hyperlinks={hyperlinks}
						/>
					</Text>
				</Box>
			)
	}
})

/**
 * A markdown table: a box when it fits the width, stacked `Header: value`
 * records when it does not. The layout is `markdown-table.ts`; this draws it,
 * one Ink row per line, so nothing here is wrapped a second time.
 */
function TableView({
	table,
	width,
	color,
	hyperlinks,
}: {
	readonly table: TableSource
	readonly width: number
	readonly color: string
	readonly hyperlinks: boolean
}) {
	const layout = layoutTable(table, width, { hyperlinks })
	return (
		<Box flexDirection="column">
			{layout.lines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a table's lines have no identity beyond their position.
				<Text key={`t-${i}`} color={color} wrap="truncate-end">
					{line.map((span, j) => (
						<SpanView
							// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional.
							key={`s-${j}`}
							span={span}
							color={color}
							hyperlinks={hyperlinks}
						/>
					))}
				</Text>
			))}
		</Box>
	)
}

/** Inline markdown wrapped to `width` cells. See {@link WrappedSpans}. */
function WrappedInline({
	source,
	width,
	color,
	hyperlinks,
}: {
	readonly source: string
	readonly width: number
	readonly color: string
	readonly hyperlinks: boolean
}) {
	return (
		<WrappedSpans
			spans={inlineDisplaySpans(source, hyperlinks)}
			width={width}
			color={color}
			hyperlinks={hyperlinks}
		/>
	)
}

/**
 * Spans wrapped to `width` cells, as text with the row breaks in it: Ink
 * finds every row already fits and leaves it alone. Goes inside a `<Text>`.
 */
export function WrappedSpans({
	spans,
	width,
	color,
	hyperlinks = false,
}: {
	readonly spans: readonly DisplaySpan[]
	readonly width: number
	readonly color: string
	readonly hyperlinks?: boolean
}) {
	const lines: readonly DisplayLine[] = wrapSpans(spans, width)
	return (
		<>
			{lines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional.
				<Fragment key={`l-${i}`}>
					{line.map((span, j) => (
						<SpanView
							// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional.
							key={`s-${j}`}
							span={span}
							color={color}
							hyperlinks={hyperlinks}
						/>
					))}
					{i < lines.length - 1 ? '\n' : null}
				</Fragment>
			))}
		</>
	)
}

/** One drawn span: code, a link, dim text, a rule, or styled prose. */
function SpanView({
	span,
	color,
	hyperlinks,
}: {
	readonly span: DisplaySpan & Pick<TableSpan, 'border'>
	readonly color: string
	readonly hyperlinks: boolean
}) {
	if (span.border) return <Text color={theme.border.default}>{span.text}</Text>
	if (span.muted) return <Text color={theme.text.muted}>{span.text}</Text>
	if (span.code) {
		return (
			<Text color={theme.status.ok} bold={span.bold} italic={span.italic}>
				{span.text}
			</Text>
		)
	}
	if (span.link) {
		// A wrapped label is drawn a row at a time, each piece its own link to
		// the same address: one OSC 8 sequence cannot span a row break.
		const linked = hyperlinks ? terminalWebHyperlink(span.text, span.link) : null
		return (
			<Text color={theme.accent.user} underline bold={span.bold}>
				{linked ?? span.text}
			</Text>
		)
	}
	return (
		<Text color={color} bold={span.bold} italic={span.italic}>
			{span.text}
		</Text>
	)
}
