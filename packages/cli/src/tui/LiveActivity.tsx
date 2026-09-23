/**
 * The live region rendered just below the (static) transcript: the tool(s)
 * currently executing, with elapsed time and progress, or a "thinking" line
 * before the first token of a reply. A green fill through the Working label marks the
 * active turn. These rows stay tiny to keep per-frame cost bounded.
 */

import { Box, Text, useAnimation, useIsScreenReaderEnabled, useStdout } from 'ink'
import { useRef } from 'react'

import { formatCompactCount, formatElapsed } from './units.js'
import type { WebActivity } from './web-activity.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

export interface ActiveTool {
	readonly id: string
	/** Display label, e.g. `Bash(npm test)`. */
	readonly label: string
	readonly startedAt: number
	/** Latest bounded progress state; intermediate updates are intentionally coalesced. */
	readonly progress?: string
	readonly fraction?: number
	/**
	 * Set when this call is a `wait_for_task` on a delegated agent the monitor
	 * knows: that agent's description. When every running call is such a
	 * wait, the rows fold into one `✻ Waiting for …` line.
	 */
	readonly waitingOn?: string
	/** A web search or fetch: its `progress` line is drawn as the call's `⎿` status. */
	readonly web?: WebActivity
}

export interface LiveActivityProps {
	/** Show the current tool and total count in two rows on a short terminal. */
	readonly compact?: boolean
	readonly activeTools: readonly ActiveTool[]
	/** The parent turn is active, including while answer text is streaming. */
	readonly working: boolean
	/** Actual child sessions retained by the current conversation. */
	readonly agentCount?: number
	/** Whether Esc currently reaches an abortable parent turn. */
	readonly interruptible?: boolean
	/** False for non-interactive renderers and deterministic snapshots. */
	readonly animate?: boolean
	/**
	 * The model's current line of reasoning, or `null`. Shown dim under the
	 * Working row and nowhere else; an empty string means "thinking, but the
	 * provider gave no readable text" and still earns the row.
	 */
	readonly thinking?: string | null
	/**
	 * Output tokens this turn has produced so far, as `↓ 1.1k tokens`. The
	 * provider's own count once it has reported one, plus an estimate of what
	 * has streamed since. Absent or zero draws nothing.
	 */
	readonly tokens?: number
}

const MAX_VISIBLE_TOOLS = 3

export function LiveActivity({
	compact = false,
	activeTools,
	working,
	agentCount = 0,
	interruptible = false,
	animate = true,
	thinking = null,
	tokens,
}: LiveActivityProps) {
	const { stdout } = useStdout()
	const screenReader = useIsScreenReaderEnabled()
	const motion =
		animate &&
		stdout.isTTY === true &&
		!screenReader &&
		process.env.NO_COLOR === undefined &&
		process.env.FORCE_COLOR !== '0' &&
		process.env.TERM !== 'dumb'
	const active = activeTools.length > 0 || working
	const startedAtRef = useRef<number | null>(null)
	if (active && startedAtRef.current === null) startedAtRef.current = Date.now()
	if (!active) startedAtRef.current = null
	const { frame: tick } = useAnimation({ isActive: active && motion, interval: 120 })
	if (!active) return null
	const label = 'Working'
	const edge = tick % (label.length + 1)
	const mark = (
		<Text>
			{Array.from(label, (char, column) => (
				<Text
					key={column}
					color={
						!motion
							? theme.text.secondary
							: column < edge
								? 'greenBright'
								: column === edge
									? 'whiteBright'
									: theme.text.muted
					}
				>
					{char}
				</Text>
			))}
		</Text>
	)
	const now = Date.now()
	const elapsed = formatElapsed(now - (startedAtRef.current ?? now))
	const spent = tokens !== undefined && tokens > 0 ? ` · ↓ ${formatCompactCount(tokens)} tokens` : ''
	const waiting = waitingLine(activeTools)
	const visibleTools = waiting ? [] : activeTools.slice(0, MAX_VISIBLE_TOOLS)
	const hiddenTools = waiting ? 0 : activeTools.length - visibleTools.length
	const waitingRow = waiting ? (
		<Box paddingLeft={2}>
			<Text color={theme.text.secondary} wrap="truncate-end">
				✻ {terminalDisplayText(waiting)}
			</Text>
		</Box>
	) : null

	if (compact) {
		const current = activeTools[0]
		return (
			<Box flexDirection="column">
				<Box>
					{mark}
					<Text color={theme.text.muted}>
						{' · '}
						{elapsed}
						{spent}
						{activeTools.length > 0
							? ` · ${activeTools.length} tool${activeTools.length === 1 ? '' : 's'}`
							: ''}
					</Text>
				</Box>
				{waitingRow ? (
					waitingRow
				) : current ? (
					<Box paddingLeft={2}>
						<Text color={theme.text.secondary} wrap="truncate-end">
							{terminalDisplayText(current.label)}
							{current.progress ? (
								<Text color={theme.text.muted}> · {terminalDisplayText(current.progress)}</Text>
							) : null}
						</Text>
					</Box>
				) : thinking !== null ? (
					<Box paddingLeft={2}>
						<Text color={theme.text.muted} wrap="truncate-end">
							thinking{thinking ? ` · ${terminalDisplayText(thinking)}` : '…'}
						</Text>
					</Box>
				) : null}
			</Box>
		)
	}

	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				{/* The label keeps its letters on a narrow terminal; the figures after
				    it are what gets cut, with an ellipsis. */}
				<Box flexShrink={0}>{mark}</Box>
				<Text color={theme.text.muted} wrap="truncate-end">
					{' ('}
					{elapsed}
					{spent}
					{agentCount > 0
						? ` · ${agentCount} agent${agentCount === 1 ? '' : 's'} · ctrl+t to view`
						: ''}
					{interruptible ? ' · esc to interrupt' : ''})
				</Text>
			</Box>
			{waitingRow}
			{visibleTools.map((t, index) => {
				const percent = t.fraction === undefined ? '' : `${Math.round(t.fraction * 100)}% · `
				return (
					<Box key={t.id} flexDirection="column" paddingLeft={2}>
						<Box flexDirection="row">
							<Box width={2} flexShrink={0}>
								<Text color={theme.text.muted}>
									{index === visibleTools.length - 1 && hiddenTools === 0 ? '└' : '├'}
								</Text>
							</Box>
							<Text color={theme.text.secondary} wrap="truncate-end">
								{terminalDisplayText(t.label)}
								<Text color={theme.text.muted}> · {formatElapsed(now - t.startedAt)}</Text>
							</Text>
						</Box>
						{t.progress !== undefined ? (
							<Box flexDirection="row" paddingLeft={2}>
								<Text color={theme.text.muted} wrap="truncate-end">
									{t.web ? '⎿ ' : ''}
									{percent}
									{terminalDisplayText(t.progress)}
								</Text>
							</Box>
						) : null}
					</Box>
				)
			})}
			{hiddenTools > 0 ? (
				<Box paddingLeft={2}>
					<Text color={theme.text.muted}>└ +{hiddenTools} more tools</Text>
				</Box>
			) : null}
			{thinking !== null && activeTools.length === 0 ? (
				<Box paddingLeft={2}>
					<Text color={theme.text.muted} wrap="truncate-end">
						└ thinking{thinking.length > 0 ? ` · ${terminalDisplayText(thinking)}` : '…'}
					</Text>
				</Box>
			) : null}
		</Box>
	)
}

/**
 * One line for a turn that is only waiting on its delegated agents, or
 * `undefined` when any running call is something else — a wait mixed with
 * real work keeps every row, so the work is never hidden behind the wait.
 */
export function waitingLine(tools: readonly ActiveTool[]): string | undefined {
	if (tools.length === 0 || !tools.every((tool) => tool.waitingOn !== undefined)) return undefined
	const names = [...new Set(tools.map((tool) => tool.waitingOn as string))]
	return names.length === 1 ? `Waiting for ${names[0]}` : `Waiting for ${names.length} agents to finish`
}

export { formatElapsed } from './units.js'
