/**
 * How the TUI names its multi-agent session mode, in one place.
 *
 * Hypermode was called "orchestrate" until the rename; `/orchestrate` still
 * works as a deprecated alias of `/hypermode` (see `slashCommands.ts`). The
 * mode pins reasoning effort to `xhigh` — or, on a model whose menu has no
 * `xhigh`, the level nearest below it (see {@link hypermodeEffort}) — and
 * strengthens the delegation doctrine toward delegating by default
 * (`CODING_AGENT_HYPERMODE_DOCTRINE` in `@namzu/sdk`). "Workflows" is this
 * terminal's word for that phased multi-agent work.
 */

import type { ReasoningEffort } from '@namzu/sdk'

/** The mode's name wherever the operator reads it: footer, border tag, picker. */
export const HYPERMODE = 'hypermode'

/** The one-line description the effort picker shows for the hypermode stop. */
export const HYPERMODE_SUMMARY = 'delegates to parallel agents by default'

/** The level hypermode pins wherever the model publishes it. */
export const HYPERMODE_EFFORT: ReasoningEffort = 'xhigh'

/** Every effort level, low to high: the order of the SDK's `ReasoningEffort` union. */
const EFFORT_ORDER: readonly ReasoningEffort[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
]

/**
 * The level hypermode pins on a model that publishes `levels`: `xhigh`, or
 * the highest published level below it when the menu has no `xhigh`
 * (`high` on a menu that stops there). `max` and `ultra` are never chosen
 * over a lower level; only a menu made entirely of levels above `xhigh`
 * gets its lowest one, the nearest there is. `undefined` when the model
 * publishes no menu, or an empty one: nothing is pinned.
 */
export function hypermodeEffort(
	levels: readonly ReasoningEffort[] | undefined,
): ReasoningEffort | undefined {
	if (!levels || levels.length === 0) return undefined
	const ceiling = EFFORT_ORDER.indexOf(HYPERMODE_EFFORT)
	const rank = (level: ReasoningEffort) => EFFORT_ORDER.indexOf(level)
	const atOrBelow = levels.filter((level) => rank(level) >= 0 && rank(level) <= ceiling)
	if (atOrBelow.length > 0)
		return atOrBelow.reduce((best, level) => (rank(level) > rank(best) ? level : best))
	return levels.reduce((best, level) => (rank(level) < rank(best) ? level : best))
}

/**
 * The effort picker's last stop: the level the mode pins, then the mode —
 * `xhigh + hypermode (workflows)`, or `high + hypermode (workflows)` on a
 * model whose menu stops at `high`. Without a published menu there is no
 * level to name.
 */
export function hypermodeStopLabel(pinned: string | undefined): string {
	return pinned ? `${pinned} + ${HYPERMODE} (workflows)` : `${HYPERMODE} (workflows)`
}

/** The deprecation line `/orchestrate` prints before it does what `/hypermode` does. */
export const ORCHESTRATE_ALIAS_NOTICE =
	'/orchestrate is deprecated: the mode is now called hypermode. Use /hypermode; /orchestrate will be removed in a later major version.'
