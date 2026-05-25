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
	/** When true, collapsed tool diffs/output are shown in full (Ctrl+O). */
	readonly expanded: boolean
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

export function Transcript({
	messages,
	pending,
	state,
	expanded,
	resetKey,
	header,
}: TranscriptProps) {
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
						<MessageRow
							key={row.message.id}
							message={row.message}
							prev={row.prev}
							spinner=""
							expanded={expanded}
						/>
					)
				}
			</Static>
			{pending ? (
				<MessageRow
					message={pending}
					prev={messages[messages.length - 1]}
					spinner={spinner}
					expanded={expanded}
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
	expanded,
}: {
	readonly message: TranscriptMessage
	readonly prev: TranscriptMessage | undefined
	readonly spinner: string
	readonly expanded: boolean
}) {
	const glyph = message.pending ? spinner : (message.glyph ?? glyphForRole(message.role))
	// The `⎿` tool-result gutter is rendered dim so the call line leads.
	const glyphColor = glyph === '⎿' ? theme.text.muted : glyphColorForRole(message.role)
	// One blank line before each entry, except the first and `⎿` result rows,
	// which hug the `⏺` tool call above them (Claude-Code-style grouping).
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
							{message.pending && message.content.length === 0 ? (
								<Text color={theme.text.muted}>…</Text>
							) : null}
						</Text>
					)}
				</Box>
			</Box>
			{message.detail && message.detail.length > 0 ? (
				<DetailBlock lines={message.detail} expanded={expanded} />
			) : null}
		</Box>
	)
}

/** Collapsible tool diff / output, aligned under the content gutter. */
function DetailBlock({
	lines,
	expanded,
}: {
	readonly lines: readonly string[]
	readonly expanded: boolean
}) {
	const shown = expanded ? lines : lines.slice(0, COLLAPSE_LINES)
	const hidden = lines.length - shown.length
	return (
		<Box flexDirection="column" paddingLeft={2}>
			{shown.map((line, i) => (
				<Text key={`d-${i}`} color={detailLineColor(line)} wrap="wrap">
					{line.length > 0 ? line : ' '}
				</Text>
			))}
			{hidden > 0 ? (
				<Text color={theme.text.muted}>… +{hidden} lines (ctrl+o to expand)</Text>
			) : null}
		</Box>
	)
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
