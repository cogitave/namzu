/**
 * One-line status footer.
 *
 * Layout: `cwd · provider · model · state    hint` (provider/model elided
 * when null). A `│` divider separates the metadata cluster from the hint
 * so the eye can find the help-text without parsing the whole line.
 */

import { Text, useStdout } from 'ink'

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
	const { stdout } = useStdout()
	const gaugeRaw = buildGauge(context)
	const stateLabel = stateGlyph(state)
	// Decide what fits before rendering, rather than letting the terminal cut
	// the line wherever it runs out. `truncate-end` alone always sacrifices the
	// hint, because the hint is last — see `fitStatusLine`.
	const { meta, showGauge } = fitStatusLine({
		columns: stdout?.columns ?? 80,
		cwd: shortenCwd(cwd),
		provider,
		model,
		usage: usage && usage.totalTokens > 0 ? formatUsage(usage) : null,
		// ` · ctx ` + bar + optional `~` + up to `100%`
		gaugeCells: gaugeRaw ? GAUGE_WIDTH + 12 : 0,
		stateLabel,
		hint,
	})
	const gauge = showGauge ? gaugeRaw : null
	// A single Text with `truncate-end` keeps the footer to exactly one line
	// on narrow terminals (it shrinks with an ellipsis instead of wrapping),
	// while nested Text spans preserve per-segment color.
	return (
		<Text wrap="truncate-end">
			<Text color={theme.text.muted}>{meta}</Text>
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

/**
 * A path shortened from the LEFT, keeping the leaf.
 *
 * The end of a path is the informative end: `core` says which package you are
 * in, `/home` says nothing you did not know. Cutting resumes at a separator
 * when one is near the cut, so the result still reads as a path rather than as
 * a word broken in half.
 */
export function shortenPathToFit(path: string, max: number): string {
	if (max <= 0) return ''
	if (path.length <= max) return path
	if (max === 1) return '…'
	const tail = path.slice(-(max - 1))
	const slash = tail.indexOf('/')
	// Only snap to a separator if one is close, or a long leading segment would
	// cost more than it explains.
	const snapped = slash >= 0 && slash <= 12 ? tail.slice(slash) : tail
	return `…${snapped}`
}

/**
 * What fits on the status line, and in what order things yield.
 *
 * The line is one row that truncates from the end, and the hint sits at the
 * end — so anything ahead of it that grows pushes it off the screen. The hint
 * is the only place any key is advertised: the trust gate's `Esc`, the
 * permission prompt's `y`/`n`/`a`, the picker's exits all exist on screen here
 * and nowhere else. Losing it strands the operator on a screen whose exits have
 * become undiscoverable, so it is the one thing never dropped.
 *
 * Everything else is recoverable elsewhere and yields in this order:
 *
 * 1. **usage** — `/cost` prints it exactly, and this is the abbreviation.
 * 2. **the context gauge** — same figure, same command.
 * 3. **provider** — the longest segment and the least distinctive, since the
 *    model name already implies it. A credential-qualified provider label runs
 *    to about thirty columns and repeats a vendor the model string has already
 *    named.
 * 4. **the working directory, shortened** — a shortened path still orients,
 *    so it is cut before anything else is given up.
 * 5. **model**, and only then the path entirely. Both are on the banner and in
 *    `/model`, but between them these are the two facts worth keeping longest:
 *    where you are, and what is answering you.
 *
 * The order was corrected by the tests: dropping the path first discarded a
 * two-character cwd to save five columns while a thirty-column provider label
 * survived, which is the wrong trade in every case it can happen.
 *
 * Measured rather than assumed, and the measurement changed the design: a
 * SHORT path still lost the hint at 100 columns, because a realistic provider
 * and model fill the line between them. Shortening the path alone would have
 * fixed the case that was easiest to picture and left the common one broken.
 */
export function fitStatusLine(input: {
	readonly columns: number
	readonly cwd: string
	readonly provider: string | null
	readonly model: string | null
	readonly usage: string | null
	readonly gaugeCells: number
	readonly stateLabel: string
	readonly hint?: string | undefined
}): { readonly meta: string; readonly showGauge: boolean } {
	const { columns, cwd, provider, model, usage, gaugeCells, stateLabel, hint } = input
	// Reserved, in order of what cannot move: the hint and its divider, then the
	// state and its divider.
	const reserved = (hint ? 3 + hint.length : 0) + 3 + stateLabel.length
	let budget = Math.max(0, columns - reserved)

	let showGauge = gaugeCells > 0
	let withUsage = usage !== null
	let withCwd = true
	let withModel = model !== null
	let withProvider = provider !== null

	const build = (cwdText: string): string => {
		const parts: string[] = []
		if (withCwd && cwdText.length > 0) parts.push(cwdText)
		if (withProvider && provider) parts.push(provider)
		if (withModel && model) parts.push(model)
		if (withUsage && usage) parts.push(usage)
		return parts.join(' · ')
	}

	const width = (cwdText: string): number =>
		build(cwdText).length + (showGauge ? gaugeCells : 0)

	// Everything fits as-is.
	if (width(cwd) <= budget) return { meta: build(cwd), showGauge }

	// Drop the two figures `/cost` reprints exactly.
	if (withUsage) {
		withUsage = false
		if (width(cwd) <= budget) return { meta: build(cwd), showGauge }
	}
	if (showGauge) {
		showGauge = false
		if (width(cwd) <= budget) return { meta: build(cwd), showGauge }
	}

	// Then the provider label, which the model name already implies.
	if (withProvider) {
		withProvider = false
		if (width(cwd) <= budget) return { meta: build(cwd), showGauge }
	}

	// Then shorten the path into whatever room is left, before giving it up.
	const withoutCwd = build('').length
	const roomForCwd = budget - withoutCwd - (withoutCwd > 0 ? 3 : 0)
	if (roomForCwd >= 8) {
		const short = shortenPathToFit(cwd, roomForCwd)
		if (width(short) <= budget) return { meta: build(short), showGauge }
	}

	// Then the model, and only then the path entirely.
	withModel = false
	if (width(cwd) <= budget) return { meta: build(cwd), showGauge }
	if (roomForCwd >= 8) {
		const short = shortenPathToFit(cwd, Math.max(0, budget))
		if (width(short) <= budget) return { meta: build(short), showGauge }
	}

	withCwd = false
	return { meta: build(''), showGauge }
}
