/**
 * The live region rendered just below the (static) transcript: the tool(s)
 * currently executing — each with an animated spinner and a ticking elapsed
 * timer — or, before the first token of a reply, a "thinking" line. Unlike
 * the transcript these rows re-render on a timer, so they stay tiny (only the
 * in-flight work) to keep per-frame cost bounded.
 */

import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'

import { theme } from './theme.js'

export interface ActiveTool {
	readonly id: string
	/** Display label, e.g. `Bash(npm test)`. */
	readonly label: string
	readonly startedAt: number
}

export interface LiveActivityProps {
	readonly activeTools: readonly ActiveTool[]
	/** Show the "thinking" line (model is working but nothing else is live). */
	readonly thinking: boolean
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export function LiveActivity({ activeTools, thinking }: LiveActivityProps) {
	const active = activeTools.length > 0 || thinking
	const tick = useTick(active, 100)
	if (!active) return null
	const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? '⠋'
	const now = Date.now()

	if (activeTools.length > 0) {
		return (
			<Box flexDirection="column">
				{activeTools.map((t) => (
					<Box key={t.id} flexDirection="row">
						<Box width={2} flexShrink={0}>
							<Text color={theme.accent.tool}>{spinner}</Text>
						</Box>
						<Text color={theme.text.secondary} wrap="truncate-end">
							{t.label}
							<Text color={theme.text.muted}> · {formatElapsed(now - t.startedAt)}</Text>
						</Text>
					</Box>
				))}
			</Box>
		)
	}
	return (
		<Box flexDirection="row">
			<Box width={2} flexShrink={0}>
				<Text color={theme.accent.assistant}>{spinner}</Text>
			</Box>
			<Text color={theme.text.muted}>thinking…</Text>
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
