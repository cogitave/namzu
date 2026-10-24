/**
 * How the TUI names its multi-agent session mode, in one place.
 *
 * Hypermode was called "orchestrate" until the rename; `/orchestrate` still
 * works as a deprecated alias of `/hypermode` (see `slashCommands.ts`). The
 * mode is an independent on/off: it never changes the reasoning effort. While
 * it is on, the model is told once on entry, again every
 * {@link HYPERMODE_REMINDER_EVERY} messages, and once on exit, in request-only
 * context, to use the `workflow` tool for substantive work. "Workflows" is
 * this terminal's word for that phased multi-agent work.
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

/** User messages between the sparse reminders (default 10). */
export const HYPERMODE_REMINDER_EVERY = 10

/** The one-turn keyword's text: for this message only, nothing is stored. */
export const HYPERMODE_KEYWORD_TEXT =
	'The operator included the keyword "hypermode", opting this turn into multi-agent orchestration: use the `workflow` tool to fulfil the request. It is for this turn only; it is not on for the session.'

const FULL_WITH_TOOL =
	'Hypermode is on: optimize for the most exhaustive, correct answer, not the fastest or cheapest. Use the `workflow` tool on every substantive task; token cost is not a constraint. Pick from the quality patterns in the tool description (adversarial verify, judge panel, loop until dry, completeness critic). Solo only on conversational or trivial turns.'

const FULL_WITHOUT_TOOL =
	'Hypermode is on: optimize for the most exhaustive, correct answer, not the fastest or cheapest. The `workflow` tool is not available in this run, so delegate every substantive task to parallel agents with the `Agent` tool and have their findings verified; token cost is not a constraint. Solo only on conversational or trivial turns.'

const SPARSE_WITH_TOOL = 'Hypermode is still on: use the `workflow` tool for substantive work.'

const SPARSE_WITHOUT_TOOL =
	'Hypermode is still on: delegate substantive work to parallel agents with the `Agent` tool.'

const EXIT = "Hypermode is off: the `workflow` tool's standard opt-in rule applies again."

/**
 * What the model is told about the standing mode, turn by turn. One per
 * session. `next` is called once per sent message and returns the text to put
 * in that message's request-only context, or `undefined` when nothing is due:
 *
 * - on, and the last thing said was not "on": the full text;
 * - on, said, and {@link HYPERMODE_REMINDER_EVERY} messages have passed: the sparse text;
 * - off, and the last thing said was "on": the exit text, once.
 *
 * Call it exactly once per sent message (`send()`), never per model turn
 * inside it. A fresh session (or a resumed one) has said nothing yet, so the
 * mode being on means the full text; a resumed session hears it in full once.
 */
export class HypermodeReminders {
	private said: 'on' | 'off' | 'nothing' = 'nothing'
	private sinceSaid = 0

	next(on: boolean, toolListed: boolean): string | undefined {
		if (on) {
			if (this.said !== 'on') {
				this.said = 'on'
				this.sinceSaid = 0
				return toolListed ? FULL_WITH_TOOL : FULL_WITHOUT_TOOL
			}
			this.sinceSaid += 1
			if (this.sinceSaid >= HYPERMODE_REMINDER_EVERY) {
				this.sinceSaid = 0
				return toolListed ? SPARSE_WITH_TOOL : SPARSE_WITHOUT_TOOL
			}
			return undefined
		}
		if (this.said === 'on') {
			this.said = 'off'
			this.sinceSaid = 0
			return EXIT
		}
		this.said = 'off'
		return undefined
	}
}
