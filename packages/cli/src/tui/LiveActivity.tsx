/**
 * The live region rendered just below the (static) transcript: the tool(s)
 * currently executing, with elapsed time and progress, or a "thinking" line
 * before the first token of a reply. One spinner on the Working row marks the
 * active turn. These rows stay tiny to keep per-frame cost bounded.
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
	/** Show the current tool and total count in two rows on a short terminal. */
	readonly compact?: boolean
	readonly activeTools: readonly ActiveTool[]
	/** The parent turn is active, including while answer text is streaming. */
	readonly working: boolean
	/** Actual child runs retained by the current conversation. */
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
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const MAX_VISIBLE_TOOLS = 3

export function LiveActivity({
	compact = false,
	activeTools,
	working,
	agentCount = 0,
	interruptible = false,
	animate = true,
	thinking = null,
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

	if (compact) {
		const current = activeTools[0]
		return (
			<Box flexDirection="column">
				<Text wrap="truncate-end">
					<Text color={theme.accent.assistant}>{spinner} </Text>
					<Text color={theme.text.secondary}>Working</Text>
					<Text color={theme.text.muted}>
						{' · '}
						{elapsed}
						{activeTools.length > 0
							? ` · ${activeTools.length} tool${activeTools.length === 1 ? '' : 's'}`
							: ''}
					</Text>
				</Text>
				{current ? (
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
				<Text color={theme.accent.assistant}>{animate ? spinner : '∴'} </Text>
				<Text color={theme.text.secondary}>Working</Text>
				<Text color={theme.text.muted}>
					{' ('}
					{elapsed}
					{agentCount > 0
						? ` · ${agentCount} agent${agentCount === 1 ? '' : 's'} · ctrl+t to view`
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
