/**
 * Conversation transcript. Borderless and edge-to-edge: each message is a
 * two-column row — a fixed glyph gutter plus the content — so wrapped
 * lines hang-indent under the text and the role reads from the glyph +
 * color alone (no separate label line). Role marks stay still while output
 * streams; the Working row owns the active turn's animation.
 */

import { Box, Static, Text } from 'ink'
import type { ReactNode } from 'react'
import { memo } from 'react'

import { Markdown } from './Markdown.js'
import { StatusPanel } from './StatusPanel.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'
import type { TranscriptMessage } from './types.js'

export interface TranscriptProps {
	/** Finalized messages, oldest first. */
	readonly messages: readonly TranscriptMessage[]
	/** The in-progress streaming message, re-rendered live below the static log. */
	readonly pending: TranscriptMessage | null
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
}

const COLLAPSE_LINES = 6
const PREVIEW_LINE_CHARS = 240

type StaticRow =
	| { readonly kind: 'header' }
	| {
			readonly kind: 'message'
			readonly message: TranscriptMessage
			readonly prev: TranscriptMessage | undefined
	  }

export function Transcript({
	messages,
	pending,
	settled,
	resetKey,
	raw = false,
	hyperlinks = false,
	showLive = true,
	header,
}: TranscriptProps) {
	const inScrollback = Math.min(Math.max(settled, 0), messages.length)
	// The banner is row 0 so it prints to the very top of scrollback; messages
	// follow it. <Static> renders each row exactly once and never re-renders it,
	// so everything behind the live window costs nothing per frame — the whole
	// transcript was once re-rendered on every spinner tick, which exhausted
	// memory on long sessions.
	const rows: StaticRow[] = [
		...(header ? [{ kind: 'header' as const }] : []),
		...messages.slice(0, inScrollback).map((message, i) => ({
			kind: 'message' as const,
			message,
			prev: messages[i - 1],
		})),
	]
	// The live window is memoised per row so streamed output does not reparse
	// Markdown in unchanged history. The row that changed is the one that renders.
	const live = messages.slice(inScrollback)
	return (
		<Box flexDirection="column">
			<Static key={resetKey} items={rows}>
				{(row) =>
					row.kind === 'header' ? (
						<Box key="header">{header}</Box>
					) : raw ? (
						<RawMessageRow key={row.message.id} message={row.message} prev={row.prev} />
					) : (
						<MessageRow
							key={row.message.id}
							message={row.message}
							prev={row.prev}
							hyperlinks={hyperlinks}
						/>
					)
				}
			</Static>
			{showLive
				? live.map((message, i) =>
						raw ? (
							<RawMessageRow
								key={message.id}
								message={message}
								prev={messages[inScrollback + i - 1]}
							/>
						) : (
							<LiveRow
								key={message.id}
								message={message}
								prev={messages[inScrollback + i - 1]}
								hyperlinks={hyperlinks}
							/>
						),
					)
				: null}
			{showLive && pending && raw ? (
				<RawMessageRow message={pending} prev={messages[messages.length - 1]} />
			) : showLive && pending ? (
				<MessageRow
					message={pending}
					prev={messages[messages.length - 1]}
					hyperlinks={hyperlinks}
				/>
			) : null}
		</Box>
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
		message.content.length > 0 ? terminalDisplayText(message.content) : message.pending ? '…' : ''
	const text = [
		`${content}${message.meta ? ` · ${terminalDisplayText(message.meta)}` : ''}`,
		...(message.detail && message.detail.length > 0
			? ['', ...message.detail.map(terminalDisplayText)]
			: []),
	].join('\n')
	return (
		<Box flexDirection="column" marginTop={prev ? 1 : 0}>
			<Text wrap="wrap">{text}</Text>
		</Box>
	)
}

function MessageRow({
	message,
	prev,
	hyperlinks,
}: {
	readonly message: TranscriptMessage
	readonly prev: TranscriptMessage | undefined
	readonly hyperlinks: boolean
}) {
	if (message.statusRows) {
		return (
			<Box marginTop={prev ? 1 : 0}>
				<StatusPanel rows={message.statusRows} />
			</Box>
		)
	}
	// Assistant content is projected inside <Markdown>, its actual renderer.
	// The other roles flow straight into Ink here and need the projection now.
	const content =
		message.role === 'assistant' ? message.content : terminalDisplayText(message.content)
	const glyph = message.glyph ?? glyphForRole(message.role)
	// The `⎿` tool-result gutter is rendered dim so the call line leads.
	const glyphColor =
		message.glyphColor ?? (glyph === '⎿' ? theme.text.muted : glyphColorForRole(message.role))
	// One blank line before each entry, except the first and `⎿` result rows,
	// which hug the `⏺` tool call above them, so a result reads as
	// belonging to the call that produced it rather than as free-standing.
	const exploration = message.activity === 'exploration'
	const startsExploration = exploration && prev?.activity !== 'exploration'
	const gap = !prev || message.glyph === '⎿' || (exploration && !startsExploration) ? 0 : 1
	return (
		<Box flexDirection="column" marginTop={gap}>
			{startsExploration ? <Text bold color={theme.text.secondary}>Explored</Text> : null}
			<Box flexDirection="row">
				<Box width={2} flexShrink={0}>
					<Text color={glyphColor} bold>
						{glyph}
					</Text>
				</Box>
				<Box flexGrow={1}>
					{message.role === 'assistant' && content.length > 0 ? (
						<Markdown
							text={message.content}
							color={contentColorForRole(message.role)}
							hyperlinks={hyperlinks}
						/>
					) : (
						<Text color={contentColorForRole(message.role)} wrap="wrap">
							{content}
							{message.meta ? (
								<Text color={theme.text.muted}> · {terminalDisplayText(message.meta)}</Text>
							) : null}
							{message.pending && content.length === 0 ? (
								<Text color={theme.text.muted}>…</Text>
							) : null}
						</Text>
					)}
				</Box>
			</Box>
			{message.detail && message.detail.length > 0 && (!message.activity || message.detailExpanded) ? (
				<DetailBlock
					lines={message.detail}
					expanded={message.detailExpanded === true}
					detailRef={message.detailRef}
				/>
			) : null}
		</Box>
	)
}

/**
 * Collapsible tool diff / output, aligned under the content gutter.
 * Ctrl+O expands live rows in place or reprints the latest settled body.
 */
function DetailBlock({
	lines,
	expanded,
	detailRef,
}: {
	readonly lines: readonly string[]
	readonly expanded: boolean
	/** Stable reference that lets App offer expansion for this body. */
	readonly detailRef: number | undefined
}) {
	const shown = splitDetail(lines.map(terminalDisplayText), expanded, detailRef)
	// A dim left rule (`▏`) under the gutter frames the output as a block,
	// so tool output is visibly not the assistant speaking.
	const Rule = () => (
		<Box width={2} flexShrink={0}>
			<Text color={theme.text.muted}>▏</Text>
		</Box>
	)
	return (
		<Box flexDirection="column" paddingLeft={1}>
			{shown.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: these rows have no local state; expansion replaces their text in place.
				<Box key={`d-${i}`} flexDirection="row">
					<Rule />
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

/** Whether the preview hides text and App should mark the body as expandable. */
export function willCollapse(detail: readonly string[] | undefined): boolean {
	return (
		detail !== undefined &&
		(detail.length > COLLAPSE_LINES ||
			detail.some((line) => terminalDisplayText(line).length > PREVIEW_LINE_CHARS))
	)
}

/** One projection for rendered rows and their height estimate; source lines stay intact. */
function splitDetail(
	lines: readonly string[],
	expanded: boolean,
	detailRef?: number,
): readonly string[] {
	if (expanded) return lines
	const fragmentLines = COLLAPSE_LINES / 2
	const selected =
		lines.length > COLLAPSE_LINES
			? [...lines.slice(0, fragmentLines), ...lines.slice(-fragmentLines)]
			: lines
	const hidden = lines.length - selected.length
	const clipped = selected.some((line) => line.length > PREVIEW_LINE_CHARS)
	const shown = selected.map((line) =>
		line.length > PREVIEW_LINE_CHARS
			? `${line.slice(0, PREVIEW_LINE_CHARS - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
			: line,
	)
	const action = detailRef === undefined ? '' : ' · ctrl+o'
	if (hidden > 0) {
		const hint = `… ${hidden} line${hidden === 1 ? '' : 's'} omitted${action}${clipped ? ' · shortened preview' : ''}`
		return [...shown.slice(0, fragmentLines), hint, ...shown.slice(fragmentLines)]
	}
	return clipped ? [...shown, `… line shortened${action}`] : shown
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
export function renderedDetailLines(message: TranscriptMessage): readonly string[] {
	const lines = message.detail
	if (!lines || lines.length === 0 || (message.activity !== undefined && !message.detailExpanded)) return []
	const shown = splitDetail(
		lines.map(terminalDisplayText),
		message.detailExpanded === true,
		message.detailRef,
	)
	// Indented by the gutter this block actually renders inside: `paddingLeft={1}`
	// plus the two-column `▏` rule. Those columns are not available to the text,
	// so measuring a body line against the full terminal width under-counts how
	// many rows it wraps to — and under-counting is the direction that grows the
	// redrawable region too far. The prefix is what the estimator measures, so the
	// arithmetic is done by making the string the width it really is.
	const gutter = '   '
	return shown.map((line) => gutter + line)
}

function detailLineColor(line: string): string {
	if (line.startsWith('+')) return theme.status.ok
	if (line.startsWith('-')) return theme.status.error
	return theme.text.muted
}

function glyphForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return '›'
		case 'assistant':
			return '∴'
		case 'system':
			return '·'
		case 'tool':
			return '⚙'
	}
}

function glyphColorForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return theme.accent.user
		case 'assistant':
			return theme.accent.assistant
		case 'system':
			return theme.text.muted
		case 'tool':
			return theme.accent.tool
	}
}

function contentColorForRole(role: TranscriptMessage['role']): string {
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
