/**
 * How the TUI names its multi-agent session mode, in one place.
 *
 * Hypermode was called "orchestrate" until the rename; `/orchestrate` still
 * works as a deprecated alias of `/hypermode` (see `slashCommands.ts`). The
 * mode is an independent on/off: it never changes the reasoning effort. While
 * it is on, the model is reminded to use the `workflow` tool for substantive
 * work (see `reminders/hypermode.ts`). "Workflows" is this terminal's word for
 * that phased multi-agent work.
 */

/** The mode's name wherever the operator reads it: footer and picker. */
export const HYPERMODE = 'hypermode'

/** The one-line description the effort picker shows for the hypermode row. */
export const HYPERMODE_SUMMARY = 'workflows on every substantial task'

/** The picker row's name: the mode, and what it is for. */
export const HYPERMODE_ROW_LABEL = `${HYPERMODE} (workflows)`

/** The deprecation line `/orchestrate` prints before it does what `/hypermode` does. */
export const ORCHESTRATE_ALIAS_NOTICE =
	'/orchestrate is deprecated: the mode is now called hypermode. Use /hypermode; /orchestrate will be removed in a later major version.'

/** What the effort item in the footer says while the mode is on: `effort high · Hypermode on`. */
export const HYPERMODE_FOOTER_NOTE = 'Hypermode on'

/** What `/hypermode on` and the picker say. `effort` is the level in force, said as it stays. */
export function hypermodeOnMessage(effort: string | undefined): string {
	return `Hypermode is on for this conversation: Namzu will use workflows for substantial tasks. ${effortStays(effort)}`
}

/** What `/hypermode off` and the picker say. */
export function hypermodeOffMessage(effort: string | undefined): string {
	return `Hypermode is off: workflows are offered only when you ask for one. ${effortStays(effort)}`
}

function effortStays(effort: string | undefined): string {
	return effort ? `Effort stays ${effort}.` : 'Effort stays at the model default.'
}

/** The one-turn keyword's text: for this message only, nothing is stored. */
export const HYPERMODE_KEYWORD_TEXT =
	'The operator included the keyword "hypermode", opting this turn into multi-agent orchestration: use the `workflow` tool to fulfil the request. It is for this turn only; it is not on for the session.'
