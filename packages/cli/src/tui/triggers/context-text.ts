/**
 * What namzu tells the model, in its own words, for a trigger the operator
 * armed. Fixed text per trigger: operator text never enters it.
 *
 * It travels as a request-only `context` prompt contribution
 * (`SendOptions.hostContext` in `../agent.ts`): after the history, never in
 * it, and never in the system prompt, which is the cached prefix. The
 * operator's message itself reaches the model and the session log unchanged.
 */

import type { ReasoningEffort } from '@namzu/sdk'

import { hypermodeEffort } from '../hypermode.js'
import type { ContextTextId, TriggerId } from './registry.js'
import { triggerDefinition } from './registry.js'

const TEXTS: Readonly<Record<ContextTextId, string>> = {
	hypermode:
		'The operator asked for hypermode for THIS turn only: their message named it, and it is not on for the session. For this turn, treat delegation through `Agent` as the default for substantive work, not the exception: split the work into independent pieces — lookups, drafts, checks — and delegate them. Agents in the same phase are launched in the same response, each with `run_in_background: true` when you mean to wait for them together; a phase is never started one agent at a time. This changes only how you structure this turn; every tool call is reviewed exactly as usual.',
	'save-skill':
		"The operator asked namzu to save this work as a skill after this turn. namzu runs /skills save itself once the turn ends, and that ends on the operator's own confirmation screen. Finish the task; do not call save_skill in this turn.",
	schedule:
		'The operator asked for this to run on a schedule. When the task is clear, propose a job with the `schedule` tool; the operator confirms it on screen. Do not create a `session_loop`; if a repeat inside this open session fits better, tell the operator to use /loop.',
}

/** The context texts for the armed triggers of one turn, in a fixed order. */
export function triggerContextTexts(ids: readonly TriggerId[]): string[] {
	const texts: string[] = []
	for (const id of ids) {
		const effect = triggerDefinition(id).effect
		if (effect.kind === 'turn-context' || effect.kind === 'after-turn') {
			const text = TEXTS[effect.text]
			if (!texts.includes(text)) texts.push(text)
		}
	}
	return texts
}

/**
 * The effort the armed triggers pin for their turn, on a model that
 * publishes `levels`: the highest level for max effort, else the level
 * hypermode pins (`xhigh`, or the nearest below it). `undefined` when none
 * pins one, or the model publishes no menu.
 */
export function triggerEffort(
	ids: readonly TriggerId[],
	levels: readonly ReasoningEffort[] | undefined,
): ReasoningEffort | undefined {
	const kinds = ids.map((id) => triggerDefinition(id).effect)
	if (kinds.some((effect) => effect.kind === 'turn-effort'))
		return levels && levels.length > 0 ? levels[levels.length - 1] : undefined
	if (kinds.some((effect) => effect.kind === 'turn-context' && effect.effort === 'hypermode'))
		return hypermodeEffort(levels)
	return undefined
}
