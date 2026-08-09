/**
 * Conversation transcript. Borderless and edge-to-edge: each message is a
 * two-column row — a fixed glyph gutter plus the content — so wrapped
 * lines hang-indent under the text and the role reads from the glyph +
 * color alone (no separate label line). A pending assistant message shows
 * a braille spinner in the gutter while the agent works.
 */

import { Box, Static, Text } from 'ink'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { Markdown } from './Markdown.js'
import { theme } from './theme.js'
import type { TranscriptMessage } from './types.js'

export interface TranscriptProps {
	/** Finalized messages — rendered once via <Static> (printed to scrollback). */
	readonly messages: readonly TranscriptMessage[]
	/** The in-progress streaming message, re-rendered live below the static log. */
	readonly pending: TranscriptMessage | null
	readonly state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission'
	/** Bump to reset the static log (e.g. /clear, /resume). */
	readonly resetKey: number
	/**
	 * Header (banner) printed once as the first <Static> row. It must live
	 * inside <Static> — Ink writes static output to scrollback *above* the
	 * live region, so a banner kept in the live tree would be pushed down as
	 * the transcript grows. As the first static row it pins to the top.
	 */
	readonly header?: ReactNode
}

const COLLAPSE_LINES = 6

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

type StaticRow =
	| { readonly kind: 'header' }
	| {
			readonly kind: 'message'
			readonly message: TranscriptMessage
			readonly prev: TranscriptMessage | undefined
	  }

export function Transcript({ messages, pending, state, resetKey, header }: TranscriptProps) {
	const spinner = useSpinner(state !== 'idle')

	// The banner is row 0 so it prints to the very top of scrollback; messages
	// follow it. <Static> renders each row exactly once and never re-renders it,
	// keeping memory + per-frame work bounded (the whole transcript was
	// previously re-rendered on every spinner tick / token, which OOM'd long
	// sessions) and removing flicker.
	const rows: StaticRow[] = [
		...(header ? [{ kind: 'header' as const }] : []),
		...messages.map((message, i) => ({
			kind: 'message' as const,
			message,
			prev: messages[i - 1],
		})),
	]
	return (
		<Box flexDirection="column">
			<Static key={resetKey} items={rows}>
				{(row) =>
					row.kind === 'header' ? (
						<Box key="header">{header}</Box>
					) : (
						<MessageRow key={row.message.id} message={row.message} prev={row.prev} spinner="" />
					)
				}
			</Static>
			{pending ? (
				<MessageRow
					message={pending}
					prev={messages[messages.length - 1]}
					spinner={spinner}
				/>
			) : null}
			{messages.length === 0 && !pending ? (
				<Box paddingY={1}>
					<Text color={theme.text.muted}>
						Type a message to begin · <Text color={theme.text.secondary}>/help</Text> for commands
					</Text>
				</Box>
			) : null}
		</Box>
	)
}

function MessageRow({
	message,
	prev,
	spinner,
}: {
	readonly message: TranscriptMessage
	readonly prev: TranscriptMessage | undefined
	readonly spinner: string
}) {
	const glyph = message.pending ? spinner : (message.glyph ?? glyphForRole(message.role))
	// The `⎿` tool-result gutter is rendered dim so the call line leads.
	const glyphColor =
		message.glyphColor ?? (glyph === '⎿' ? theme.text.muted : glyphColorForRole(message.role))
	// One blank line before each entry, except the first and `⎿` result rows,
	// which hug the `⏺` tool call above them, so a result reads as
	// belonging to the call that produced it rather than as free-standing.
	const gap = !prev || message.glyph === '⎿' ? 0 : 1
	return (
		<Box flexDirection="column" marginTop={gap}>
			<Box flexDirection="row">
				<Box width={2} flexShrink={0}>
					<Text color={glyphColor} bold>
						{glyph}
					</Text>
				</Box>
				<Box flexGrow={1}>
					{message.role === 'assistant' && message.content.length > 0 ? (
						<Markdown text={message.content} color={contentColorForRole(message.role)} />
					) : (
						<Text color={contentColorForRole(message.role)} wrap="wrap">
							{message.content}
							{message.meta ? <Text color={theme.text.muted}> · {message.meta}</Text> : null}
							{message.pending && message.content.length === 0 ? (
								<Text color={theme.text.muted}>…</Text>
							) : null}
						</Text>
					)}
				</Box>
			</Box>
			{message.detail && message.detail.length > 0 ? (
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
 *
 * `expanded` comes from the ROW, not from a view-wide setting, because a
 * view-wide setting reaches the wrong rows: `<Static>` renders each item once,
 * calling the CURRENT render function for items it has not emitted yet — so a
 * flag flipped now applies to rows that have not happened and to none of the
 * rows on screen. `/expand` therefore pushes a new row with the flag already
 * set, rather than trying to flip one on a row that has been printed.
 */
function DetailBlock({
	lines,
	expanded,
	detailRef,
}: {
	readonly lines: readonly string[]
	readonly expanded: boolean
	/** The number `/expand` takes for this block, when it has one. */
	readonly detailRef: number | undefined
}) {
	const { shown, hidden } = splitDetail(lines, expanded)
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
				<Box key={`d-${i}`} flexDirection="row">
					<Rule />
					<Box flexGrow={1}>
						<Text color={detailLineColor(line)} wrap="wrap">
							{line.length > 0 ? line : ' '}
						</Text>
					</Box>
				</Box>
			))}
			{hidden > 0 ? (
				<Box flexDirection="row">
					<Rule />
					{/* The hint names its OWN number rather than telling the operator
					    to find one. Counting collapsed blocks up a scrolled
					    transcript is work, and a hint that costs work is a hint
					    that gets ignored. A block with no number cannot be named,
					    so it says how many lines it is hiding and stops there
					    rather than printing a command that would not resolve. */}
					<Text color={theme.text.muted}>
						… +{hidden} lines{detailRef === undefined ? '' : ` · /expand ${detailRef}`}
					</Text>
				</Box>
			) : null}
		</Box>
	)
}

/**
 * Whether a body will be truncated, and so will print a hint naming itself.
 *
 * Exported because only bodies that actually collapse get a `/expand` number,
 * and this file owns `COLLAPSE_LINES`. Numbering the rest would produce numbers
 * no hint ever shows: gaps in the sequence, a bare `/expand` that reprints a
 * two-line body while the truncated one above it stays hidden, and a
 * "there are N" message counting blocks the operator was never offered.
 */
export function willCollapse(detail: readonly string[] | undefined): boolean {
	return detail !== undefined && detail.length > COLLAPSE_LINES
}

/** How much of a body prints, and how much stays behind the hint. */
function splitDetail(
	lines: readonly string[],
	expanded: boolean,
): { readonly shown: readonly string[]; readonly hidden: number } {
	const shown = expanded ? lines : lines.slice(0, COLLAPSE_LINES)
	return { shown, hidden: lines.length - shown.length }
}

/**
 * Every line a row's body will occupy, hint row included.
 *
 * Exported because the bottom spacer has to estimate how tall a row renders,
 * and this file is the only place that can answer: it owns `COLLAPSE_LINES` and
 * whether the hint row exists. The spacer previously measured each row from its
 * `content` alone, so a six-line collapsed body counted as nothing and the
 * estimate ran low — which is the direction that pushes the composer off the
 * screen. A copy of the collapse rule kept over there would put it back the
 * first time this number changed.
 */
export function renderedDetailLines(message: TranscriptMessage): readonly string[] {
	const lines = message.detail
	if (!lines || lines.length === 0) return []
	const { shown, hidden } = splitDetail(lines, message.detailExpanded === true)
	// Indented by the gutter this block actually renders inside: `paddingLeft={1}`
	// plus the two-column `▏` rule. Those columns are not available to the text,
	// so measuring a body line against the full terminal width under-counts how
	// many rows it wraps to — and under-counting is the direction that pushes the
	// composer off the screen. The prefix is what the estimator measures, so the
	// arithmetic is done by making the string the width it really is.
	const gutter = '   '
	const body = shown.map((line) => gutter + line)
	// The hint's real text, `/expand n` included, because that is what wraps.
	return hidden > 0
		? [
				...body,
				`${gutter}… +${hidden} lines${
					message.detailRef === undefined ? '' : ` · /expand ${message.detailRef}`
				}`,
			]
		: body
}

function detailLineColor(line: string): string {
	if (line.startsWith('+')) return theme.status.ok
	if (line.startsWith('-')) return theme.status.error
	return theme.text.muted
}

function useSpinner(active: boolean): string {
	const [frame, setFrame] = useState<number>(0)
	useEffect(() => {
		if (!active) return
		const interval = setInterval(() => {
			setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
		}, 80)
		return () => clearInterval(interval)
	}, [active])
	return SPINNER_FRAMES[frame] ?? '⠋'
}

function glyphForRole(role: TranscriptMessage['role']): string {
	switch (role) {
		case 'user':
			return '>'
		case 'assistant':
			return '✦'
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
