/**
 * One-line status footer.
 *
 * Layout: `cwd · provider · model · state    hint` (provider/model elided
 * when null). A `│` divider separates the metadata cluster from the hint
 * so the eye can find the help-text without parsing the whole line.
 */

import { Text } from 'ink'

import { theme } from './theme.js'

/**
 * How full the context is, as the kernel reported it — never derived here.
 *
 * Every field is optional because the kernel omits all four when a run
 * resolved no window, and a partial pair is not something to patch up with a
 * default. See {@link buildGauge} for what is done with that.
 */
export interface ContextFill {
	readonly tokens?: number
	readonly windowTokens?: number
	readonly measuredBy?: 'provider' | 'estimate'
	readonly windowSource?: 'config' | 'model-table' | 'default'
}

export interface StatusBarProps {
	readonly cwd: string
	readonly provider: string | null
	readonly model: string | null
	readonly state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission'
	readonly hint?: string
	readonly usage?: { totalTokens: number; costUsd: number } | null
	/** Kernel-reported context fill — drives the gauge. */
	readonly context?: ContextFill | null
}

export function StatusBar({ cwd, provider, model, state, hint, usage, context }: StatusBarProps) {
	const segments: string[] = [shortenCwd(cwd)]
	if (provider) segments.push(provider)
	if (model) segments.push(model)
	if (usage && usage.totalTokens > 0) segments.push(formatUsage(usage))
	const gauge = buildGauge(context)
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
					{/* The `~` sits on the number rather than in a legend: this
					    footer is the only place the figure appears, so a reader
					    who never finds a legend still sees which of the two
					    readings they are being given. */}
					<Text color={gauge.color}>
						{gauge.bar} {gauge.approximate ? '~' : ''}
						{gauge.pct}%
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

export interface ContextGauge {
	readonly bar: string
	readonly pct: number
	readonly color: string
	/** Renders a `~` before the percentage. See below for when. */
	readonly approximate: boolean
}

/**
 * Build an 8-cell context-fill bar, greener when empty → red as it fills.
 *
 * Returns null unless BOTH terms arrived. The kernel omits them together when
 * a run resolved no window, and there is no window to substitute: the guess
 * that used to stand in here was a two-branch match on the model name, which
 * is the thing this gauge now exists without. A ratio nobody can ground is not
 * an approximation of anything, so the caller shows the spend alone instead.
 *
 * `approximate` keys off BOTH terms, not just the measured one. The kernel
 * ships each with its own provenance, and a fraction is only as sound as its
 * weaker half — an exact prompt count over an ASSUMED 128k window is a guess
 * with a precise-looking numerator, and marking only the numerator would
 * repeat, one level down, the error of presenting an inference as a reading.
 */
export function buildGauge(context: ContextFill | null | undefined): ContextGauge | null {
	if (!context) return null
	const { tokens, windowTokens } = context
	if (tokens === undefined || windowTokens === undefined) return null
	if (!(windowTokens > 0)) return null
	const clamped = Math.max(0, Math.min(1, tokens / windowTokens))
	const filled = Math.round(clamped * GAUGE_WIDTH)
	const bar = '█'.repeat(filled) + '░'.repeat(GAUGE_WIDTH - filled)
	const color = clamped < 0.7 ? theme.status.ok : clamped < 0.9 ? theme.status.warn : theme.status.error
	return {
		bar,
		pct: Math.round(clamped * 100),
		color,
		approximate: context.measuredBy !== 'provider' || context.windowSource === 'default',
	}
}

function shortenCwd(cwd: string): string {
	const home = process.env.HOME
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`
	}
	return cwd
}
