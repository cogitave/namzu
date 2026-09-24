/**
 * How the TUI names its multi-agent session mode, in one place.
 *
 * Hypermode was called "orchestrate" until the rename; `/orchestrate` still
 * works as a deprecated alias of `/hypermode` (see `slashCommands.ts`). The
 * mode pins reasoning effort to the model's highest published level and
 * strengthens the delegation doctrine toward delegating by default
 * (`CODING_AGENT_HYPERMODE_DOCTRINE` in `@namzu/sdk`). "Workflows" is this
 * terminal's word for that phased multi-agent work.
 */

/** The mode's name wherever the operator reads it: footer, border tag, picker. */
export const HYPERMODE = 'hypermode'

/** The one-line description the effort picker shows for the hypermode stop. */
export const HYPERMODE_SUMMARY = 'delegates to parallel agents by default'

/**
 * The effort picker's last stop: the level the mode pins, then the mode —
 * `xhigh + hypermode (workflows)` for a model whose menu ends at `xhigh`.
 * Without a published menu there is no level to name.
 */
export function hypermodeStopLabel(highest: string | undefined): string {
	return highest ? `${highest} + ${HYPERMODE} (workflows)` : `${HYPERMODE} (workflows)`
}

/** The deprecation line `/orchestrate` prints before it does what `/hypermode` does. */
export const ORCHESTRATE_ALIAS_NOTICE =
	'/orchestrate is deprecated: the mode is now called hypermode. Use /hypermode; /orchestrate will be removed in a later major version.'
