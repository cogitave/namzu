import type { ReasoningEffort, ThinkingConfig } from '../types/provider/index.js'

/**
 * Refuse a thinking request a driver does not implement.
 *
 * The failure this prevents is silence. `thinking` sits on
 * `ChatCompletionParams`, so every driver accepts it; a driver that does not
 * implement it drops the field and returns an ordinary completion with an
 * empty `reasoning` array. The caller cannot tell that apart from a model that
 * simply chose not to reason — the request looks honoured and the answer looks
 * like an answer.
 *
 * Refusing names the driver instead, which is the difference between a bug
 * report about the model and a one-line configuration fix.
 *
 * **Turning thinking OFF is honoured as a no-op**, because that is the state a
 * driver without thinking is already in. A config shared across providers that
 * says `{type: 'disabled'}` should not fail on the ones that were never going
 * to think.
 *
 * This lived as a private copy inside one driver while five others dropped the
 * field silently. It is here so a new driver inherits the rule instead of
 * re-deciding it.
 *
 * @param driverName Named in the error, so the reader knows which provider in
 *   a multi-provider setup refused.
 */
export function assertThinkingUnsupported(
	driverName: string,
	params: { thinking?: ThinkingConfig; effort?: ReasoningEffort },
): void {
	// `effort` is refused on exactly the same reasoning, and it is the worse
	// silence of the two. A dropped `thinking` at least leaves an empty
	// reasoning list a caller could notice; a dropped `effort` leaves a
	// perfectly ordinary answer, so a run someone believes they paid for at
	// `max` is indistinguishable from one at the model's default — including
	// on the bill.
	//
	// Checked before thinking because it is the cheaper mistake to make: a
	// caller reaching for effort on a driver without it has usually pointed a
	// working config at a new provider, and naming the field they set beats
	// naming the neighbouring one.
	if (params.effort !== undefined) {
		throw new Error(
			`${driverName} does not implement effort. Silently ignoring it would return an ordinary completion, so a run requested at "${params.effort}" would be indistinguishable from one at the model's default — including in what it cost. Drop \`effort\`, or use a driver that implements it.`,
		)
	}

	const type = params.thinking?.type
	if (type !== 'enabled' && type !== 'adaptive') return
	throw new Error(
		`${driverName} does not implement thinking. Silently ignoring the request would return an ordinary completion with an empty reasoning list, which reads as "the model did not reason" rather than "this driver cannot ask it to". Drop \`thinking\`, or use a driver that implements it.`,
	)
}
