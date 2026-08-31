/**
 * The live region rendered just below the (static) transcript: the tool(s)
 * currently executing — each with an animated spinner and a ticking elapsed
 * timer — or, before the first token of a reply, a "thinking" line. Unlike
 * the transcript these rows re-render on a timer, so they stay tiny (only the
 * in-flight work) to keep per-frame cost bounded.
 */

import { Box, Text } from 'ink'
import { useEffect, useRef, useState } from 'react'

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
}

export interface LiveActivityProps {
	readonly activeTools: readonly ActiveTool[]
	/** The parent turn is active, including while answer text is streaming. */
	readonly working: boolean
	/** Actual child runs retained by the current conversation. */
	readonly agentCount?: number
	/** Whether Esc currently reaches an abortable parent turn. */
	readonly interruptible?: boolean
	/** False for non-interactive renderers and deterministic snapshots. */
	readonly animate?: boolean
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const MAX_VISIBLE_TOOLS = 3

export function LiveActivity({
	activeTools,
	working,
	agentCount = 0,
	interruptible = false,
	animate = true,
}: LiveActivityProps) {
	const active = activeTools.length > 0 || working
	const startedAtRef = useRef<number | null>(null)
	if (active && startedAtRef.current === null) startedAtRef.current = Date.now()
	if (!active) startedAtRef.current = null
	const tick = useTick(active && animate, 120)
	if (!active) return null
	const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? '⠋'
	const now = Date.now()
	const elapsed = formatElapsed(now - (startedAtRef.current ?? now))
	const visibleTools = activeTools.slice(0, MAX_VISIBLE_TOOLS)
	const hiddenTools = activeTools.length - visibleTools.length

	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<Text color={theme.accent.assistant}>• </Text>
				<ShimmerText text="Working" tick={tick} animate={animate} />
				<Text color={theme.text.muted}>
					{' ('}
					{elapsed}
					{agentCount > 0
						? ` · ${agentCount} agent${agentCount === 1 ? '' : 's'} · /agent to view`
						: ''}
					{interruptible ? ' · esc to interrupt' : ''})
				</Text>
			</Box>
			{visibleTools.map((t, index) => {
				const percent = t.fraction === undefined ? '' : `${Math.round(t.fraction * 100)}% · `
				return (
					<Box key={t.id} flexDirection="column" paddingLeft={2}>
						<Box flexDirection="row">
							<Box width={2} flexShrink={0}>
								<Text color={theme.accent.tool}>
									{index === visibleTools.length - 1 && hiddenTools === 0 ? '└' : '├'}
								</Text>
							</Box>
							<Text color={theme.text.secondary} wrap="truncate-end">
								<Text color={theme.accent.tool}>{spinner} </Text>
								{terminalDisplayText(t.label)}
								<Text color={theme.text.muted}> · {formatElapsed(now - t.startedAt)}</Text>
							</Text>
						</Box>
						{t.progress !== undefined ? (
							<Box flexDirection="row" paddingLeft={2}>
								<Text color={theme.text.muted} wrap="truncate-end">
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
		</Box>
	)
}

/** Three spans regardless of text length: animation cost stays constant. */
function ShimmerText({
	text,
	tick,
	animate,
}: {
	readonly text: string
	readonly tick: number
	readonly animate: boolean
}) {
	if (!animate || text.length < 2) return <Text color={theme.text.secondary}>{text}</Text>
	const sweep = (tick % (text.length + 4)) - 2
	const start = Math.max(0, Math.min(text.length, sweep))
	const end = Math.max(start, Math.min(text.length, sweep + 3))
	return (
		<Text>
			<Text color={theme.text.muted} dimColor>
				{text.slice(0, start)}
			</Text>
			<Text color={theme.text.primary} bold>
				{text.slice(start, end)}
			</Text>
			<Text color={theme.text.secondary}>{text.slice(end)}</Text>
		</Text>
	)
}

/** Re-render `interval` ms while `active`; returns an incrementing counter. */
function useTick(active: boolean, interval: number): number {
	const [n, setN] = useState<number>(0)
	useEffect(() => {
		if (!active) return
		const id = setInterval(() => setN((v) => v + 1), interval)
		return () => clearInterval(id)
	}, [active, interval])
	return n
}

/** `420ms` → `0.4s`, `3210ms` → `3.2s`, `12000ms` → `12s`, `83000ms` → `1m23s`. */
export function formatElapsed(ms: number): string {
	const s = ms / 1000
	if (s < 10) return `${s.toFixed(1)}s`
	if (s < 60) return `${Math.round(s)}s`
	const m = Math.floor(s / 60)
	return `${m}m${Math.round(s - m * 60)}s`
}
