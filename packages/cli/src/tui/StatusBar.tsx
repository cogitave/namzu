/**
 * One-line status footer.
 *
 * Layout follows the operator's reading order: `model effort · cwd` on the
 * left, current goal or interaction status on the right. The right side owns
 * its columns first so a deep path cannot erase the key that exits a prompt.
 */

import type { CostInfo } from '@namzu/sdk'
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
	readonly windowSource?: 'config' | 'provider' | 'model-table' | 'default'
}

export interface StatusBarProps {
	readonly cwd: string
	readonly provider: string | null
	readonly model: string | null
	readonly effort?: string | null
	/** Ambient durable goal status; interaction hints take precedence. */
	readonly goal?: string | null
	readonly state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission'
	readonly hint?: string
	readonly usage?: { totalTokens: number; cost: CostInfo } | null
	/** Kernel-reported context fill — drives the gauge. */
	readonly context?: ContextFill | null
}

export function StatusBar({
	cwd,
	provider,
	model,
	effort,
	goal,
	state,
	hint,
	usage,
	context,
}: StatusBarProps) {
	const { stdout } = useStdout()
	const gauge = buildGauge(context)
	const layout = fitStatusLine({
		// App gives the footer one cell of horizontal padding on each side. Ink's
		// stdout width is the whole terminal, so reserve those cells here rather
		// than letting its final two characters be clipped after fitting succeeds.
		columns: Math.max(0, (stdout?.columns ?? 80) - 2),
		cwd: shortenCwd(cwd),
		provider,
		model,
		effort: model ? (effort ?? 'default') : null,
		usage: usage && usage.totalTokens > 0 ? formatUsage(usage) : null,
		context: gauge
			? `ctx ${gauge.bar} ${gauge.approximate ? '~' : ''}${gauge.pct}%`
			: null,
		stateLabel: stateGlyph(state),
		hint,
		goal,
	})
	return (
		<Text wrap="truncate-end">
			{layout.primary ? (
				<Text color={theme.status.warn} bold>
					{layout.primary}
				</Text>
			) : null}
			{layout.effort ? <Text color={theme.text.secondary}> {layout.effort}</Text> : null}
			{layout.cwd ? (
				<>
					{layout.primary ? <Text color={theme.text.muted}> · </Text> : null}
					<Text color={theme.status.ok}>{layout.cwd}</Text>
				</>
			) : null}
			<Text>{layout.gap}</Text>
			<Text color={goal && !hint ? theme.accent.system : colorForState(state)}>
				{layout.right}
			</Text>
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

function formatUsage(usage: { totalTokens: number; cost: CostInfo }): string {
	const tok =
		usage.totalTokens >= 1000
			? `${(usage.totalTokens / 1000).toFixed(1)}k tok`
			: `${usage.totalTokens} tok`
	// The bar has room for a figure, not for a sentence, so the unknown case
	// gets a mark rather than an explanation and `/cost` carries the words.
	//
	// Showing tokens alone — what this did for any total not above zero — is
	// the same claim the `/cost` page was making in longer form: an operator
	// reads a missing cost as no cost. `$?` is deliberately not a number,
	// because the one thing that must not happen here is a figure standing in
	// for a figure nobody has.
	if (usage.cost.unpricedTokens > 0) return `${tok} · $?`
	return usage.cost.totalCost > 0 ? `${tok} · $${usage.cost.totalCost.toFixed(2)}` : tok
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

export interface StatusLineLayout {
	readonly primary: string | null
	readonly effort: string | null
	readonly cwd: string | null
	readonly gap: string
	readonly right: string
}

/**
 * Fit the left identity around an authoritative right-side indicator.
 *
 * A hint can be the only on-screen explanation of how to leave a prompt, and
 * a goal label is the durable work state the screenshot is meant to expose.
 * Both therefore reserve their width before a path does. The path shortens
 * from the left; effort then yields; the model is the last left-side fact.
 */
export function fitStatusLine(input: {
	readonly columns: number
	readonly cwd: string
	readonly provider: string | null
	readonly model: string | null
	readonly effort?: string | null
	readonly usage: string | null
	readonly context: string | null
	readonly stateLabel: string
	readonly hint?: string | undefined
	readonly goal?: string | null | undefined
}): StatusLineLayout {
	const columns = Math.max(0, input.columns)
	const ambient = [input.context, input.usage, input.stateLabel].filter(
		(value): value is string => Boolean(value),
	)
	let right = input.hint
		? [...ambient.slice(0, -1), `${input.stateLabel} · ${input.hint}`].join(' · ')
		: input.goal
			? input.goal
			: ambient.join(' · ')
	if (right.length > columns) right = shortenRightToFit(right, columns)

	const primarySource = input.model ?? input.provider
	let primary = primarySource
	let effort = primary && input.model ? (input.effort ?? null) : null
	let cwd: string | null = input.cwd.length > 0 ? input.cwd : null
	const gapWidth = right.length > 0 ? 1 : 0
	const leftBudget = Math.max(0, columns - right.length - gapWidth)

	const left = (): string => {
		const identity = [primary, effort].filter((value): value is string => Boolean(value)).join(' ')
		return [identity, cwd].filter((value): value is string => Boolean(value)).join(' · ')
	}

	if (left().length > leftBudget && cwd) {
		const identityWidth = [primary, effort]
			.filter((value): value is string => Boolean(value))
			.join(' ').length
		const room = leftBudget - identityWidth - (identityWidth > 0 ? 3 : 0)
		cwd = room >= 8 ? shortenPathToFit(cwd, room) : null
	}
	if (left().length > leftBudget) effort = null
	if (left().length > leftBudget) cwd = null
	if (left().length > leftBudget && primary) {
		primary = shortenRightToFit(primary, leftBudget)
	}
	if (left().length > leftBudget) primary = null

	const leftWidth = left().length
	const visibleGap = leftWidth > 0 && right.length > 0 ? 1 : 0
	const gap = ' '.repeat(Math.max(visibleGap, columns - leftWidth - right.length))
	return { primary, effort, cwd, gap, right }
}

/** Preserve both the status identity and its trailing key/action on tiny screens. */
function shortenRightToFit(value: string, max: number): string {
	if (max <= 0) return ''
	if (value.length <= max) return value
	if (max === 1) return '…'
	const available = max - 1
	const head = Math.ceil(available * 0.45)
	return `${value.slice(0, head)}…${value.slice(-(available - head))}`
}
