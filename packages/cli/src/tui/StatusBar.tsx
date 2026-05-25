/**
 * One-line status footer.
 *
 * Layout: `cwd · provider · model · state    hint` (provider/model elided
 * when null). A `│` divider separates the metadata cluster from the hint
 * so the eye can find the help-text without parsing the whole line.
 */

import { Text } from 'ink'

import { theme } from './theme.js'

export interface StatusBarProps {
	readonly cwd: string
	readonly provider: string | null
	readonly model: string | null
	readonly state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission'
	readonly hint?: string
	readonly usage?: { totalTokens: number; costUsd: number } | null
	/** Model context window (tokens) — drives the context-fill gauge. */
	readonly contextWindow?: number | null
}

export function StatusBar({
	cwd,
	provider,
	model,
	state,
	hint,
	usage,
	contextWindow,
}: StatusBarProps) {
	const segments: string[] = [shortenCwd(cwd)]
	if (provider) segments.push(provider)
	if (model) segments.push(model)
	if (usage && usage.totalTokens > 0) segments.push(formatUsage(usage))
	const gauge =
		usage && usage.totalTokens > 0 && contextWindow && contextWindow > 0
			? buildGauge(usage.totalTokens / contextWindow)
			: null
	const stateLabel = stateGlyph(state)
	// A single Text with `truncate-end` keeps the footer to exactly one line
	// on narrow terminals (it shrinks with an ellipsis instead of wrapping),
	// while nested Text spans preserve per-segment color.
	return (
		<Text wrap="truncate-end">
			<Text color={theme.text.muted}>{segments.join(' · ')}</Text>
			{gauge ? (
				<>
					<Text color={theme.text.muted}> · ctx </Text>
					<Text color={gauge.color}>
						{gauge.bar} {gauge.pct}%
					</Text>
				</>
			) : null}
			<Text color={theme.text.muted}> │ </Text>
			<Text color={colorForState(state)}>{stateLabel}</Text>
			{hint ? (
				<>
					<Text color={theme.text.muted}> │ </Text>
					<Text color={theme.text.secondary}>{hint}</Text>
				</>
			) : null}
		</Text>
	)
}

function stateGlyph(state: StatusBarProps['state']): string {
	switch (state) {
		case 'idle':
			return '● idle'
		case 'thinking':
			return '◐ thinking'
		case 'tool':
			return '◑ tool'
		case 'awaiting-permission':
			return '◓ approve?'
	}
}

function colorForState(state: StatusBarProps['state']): string {
	switch (state) {
		case 'idle':
			return theme.status.ok
		case 'thinking':
			return theme.accent.system
		case 'tool':
		case 'awaiting-permission':
			return theme.status.warn
	}
}

function formatUsage(usage: { totalTokens: number; costUsd: number }): string {
	const tok =
		usage.totalTokens >= 1000
			? `${(usage.totalTokens / 1000).toFixed(1)}k tok`
			: `${usage.totalTokens} tok`
	return usage.costUsd > 0 ? `${tok} · $${usage.costUsd.toFixed(2)}` : tok
}

const GAUGE_WIDTH = 8

/** Build an 8-cell context-fill bar, greener when empty → red as it fills. */
function buildGauge(frac: number): { bar: string; pct: number; color: string } {
	const clamped = Math.max(0, Math.min(1, frac))
	const filled = Math.round(clamped * GAUGE_WIDTH)
	const bar = '█'.repeat(filled) + '░'.repeat(GAUGE_WIDTH - filled)
	const color = clamped < 0.7 ? theme.status.ok : clamped < 0.9 ? theme.status.warn : theme.status.error
	return { bar, pct: Math.round(clamped * 100), color }
}

function shortenCwd(cwd: string): string {
	const home = process.env.HOME
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`
	}
	return cwd
}
