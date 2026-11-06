/**
 * The fourth decision point: which control on the screen does this describe?
 *
 * The computer tool lets a model act on a control by ref. Choosing the ref takes a model
 * round trip over a tree of controls; a small decision model can do the choosing in a few
 * hundred milliseconds. With the point `shadow`, the model the person is talking to still
 * chooses, and the decision model is asked beside it (what the model said the action is for,
 * and the controls of that window) so the log can say how often the two agree. With the point
 * `on`, the tool also lets the model name a control in words (`ui_do`) and the decision model
 * chooses, acting only when it is sure and clearly ahead of the next control.
 *
 * What is sent: the model's few words of intent, and the controls the model could act on
 * (their roles, names and refs, cut). They are the application's own text, so this point is
 * off until it is named in `decision.points`. Nothing else leaves the machine: no screenshot,
 * no values typed, no window contents beyond those control names.
 */

import type { ComputerUseAdvisor, ComputerUseAdvisorRequest } from '@namzu/sdk'
import type { DecisionPoints } from './points.js'

export const PICK_INSTRUCTIONS =
	'Choose the one control that the described action should be done on. ' +
	'The options are the controls of one window, each with its reference, its kind and its name. ' +
	'Prefer a control whose name matches what is described over one that merely sits near it.'

/** Control characters other than newline and tab are dropped before the text leaves the machine. */
function printable(text: string): string {
	let out = ''
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0
		if (code < 0x20 || code === 0x7f) continue
		out += ch
	}
	return out
}

/** The text one control is put to the model as: unique because the ref is. */
function optionText(ref: string, description: string): string {
	return `${ref} ${printable(description).trim()}`.slice(0, 120)
}

/**
 * The computer tool's advisor for this point, or undefined when the point is off, so a tool
 * built with it is exactly the tool without one.
 */
export function createPickAdvisor(points: DecisionPoints): ComputerUseAdvisor | undefined {
	const mode = points.mode('pick')
	if (mode === 'off') return undefined
	return {
		acts: mode === 'on',
		async pick(request: ComputerUseAdvisorRequest, signal?: AbortSignal) {
			const byOption = new Map<string, string>()
			for (const candidate of request.candidates)
				byOption.set(optionText(candidate.ref, candidate.description), candidate.ref)
			// Two controls that read the same after the cut would be one option: the ref keeps them apart,
			// and a clash that remains makes the question unsafe to ask.
			if (byOption.size !== request.candidates.length || byOption.size < 2) return undefined
			const chosen =
				request.chosen === undefined
					? undefined
					: request.candidates.find((candidate) => candidate.ref === request.chosen)
			const ranking = await points.choose(
				{
					point: 'pick',
					state: `Described action: ${printable(request.intent).trim().slice(0, 200)}`,
					instructions: PICK_INSTRUCTIONS,
					options: [...byOption.keys()],
					...(chosen ? { chosen: optionText(chosen.ref, chosen.description) } : {}),
				},
				signal,
			)
			if (!ranking) return undefined
			return {
				ranked: ranking.ranked.flatMap((entry) => {
					const ref = byOption.get(entry.option)
					return ref === undefined ? [] : [{ ref, confidence: entry.p }]
				}),
			}
		},
	}
}
