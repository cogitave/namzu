/**
 * Conversation transcript. Borderless and edge-to-edge: each message is a
 * two-column row — a fixed glyph gutter plus the content — so wrapped
 * lines hang-indent under the text and the role reads from the glyph +
 * color alone (no separate label line). Role marks stay still while output
 * streams; the Working row owns the active turn's animation.
 */

import { Box, Static, Text, useWindowSize } from 'ink'
import type { ReactNode } from 'react'
import { memo, useRef, useSyncExternalStore } from 'react'
import { type DiffInfo, diffViewBody, viewRowText } from './diff-view.js'
import { fitHintPlain, hintSuffix } from './hint-fit.js'
import { EXPAND_HINT, clipText, hiddenLinesHint } from './truncation.js'
import { cutUserText, hiddenTextNote, hiddenTextRule } from './user-text-view.js'

import { Checklist, checklistLine } from './Checklist.js'
import { ContextGridRow } from './ContextGridRow.js'
import { ContentWidth, Markdown, WrappedSpans, useContentWidth } from './Markdown.js'
import { ReadSearchGroup } from './ReadSearchGroup.js'
import { StatusPanel } from './StatusPanel.js'
import { type AttachmentRow, attachmentLine } from './attachment-rows.js'
import { grammarState, grammarVersion, languagesIn, subscribeGrammars } from './code-highlight.js'
import { laterReplyBlocks } from './reply-mark.js'
import { type ShellOutput, shellCollapses, shellResultRows, shellToneColor } from './shell-cell.js'
import { type ReplyPiece, isPlainReply, printedPieces, tailPiece } from './stream-flow.js'
import {
	RECAP_GLYPH,
	RECAP_LABEL,
	RESULT_GUTTER_INDENT,
	RESULT_GUTTER_WIDTH,
} from './system-rows.js'
import { expandTabs, terminalDisplayText } from './terminal-display.js'
import { terminalFileHyperlink } from './terminal-hyperlinks.js'
import { useThemeEpoch } from './theme-store.js'
import { paint, rowTints, theme } from './theme.js'
import { NOT_SHOWN_LINE } from './tidy-tool-output.js'
import type { TranscriptMessage } from './types.js'

export interface TranscriptProps {
	/** Finalized messages, oldest first. */
	readonly messages: readonly TranscriptMessage[]
	/** The in-progress streaming message, re-rendered live below the static log. */
	readonly pending: TranscriptMessage | null
	/**
	 * How many of `messages` came before `pending` in the conversation.
	 *
	 * A row written while a reply streams — a delegated agent's launch receipt
	 * or completion, a notice — belongs after that reply. Drawing the reply
	 * after every finalized row instead put such a row above the text that
	 * came before it, and the two swapped when the reply finished. The reply is
	 * drawn at this position, so no row moves once it is on screen. The caller
	 * keeps every row from here on out of `<Static>` (`settledBeforeStreaming`),
	 * which is what makes the position reachable. Omitted, the reply is last.
	 */
	readonly pendingAt?: number
	readonly state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission'
	/**
	 * How many of `messages` have been handed to scrollback.
	 *
	 * `messages[0, settled)` go through `<Static>`, which prints a row once and
	 * never redraws it; the rest are drawn live and can still change — which is
	 * what makes expanding a body already on screen possible at all. The caller
	 * decides how many that is, because the answer depends on the terminal's
	 * height and the bounded live-region budget; see `live-window.ts`. Passing
	 * `messages.length` is the everything-is-static behaviour.
	 *
	 * It must never decrease for a given `resetKey`. `<Static>` counts what it
	 * has emitted and renders only past that count, so a shrinking prefix leaves
	 * rows unprinted, and a row already drawn live would be printed a second
	 * time on its way back out.
	 */
	readonly settled: number
	/** Bump to reset the static log (e.g. /clear, /clear-screen, /resume). */
	readonly resetKey: number
	/** Render selection-friendly source with terminal controls exposed as visible escapes. */
	readonly raw?: boolean
	/** Render admitted Markdown links as terminal hyperlinks. */
	readonly hyperlinks?: boolean
	/**
	 * Whether the mutable transcript tail owns inline viewport rows.
	 *
	 * Lifecycle pickers temporarily need those rows, but the `<Static>` owner
	 * above them must stay mounted so terminal scrollback is never replayed.
	 * Turning this off hides only the redrawable tail and pending row.
	 */
	readonly showLive?: boolean
	/**
	 * Header (banner) printed once as the first <Static> row. It must live
	 * inside <Static> — Ink writes static output to scrollback *above* the
	 * live region, so a banner kept in the live tree would be pushed down as
	 * the transcript grows. As the first static row it pins to the top.
	 */
	readonly header?: ReactNode
	/**
	 * Columns of padding the caller's own box puts left of this transcript.
	 *
	 * Ink lays `<Static>` out as an absolutely positioned node as wide as
	 * the terminal and prints it from that node, so an ancestor's padding
	 * never reaches it: a row drawn live at column 1 moved to column 0 the
	 * moment it settled, and wrapped two columns wider than it had live. The
	 * settled rows are drawn with this padding on both sides themselves,
	 * which puts them in the column, and at the width, they had live.
	 */
	readonly staticIndent?: number
	/** Columns of padding right of this transcript, when it is not the same as on the left. */
	readonly staticIndentRight?: number
}

const COLLAPSE_LINES = 6
const PREVIEW_LINE_CHARS = 240

type StaticRow =
	| { readonly kind: 'header' }
	| {
			readonly kind: 'message'
			readonly message: TranscriptMessage
			readonly prev: TranscriptMessage | undefined
			readonly later: boolean
	  }
	| {
			/** A part of a reply that was printed while it streamed. */
			readonly kind: 'piece'
			readonly key: string
			readonly message: TranscriptMessage
			readonly piece: ReplyPiece
			readonly prev: TranscriptMessage | undefined
			readonly later: boolean
	  }

/**
 * The rows a message is printed as. A reply that was cut into printed parts
 * while it streamed is its parts, then what was left when it ended; any other
 * message is one row.
 */
function printedRows(
	message: TranscriptMessage,
	prev: TranscriptMessage | undefined,
	raw: boolean,
	later: boolean,
): StaticRow[] {
	if (raw || !message.printed?.length || !isPlainReply(message))
		return [{ kind: 'message', message, prev, later }]
	const pieces = printedPieces(message.printed)
	const rest = tailPiece({ ...message, pending: false })
	return [...pieces, ...(rest ? [rest] : [])].map((piece, i) => ({
		kind: 'piece' as const,
		key: `${message.id}#${i}`,
		message,
		piece,
		prev,
		later,
	}))
}

/**
 * Whether a reply holds a code block whose grammar is still being read. A row that is
 * printed cannot be drawn again, so such a message is not printed yet: it is drawn in the
 * live window, where it takes its colours when they arrive, and printed after. The wait is
 * bounded (`GRAMMAR_WAIT_MS`); a grammar that fails is plain and releases the message.
 * Asking starts the read of every grammar the message names.
 */
export function waitsForGrammar(message: TranscriptMessage): boolean {
	if (message.role !== 'assistant' || message.content === '') return false
	let waits = false
	for (const word of languagesIn(message.content)) {
		if (grammarState(word) === 'loading') waits = true
	}
	return waits
}

/** The index of the first message from `from` up to `upto` that has to wait for its colours; `upto` when none does. */
export function firstHeld(
	messages: readonly TranscriptMessage[],
	from: number,
	upto: number,
): number {
	let at = from
	while (at < upto && !waitsForGrammar(messages[at] as TranscriptMessage)) at++
	return at
}

export function Transcript({
	messages,
	pending,
	pendingAt,
	settled,
	resetKey,
	raw = false,
	hyperlinks = false,
	showLive = true,
	header,
	staticIndent = 0,
	staticIndentRight = staticIndent,
}: TranscriptProps) {
	// A message with a code block that waits for its colours is held out of the scrollback
	// until they have arrived or the wait is over. The check is made once per message (the
	// ones before `known` are printed, and a grammar never goes back to loading).
	useSyncExternalStore(subscribeGrammars, grammarVersion)
	const known = useRef<{ key: unknown; n: number }>({ key: resetKey, n: 0 })
	if (known.current.key !== resetKey) known.current = { key: resetKey, n: 0 }
	const asked = Math.min(Math.max(settled, 0), messages.length)
	known.current.n = Math.min(known.current.n, asked)
	const inScrollback = raw ? asked : firstHeld(messages, known.current.n, asked)
	if (!raw) known.current.n = inScrollback
	// The banner is row 0 so it prints to the very top of scrollback; messages
	// follow it. <Static> renders each row exactly once and never re-renders it,
	// so everything behind the live window costs nothing per frame — the whole
	// transcript was once re-rendered on every spinner tick, which exhausted
	// memory on long sessions.
	// Which rows are later text blocks of a reply that already showed its mark.
	// The rows still to be drawn are counted in their place (the streaming reply
	// stands where `pendingAt` puts it), so the answer for a row never depends on
	// whether it is printed or live.
	const live = messages.slice(inScrollback)
	const at = Math.min(Math.max((pendingAt ?? messages.length) - inScrollback, 0), live.length)
	const drawn: readonly TranscriptMessage[] = pending
		? [...live.slice(0, at), pending, ...live.slice(at)]
		: live
	const later = laterReplyBlocks([...messages.slice(0, inScrollback), ...drawn])
	const rows: StaticRow[] = [
		...(header ? [{ kind: 'header' as const }] : []),
		...messages
			.slice(0, inScrollback)
			.flatMap((message, i) => printedRows(message, messages[i - 1], raw, later[i] ?? false)),
	]
	// The live window is memoised per row so streamed output does not reparse
	// Markdown in unchanged history. The row that changed is the one that renders.
	// The streaming reply (`drawn`, above) is drawn where it stands in the
	// conversation (see `pendingAt`), not after every finalized row. It is never
	// behind the floor, because the caller holds the floor below it.
	// A reply being written has printed its finished parts already: they are the
	// last rows of the log, and only what is left of it is drawn below.
	const flowing = !raw && drawn[0]?.printed?.length && isPlainReply(drawn[0]) ? drawn[0] : undefined
	if (flowing) {
		const before = inScrollback > 0 ? messages[inScrollback - 1] : undefined
		const pieces = printedPieces(flowing.printed ?? [])
		rows.push(
			...pieces.map((piece, i) => ({
				kind: 'piece' as const,
				key: `${flowing.id}#${i}`,
				message: flowing,
				piece,
				prev: before,
				later: later[inScrollback] ?? false,
			})),
		)
	}
	// The text beside the two-column glyph gutter: the terminal less the
	// caller's padding on both sides, which settled rows draw themselves.
	const { columns } = useWindowSize()
	return (
		<ContentWidth.Provider value={Math.max(10, columns - staticIndent - staticIndentRight - 2)}>
			<Box flexDirection="column">
				<Static key={resetKey} items={rows}>
					{(row) => (
						<Box
							key={
								row.kind === 'header' ? 'header' : row.kind === 'piece' ? row.key : row.message.id
							}
							flexDirection="column"
							width={columns}
							paddingLeft={staticIndent}
							paddingRight={staticIndentRight}
						>
							{row.kind === 'header' ? (
								<Box>{header}</Box>
							) : row.kind === 'piece' ? (
								<ReplyPieceRow
									message={row.message}
									prev={row.prev}
									piece={row.piece}
									hyperlinks={hyperlinks}
									later={row.later}
								/>
							) : raw ? (
								<RawMessageRow message={row.message} prev={row.prev} />
							) : (
								<MessageRow
									message={row.message}
									prev={row.prev}
									hyperlinks={hyperlinks}
									later={row.later}
								/>
							)}
						</Box>
					)}
				</Static>
				{showLive
					? drawn.map((message, i) => {
							const prev = i > 0 ? drawn[i - 1] : messages[inScrollback - 1]
							const piece =
								!raw && message.role === 'assistant' && isPlainReply(message)
									? (tailPiece(message) ?? null)
									: undefined
							// A reply streaming: its tail as far as it is decided, and no row at all
							// until some of it is.
							if (piece !== undefined && (message.pending || message.printed?.length)) {
								return piece === null ? null : (
									<LiveReplyRow
										key={message.id}
										message={message}
										prev={i > 0 ? drawn[i - 1] : messages[inScrollback - 1]}
										piece={piece}
										hyperlinks={hyperlinks}
										later={later[inScrollback + i] ?? false}
									/>
								)
							}
							return raw ? (
								<RawMessageRow key={message.id} message={message} prev={prev} />
							) : (
								<LiveRow
									key={message.id}
									message={message}
									prev={prev}
									hyperlinks={hyperlinks}
									later={later[inScrollback + i] ?? false}
								/>
							)
						})
					: null}
			</Box>
		</ContentWidth.Provider>
	)
}

/**
 * A row in the live window.
 *
 * Memoised on the whole props object rather than on a hand-picked key. React's
 * default shallow compare over `{message, prev, hyperlinks}` is already exactly
 * "has anything about this row changed": the transcript is held as immutable
 * rows, so an update rebuilds only the rows it touches and leaves every other
 * object identical. A `(id, detailExpanded)` key would be the same answer for
 * two fields and silently the wrong one for every other field a row has.
 *
 * Terminal width is deliberately NOT part of it. Nothing in a row's element
 * tree depends on the width — wrapping is done by the layout engine from the
 * same tree, and a resize re-lays-out without re-rendering — so a width key
 * would be a prop that drives nothing.
 */
const LiveRow = memo(MessageRow)

/**
 * One part of a reply, in the gutter the reply has. Only the first part of a
 * reply carries the mark and the blank row above; the others continue under it.
 */
export function ReplyPieceRow({
	message,
	prev,
	piece,
	hyperlinks,
	later = false,
}: {
	readonly message: TranscriptMessage
	readonly prev: TranscriptMessage | undefined
	readonly piece: ReplyPiece
	readonly hyperlinks: boolean
	/** A later text block of a reply that already showed its mark: the mark column stays blank. */
	readonly later?: boolean
}) {
	useThemeEpoch()
	const glyph = glyphForRole(message.role)
	return (
		<Box flexDirection="column" marginTop={piece.first && prev ? 1 : 0}>
			<Box flexDirection="row">
				<Box width={2} flexShrink={0}>
					<Text color={glyphColorForRole(message.role)}>{piece.first && !later ? glyph : ' '}</Text>
				</Box>
				<Box flexGrow={1}>
					<Markdown
						text={piece.text}
						color={contentColorForRole(message.role)}
						hyperlinks={hyperlinks}
						join={piece.join}
						lead={piece.lead}
						{...(piece.lang !== undefined ? { lang: piece.lang } : {})}
						{...(piece.fence !== undefined ? { fence: piece.fence } : {})}
						{...(piece.flow !== undefined ? { flow: piece.flow } : {})}
					/>
				</Box>
			</Box>
		</Box>
	)
}

const LiveReplyRow = memo(ReplyPieceRow)

/**
 * Selection-friendly transcript source.
 *
 * There is deliberately no role gutter or Markdown renderer here. The source
 * is the value an operator is trying to select, so decorating it and asking
 * them to reverse the decoration would reproduce the problem this mode solves.
 * Source control bytes remain in the conversation, but their terminal view is
 * an explicit `\\u{....}` literal — raw means no Markdown/decorations, not that
 * model text receives terminal authority. Tool bodies are shown whole: a mode
 * named raw must not retain a rich-view truncation whose missing lines cannot
 * be selected at all.
 */
function RawMessageRow({
	message,
	prev,
}: {
	readonly message: TranscriptMessage
	readonly prev: TranscriptMessage | undefined
}) {
	const content =
		message.kind === 'recap'
			? `${RECAP_LABEL} ${terminalDisplayText(message.content)}`
			: message.content.length > 0
				? terminalDisplayText(message.content)
				: message.pending
					? '…'
					: ''
	const fullHeader = message.shell?.fullHeader
	const text = [
		`${fullHeader !== undefined ? terminalDisplayText(fullHeader) : content}${message.meta ? `${metaSeparator(message.meta)}${terminalDisplayText(message.meta)}` : ''}`,
		...(message.shell
			? shellResultRows(message.shell, { expanded: true }).map((row) =>
					terminalDisplayText(row.text),
				)
			: []),
		...(message.checklist ?? []).map(checklistLine),
		...(message.detail && message.detail.length > 0 && !message.shell
			? ['', ...message.detail.map(terminalDisplayText)]
			: []),
	].join('\n')
	return (
		<Box flexDirection="column" marginTop={prev ? 1 : 0}>
			<Text wrap="wrap">{text}</Text>
		</Box>
	)
}

/** The away recap: `※`, a bold `recap:` label and the text in italics, all dim. */
function RecapRow({
	message,
	prev,
}: {
	readonly message: TranscriptMessage
	readonly prev: TranscriptMessage | undefined
}) {
	return (
		<Box flexDirection="row" marginTop={prev ? 1 : 0}>
			<Box width={2} flexShrink={0}>
				<Text color={theme.text.muted}>{RECAP_GLYPH}</Text>
			</Box>
			<Box flexGrow={1}>
				<Text color={theme.text.muted} wrap="wrap">
					<Text bold>{RECAP_LABEL} </Text>
					<Text italic>{terminalDisplayText(message.content)}</Text>
				</Text>
			</Box>
		</Box>
	)
}

export function MessageRow({
	message,
	prev,
	hyperlinks,
	screen = false,
	later = false,
}: {
	readonly message: TranscriptMessage
	readonly prev: TranscriptMessage | undefined
	readonly hyperlinks: boolean
	/** Drawn on the detailed transcript screen: the model's thinking shows above the row. */
	readonly screen?: boolean
	/** A later text block of a reply that already showed its mark: the mark column stays blank. */
	readonly later?: boolean
}) {
	// The row is memoised on its props; the epoch makes a new theme repaint it.
	useThemeEpoch()
	if (message.kind === 'recap') return <RecapRow message={message} prev={prev} />
	if (message.contextView) {
		return (
			<Box marginTop={prev ? 1 : 0}>
				<ContextGridRow view={message.contextView} />
			</Box>
		)
	}
	if (message.statusRows) {
		return (
			<Box marginTop={prev ? 1 : 0}>
				<StatusPanel rows={message.statusRows} />
			</Box>
		)
	}
	// Assistant content is projected inside <Markdown>, its actual renderer.
	// The other roles flow straight into Ink here and need the projection now.
	const shellHeader =
		message.shell?.fullHeader !== undefined && message.detailExpanded
			? message.shell.fullHeader
			: message.content
	const content = message.role === 'assistant' ? message.content : terminalDisplayText(shellHeader)
	const width = useContentWidth()
	// A long message is echoed by its two ends, with a note of what lies between.
	const userCut = message.role === 'user' ? cutUserText(content) : content
	// The reply's own mark is a plain round dot, not bold; a later text block of the
	// same reply leaves the mark column blank so its text starts in the same column.
	const replyMark = message.role === 'assistant' && message.glyph === undefined
	const glyph = replyMark && later ? ' ' : (message.glyph ?? glyphForRole(message.role))
	const textColor = paint(message.contentColor) ?? contentColorForRole(message.role)
	// The person's own message sits on a quiet tint, so it is easy to find again
	// when scrolling back; where the terminal draws no tint it looks as it always did.
	const tint = message.role === 'user' && glyph === '›' ? rowTints()?.user : undefined
	const tinted = tint === undefined ? {} : { backgroundColor: tint }
	// The `⎿` tool-result gutter is rendered dim so the call line leads.
	const glyphColor =
		paint(message.glyphColor) ??
		(glyph === '⎿' ? theme.text.muted : glyphColorForRole(message.role))
	// One blank line before each entry, except the first and `⎿` result rows,
	// which hug the tool call above them, so a result reads as
	// belonging to the call that produced it rather than as free-standing.
	// Consecutive web searches and fetches read as one burst of work: no blank
	// line between one call's `⎿` line and the next call.
	const web = message.activity === 'web'
	const continuesWeb = web && prev?.activity === 'web'
	const gap = !prev || message.glyph === '⎿' || continuesWeb ? 0 : 1
	const rowWidth = glyph === '⎿' ? width - RESULT_GUTTER_INDENT - (RESULT_GUTTER_WIDTH - 2) : width
	// A group of one command is that command's row, drawn below like any other.
	if (message.group && message.shell === undefined) {
		return (
			<Box flexDirection="column" marginTop={gap}>
				{screen && message.thinking ? <ThinkingBlock text={message.thinking} /> : null}
				<ReadSearchGroup message={message} />
				{message.detail && message.detail.length > 0 && message.detailExpanded ? (
					<DetailBlock
						lines={message.detail}
						expanded
						detailRef={message.detailRef}
						diff={message.diff}
					/>
				) : null}
			</Box>
		)
	}
	return (
		<Box flexDirection="column" marginTop={gap}>
			{screen && message.thinking ? <ThinkingBlock text={message.thinking} /> : null}
			<Box flexDirection="row" paddingLeft={glyph === '⎿' ? RESULT_GUTTER_INDENT : 0}>
				<Box width={glyph === '⎿' ? RESULT_GUTTER_WIDTH : 2} flexShrink={0} {...tinted}>
					{tint === undefined ? (
						<Text color={glyphColor} bold={!replyMark}>
							{glyph}
						</Text>
					) : (
						<Text color={glyphColor} dimColor>
							{glyph}
						</Text>
					)}
				</Box>
				<Box flexGrow={1}>
					{message.role === 'assistant' && content.length > 0 ? (
						<Markdown
							text={message.content}
							color={contentColorForRole(message.role)}
							hyperlinks={hyperlinks}
						/>
					) : message.role === 'user' && typeof userCut === 'object' ? (
						<Box flexDirection="column">
							<Text color={contentColorForRole(message.role)} wrap="wrap" {...tinted}>
								{terminalDisplayText(userCut.head)}
							</Text>
							<Text color={theme.text.muted} {...tinted}>
								{hiddenTextRule(hiddenTextNote(userCut), width)}
							</Text>
							<Text color={contentColorForRole(message.role)} wrap="wrap" {...tinted}>
								{terminalDisplayText(userCut.tail)}
							</Text>
						</Box>
					) : !web && content.length > 0 ? (
						// Every other row wraps the way a reply does, each row in the
						// same column (see `markdown-wrap.ts`); a web row is cut instead.
						<Text color={textColor} wrap="wrap" {...tinted}>
							<WrappedSpans
								spans={[
									...(message.diff?.summary ?? [{ text: content }]),
									...(message.meta
										? [
												{
													// A hint that would be cut across two rows moves whole.
													text: hintSuffix(
														(message.diff?.summary ?? [{ text: content }])
															.map((span) => span.text)
															.join(''),
														`${metaSeparator(message.meta)}${terminalDisplayText(message.meta)}`,
														rowWidth,
													),
													muted: true,
												},
											]
										: []),
								]}
								width={rowWidth}
								color={textColor}
							/>
						</Text>
					) : (
						<Text color={textColor} wrap={web ? 'truncate-end' : 'wrap'}>
							{content}
							{message.meta ? (
								<Text color={theme.text.muted}>
									{metaSeparator(message.meta)}
									{terminalDisplayText(message.meta)}
								</Text>
							) : null}
							{message.pending && content.length === 0 ? (
								<Text color={theme.text.muted}>…</Text>
							) : null}
						</Text>
					)}
				</Box>
			</Box>
			{message.attachments && message.attachments.length > 0 ? (
				<Box flexDirection="column" paddingLeft={2}>
					{message.attachments.map((row, index) => (
						<AttachmentLineRow
							// biome-ignore lint/suspicious/noArrayIndexKey: the rows of one message, in order.
							key={index}
							row={row}
							hyperlinks={hyperlinks}
						/>
					))}
				</Box>
			) : null}
			{message.checklist && message.checklist.length > 0 ? (
				<Box paddingLeft={2}>
					<Checklist items={message.checklist} />
				</Box>
			) : null}
			{message.shell ? (
				<ShellBlock
					shell={message.shell}
					expanded={message.detailExpanded === true}
					canExpand={message.detailRef !== undefined}
				/>
			) : null}
			{message.detail &&
			message.detail.length > 0 &&
			!message.shell &&
			(!message.activity || message.detailExpanded) ? (
				<DetailBlock
					lines={message.detail}
					expanded={message.detailExpanded === true}
					detailRef={message.detailRef}
					diff={message.diff}
				/>
			) : null}
		</Box>
	)
}

/** The mark in front of the model's thinking on the detailed transcript screen. */
export const THINKING_GLYPH = '∵'

/** The model's thinking: a dim italic block under its own mark, drawn only on the screen. */
function ThinkingBlock({ text }: { readonly text: string }) {
	return (
		<Box flexDirection="row">
			<Box width={2} flexShrink={0}>
				<Text color={theme.text.muted} dimColor italic>
					{THINKING_GLYPH}
				</Text>
			</Box>
			<Box flexGrow={1}>
				<Text color={theme.text.muted} dimColor italic wrap="wrap">
					{terminalDisplayText(text.trim())}
				</Text>
			</Box>
		</Box>
	)
}

/** A `(ctrl+o …)` hint carried as a row's trailing text. */
const HINT_META = /^\(ctrl\+o[^)]*\)$/

/**
 * A row as the detailed transcript screen draws it: the whole retained body
 * and no hint that points at the screen it is already on.
 */
export function screenMessage(message: TranscriptMessage): TranscriptMessage {
	const { meta, ...rest } = message
	const keepMeta = meta !== undefined && !HINT_META.test(meta)
	// The screen clips its rows, and a clipped row drops the end of a line that
	// holds a tab (a numbered file excerpt), so tabs become spaces first.
	const detail = rest.detail?.map(expandTabs)
	const shell = rest.shell && {
		...rest.shell,
		stdout: rest.shell.stdout.map(expandTabs),
		stderr: rest.shell.stderr.map(expandTabs),
		...(rest.shell.folded ? { folded: rest.shell.folded.map(expandTabs) } : {}),
	}
	return {
		...rest,
		...(detail ? { detail } : {}),
		...(shell ? { shell } : {}),
		...(keepMeta ? { meta } : {}),
		detailExpanded: true,
	}
}

/** One row of the detailed transcript screen. */
export function ScreenMessageRow({
	message,
	prev,
	hyperlinks = false,
}: {
	readonly message: TranscriptMessage
	readonly prev: TranscriptMessage | undefined
	readonly hyperlinks?: boolean
}) {
	return <MessageRow message={screenMessage(message)} prev={prev} hyperlinks={hyperlinks} screen />
}

/** Columns the `⎿` prefix and its indent take from a result row. */
export const SHELL_RESULT_INDENT = RESULT_GUTTER_INDENT + RESULT_GUTTER_WIDTH

/** Cells a result row's text really has, inside a content area `contentWidth` wide. */
function shellBodyWidth(contentWidth: number): number {
	return Math.max(10, contentWidth - SHELL_RESULT_INDENT)
}

/**
 * The `⎿` result of a shell call: output rows hung under one dim `⎿`, the
 * first rows of each stream, then a dim count of what is folded away.
 */
export function ShellBlock({
	shell,
	expanded,
	canExpand,
}: {
	readonly shell: ShellOutput
	readonly expanded: boolean
	readonly canExpand: boolean
}) {
	const width = useContentWidth()
	const rows = shellResultRows(shell, {
		expanded,
		width:
			shell.byLine === true
				? shellBodyWidth(width)
				: Math.max(10, width - (SHELL_RESULT_INDENT - 2)),
		canExpand,
	})
	return (
		<Box flexDirection="column" paddingLeft={RESULT_GUTTER_INDENT}>
			{rows.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: these rows have no local state; expansion replaces their text in place.
				<Box key={`s-${i}`} flexDirection="row">
					<Box width={RESULT_GUTTER_WIDTH} flexShrink={0}>
						<Text color={theme.text.muted}>{i === 0 ? '⎿' : ' '}</Text>
					</Box>
					<Box flexGrow={1}>
						<Text color={shellToneColor(row.tone)} wrap="wrap">
							{row.text.length > 0
								? fitHintPlain(
										terminalDisplayText(row.text),
										Math.max(10, width - SHELL_RESULT_INDENT),
									)
								: ' '}
						</Text>
					</Box>
				</Box>
			))}
		</Box>
	)
}

/** Whether a row hides something Ctrl+O would show (a folded body or a cut command). */
export function messageCollapses(
	message: Pick<TranscriptMessage, 'detail' | 'shell' | 'diff'>,
): boolean {
	return message.shell ? shellCollapses(message.shell) : willCollapse(message.detail, message.diff)
}

/**
 * Collapsible tool diff / output, aligned under the content gutter. In the
 * conversation it is always the folded body and its hint: no row expands in
 * place. `expanded` is true only on the detailed transcript screen (Ctrl+O),
 * which draws every body whole.
 */
function DetailBlock({
	lines,
	expanded,
	detailRef,
	diff,
}: {
	readonly lines: readonly string[]
	readonly expanded: boolean
	/** The body is a diff: coloured by its markers, folded after `preview` rows. */
	readonly diff?: DiffInfo | undefined
	/** Stable reference that lets App offer expansion for this body. */
	readonly detailRef: number | undefined
}) {
	const width = useContentWidth()
	if (diff) return <DiffBlock info={diff} expanded={expanded} canExpand={detailRef !== undefined} />
	// A hint at the end of a line that would be cut across two rows moves whole.
	const shown = splitDetail(lines.map(terminalDisplayText), expanded, detailRef).map((line) =>
		fitHintPlain(line, Math.max(10, width - SHELL_RESULT_INDENT)),
	)
	// Hung in the column the result's own words start in, like a shell body.
	return (
		<Box flexDirection="column" paddingLeft={SHELL_RESULT_INDENT}>
			{shown.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: these rows have no local state; expansion replaces their text in place.
				<Box key={`d-${i}`} flexDirection="row">
					<Box flexGrow={1}>
						<Text color={detailLineColor(line)} wrap="wrap">
							{line.length > 0 ? line : ' '}
						</Text>
					</Box>
				</Box>
			))}
		</Box>
	)
}

/**
 * A change to a file, drawn: under the
 * result line, in the column the result's words start in, each added or
 * removed row filled to the edge. No rule beside it.
 */
function DiffBlock({
	info,
	expanded,
	canExpand,
}: {
	readonly info: DiffInfo
	readonly expanded: boolean
	readonly canExpand: boolean
}) {
	const width = diffWidthFor(useContentWidth())
	const rows = diffViewBody(info, { width, expanded, canExpand })
	return (
		<Box flexDirection="column" paddingLeft={SHELL_RESULT_INDENT}>
			{rows.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: these rows have no local state; expansion replaces their text in place.
				<Text key={`f-${i}`} wrap="truncate-end">
					{row.length === 0
						? ' '
						: row.map((segment, j) => (
								<Text
									// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional.
									key={`g-${j}`}
									{...(segment.bg ? { backgroundColor: segment.bg } : {})}
									{...(segment.fg ? { color: segment.fg } : {})}
									{...(segment.dim ? { dimColor: true } : {})}
								>
									{segment.text}
								</Text>
							))}
				</Text>
			))}
		</Box>
	)
}

/**
 * The width a diff body is drawn at, given the width the row's text column has
 * (the terminal less the padding and the glyph column). The body hangs from the
 * result's own column, and stays one cell short of the edge so a filled row
 * never touches the last column.
 */
function diffWidthFor(contentWidth: number): number {
	return Math.max(10, contentWidth - (SHELL_RESULT_INDENT - 2) - 1)
}

/** The width a diff body is drawn at in a terminal `columns` wide. */
function diffBodyWidth(columns: number): number {
	return diffWidthFor(Math.max(10, columns - 4))
}

/** Whether the preview hides text and App should mark the body as expandable. */
export function willCollapse(detail: readonly string[] | undefined, diff?: DiffInfo): boolean {
	if (detail === undefined) return false
	// A change shows whole unless it names a fold: a created file's first rows.
	if (diff) return diff.preview !== undefined && detail.length > diff.preview
	return (
		detail.length > COLLAPSE_LINES ||
		detail.some((line) => terminalDisplayText(line).length > PREVIEW_LINE_CHARS)
	)
}

/** One projection for rendered rows and their height estimate; source lines stay intact. */
function splitDetail(
	lines: readonly string[],
	expanded: boolean,
	detailRef?: number,
	hint?: string,
): readonly string[] {
	if (expanded) return lines
	const canExpand = detailRef !== undefined
	const fragmentLines = COLLAPSE_LINES / 2
	const selected =
		lines.length > COLLAPSE_LINES
			? [...lines.slice(0, fragmentLines), ...lines.slice(-fragmentLines)]
			: lines
	// A "… +N lines" line stands for N lines the kernel kept out of a long
	// stream, so folding it away hides N lines, not one.
	const folded =
		lines.length > COLLAPSE_LINES ? lines.slice(fragmentLines, lines.length - fragmentLines) : []
	const hidden = folded.reduce((count, line) => {
		const gap = NOT_SHOWN_LINE.exec(line)
		return count + (gap ? Number((gap[1] ?? '1').replaceAll(',', '')) : 1)
	}, 0)
	const clipped = selected.some((line) => line.length > PREVIEW_LINE_CHARS)
	const shown = selected.map(clipLine)
	if (hidden > 0) {
		const hiddenRow = hiddenLinesHint(hidden, {
			chars: folded.reduce((sum, line) => sum + line.length, 0),
			canExpand,
			...(hint !== undefined ? { hint } : {}),
		})
		return [...shown.slice(0, fragmentLines), hiddenRow, ...shown.slice(fragmentLines)]
	}
	return clipped
		? [...shown, `… line shortened${canExpand ? ` ${hint ?? EXPAND_HINT}` : ''}`]
		: shown
}

/** A preview row, cut at the preview width without splitting an emoji. */
function clipLine(line: string): string {
	return clipText(line, PREVIEW_LINE_CHARS)
}

/**
 * Every line a row's body will occupy, hint row included.
 *
 * Exported because the redrawable tail has to estimate how tall a row renders,
 * and this file is the only place that can answer: it owns `COLLAPSE_LINES` and
 * whether the hint row exists. Measuring `content` alone makes a six-line body
 * look like one row and lets the live region grow into the whole-history repaint
 * path. A copy of the collapse rule kept elsewhere would drift the first time
 * this number changed.
 */
export function renderedDetailLines(
	message: TranscriptMessage,
	columns?: number,
	hint?: string,
): readonly string[] {
	// Drawn under the two-column content gutter, one row per task before wrapping.
	const checklist = (message.checklist ?? []).map((item) => `  ${checklistLine(item)}`)
	return [...checklist, ...renderedBodyLines(message, columns, hint)]
}

function renderedBodyLines(
	message: TranscriptMessage,
	columns?: number,
	hint?: string,
): readonly string[] {
	if (message.shell) {
		// Hung under the `⎿` prefix: three columns of it plus the two of indent.
		return shellResultRows(message.shell, {
			expanded: message.detailExpanded === true,
			...(hint !== undefined ? { hint } : {}),
			...(message.shell.byLine === true && columns !== undefined
				? { width: shellBodyWidth(Math.max(10, columns - 4)) }
				: {}),
		}).map((row) => ' '.repeat(SHELL_RESULT_INDENT) + terminalDisplayText(row.text))
	}
	const lines = message.detail
	if (!lines || lines.length === 0 || (message.activity !== undefined && !message.detailExpanded))
		return []
	if (message.diff) return renderedDiffLines(lines, message, columns, hint)
	const shown = splitDetail(
		lines.map(terminalDisplayText),
		message.detailExpanded === true,
		message.detailRef,
		hint,
	)
	// Indented by the columns this block actually renders inside: the result's
	// own indent and its `⎿` column. Those columns are not available to the text,
	// so measuring a body line against the full terminal width under-counts how
	// many rows it wraps to — and under-counting is the direction that grows the
	// redrawable region too far. The prefix is what the estimator measures, so the
	// arithmetic is done by making the string the width it really is.
	const gutter = ' '.repeat(SHELL_RESULT_INDENT)
	return shown.map((line) => gutter + line)
}

/**
 * The rows a change will occupy, for the height estimate. With the terminal
 * width known these are the rows the renderer really draws (wrapped, folded
 * and with its notice), one string per drawn row and indented by the columns
 * the body hangs in, so a long line that wraps is never under-counted. Without
 * a width, the plain rows up to the fold, each with the two cells the gutter
 * and the reserve take from the code.
 */
function renderedDiffLines(
	lines: readonly string[],
	message: TranscriptMessage,
	columns?: number,
	hint?: string,
): readonly string[] {
	const indent = ' '.repeat(SHELL_RESULT_INDENT)
	if (message.diff && columns !== undefined) {
		const drawn = diffViewBody(message.diff, {
			width: diffBodyWidth(columns),
			expanded: message.detailExpanded === true,
			canExpand: message.detailRef !== undefined,
			...(hint !== undefined ? { hint } : {}),
		})
		return drawn.map((row) => `${indent}${terminalDisplayText(viewRowText(row))}`)
	}
	const preview = message.diff?.preview
	const limit = message.detailExpanded === true || preview === undefined ? lines.length : preview
	const shown = lines.slice(0, limit).map((line) => `${indent}${terminalDisplayText(line)}..`)
	if (lines.length > limit) {
		shown.push(
			`${indent}${hiddenLinesHint(lines.length - limit, {
				canExpand: message.detailRef !== undefined,
				...(hint !== undefined ? { hint } : {}),
			})}`,
		)
	}
	return shown
}

function detailLineColor(line: string): string {
	if (line.startsWith('+')) return theme.status.ok
	if (line.startsWith('-') || line.startsWith('Error: ')) return theme.status.error
	return theme.text.muted
}

export function glyphForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return '›'
		case 'assistant':
			return '●'
		case 'system':
			return '·'
		case 'tool':
			return 'T'
	}
}

export function glyphColorForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return theme.accent.user
		case 'assistant':
			// The reply's mark is the text colour, so it never looks like a tool's state-coloured dot.
			return theme.text.primary
		case 'system':
			return theme.text.muted
		case 'tool':
			return theme.accent.tool
	}
}

export function contentColorForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return theme.text.primary
		case 'assistant':
			return theme.text.primary
		case 'system':
			return theme.text.secondary
		case 'tool':
			return theme.text.secondary
	}
}

/**
 * What joins a row's hint to its text. A hint written in parentheses, like
 * `(ctrl+o to expand)` after `› Message from @name`, follows the text after a
 * space; any other hint is set off with a middle dot.
 */
export function metaSeparator(meta: string): string {
	return meta.startsWith('(') ? ' ' : ' · '
}

/**
 * One quiet row under a sent message for a file that went with it. Where the
 * terminal takes links it is a link to the copy on disk, so a click opens it.
 */
function AttachmentLineRow({
	row,
	hyperlinks,
}: {
	readonly row: AttachmentRow
	readonly hyperlinks: boolean
}) {
	const label = terminalDisplayText(attachmentLine(row))
	const linked = hyperlinks && row.path ? terminalFileHyperlink(label, row.path) : null
	return (
		<Text color={theme.text.muted} wrap="truncate-end" underline={linked !== null}>
			{linked ?? label}
		</Text>
	)
}
