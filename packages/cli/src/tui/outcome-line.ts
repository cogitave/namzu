import type { TurnOutcome, TurnOutcomeCheck } from '@namzu/sdk'

/**
 * The one quiet line a turn ends with when it changed something or a check
 * failed: what changed, and what the kernel's record says about checking it.
 * Plain words, nothing when the turn changed nothing and no check failed.
 *
 * The record is the kernel's, not the model's. The line says what a recognised
 * check established and no more: `checked` is a check that passed with nothing
 * changed after it, not a claim that the check covers the change.
 */
export function outcomeLine(outcome: TurnOutcome | undefined): string | undefined {
	if (outcome === undefined) return undefined
	const { verdict, changes, checks } = outcome
	if (verdict === 'unchanged') return undefined
	if (verdict === 'unknown') return 'A command ran that may have changed files · cannot tell'

	// A failing check is reported whether or not anything changed; the other
	// verdicts only exist because something did.
	const lead =
		changes.total > 0
			? `Changed ${changes.total} ${changes.total === 1 ? 'file' : 'files'}`
			: changes.outsideKnownTools
				? 'Changed files outside the edit tools'
				: verdict === 'failing'
					? 'No files changed'
					: 'Changed files'

	const ran = (check: TurnOutcomeCheck | undefined): string =>
		check === undefined ? 'a check' : shown(check.command)

	switch (verdict) {
		case 'unchecked':
			return `${lead} · not checked`
		case 'failing': {
			const failed = checks.filter((check) => check.result === 'failed')
			const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''
			return `${lead} · ${ran(failed[0])} failed${more}`
		}
		case 'checked': {
			const passed = [...checks].reverse().find((c) => c.result === 'passed' && c.fresh === true)
			return `${lead} · checked: ${ran(passed)} passed, nothing changed since`
		}
		case 'stale': {
			const passed = [...checks].reverse().find((c) => c.result === 'passed')
			return `${lead} · ${ran(passed)} passed, then files changed again`
		}
		case 'inconclusive': {
			const masked = checks.find((c) => c.result === 'masked')
			if (masked) {
				const how = /(?<!\|)\|(?!\|)/.test(masked.command) ? 'the pipe' : 'the command line'
				return `${lead} · ran ${ran(masked)}, but ${how} hides whether it passed`
			}
			const unsettled = checks.find((c) => c.result === 'unsettled')
			if (unsettled) return `${lead} · ran ${ran(unsettled)}, but its result was not seen`
			const passed = checks.find((c) => c.result === 'passed')
			return `${lead} · ${ran(passed)} passed, but it is not known whether files changed after it`
		}
	}
}

/**
 * Why no detector could answer, when the program knows. `copy`: the turn's
 * tools work in a sandbox's own copy of the folder, so the folder is not the
 * one they change. Whether the folder is not a repository, or git did not
 * answer in time, is not told apart by the record, so neither is named.
 */
export type CannotTellReason = 'copy'

/** What the terminal has already said about this conversation's outcomes. */
export interface OutcomeTelling {
	/** The `cannot tell` verdict was already drawn in this conversation. */
	readonly toldCannotTell: boolean
}

export const NOTHING_TOLD: OutcomeTelling = { toldCannotTell: false }

/**
 * The line the terminal draws under a turn, and what it has now told.
 *
 * `cannot tell` is a standing condition of the folder, not something this turn
 * did, so the first turn of a conversation that gets it says it in full, with
 * the reason when it is known and that it will not be said again; later turns
 * with that verdict add nothing. Every other verdict is `outcomeLine`, every
 * time. The kernel's record, `exec` output, the Desktop feed and the delegation
 * line are not touched: they keep `outcomeLine` and the verdict for every turn.
 */
export function outcomeNotice(
	outcome: TurnOutcome | undefined,
	telling: OutcomeTelling,
	reason?: CannotTellReason,
): { readonly line?: string; readonly telling: OutcomeTelling } {
	if (outcome?.verdict !== 'unknown') {
		const line = outcomeLine(outcome)
		return { ...(line ? { line } : {}), telling }
	}
	if (telling.toldCannotTell) return { telling }
	const why = reason === 'copy' ? ' (the tools work in a separate copy of the folder)' : ''
	return {
		line: `A command ran that may have changed files · cannot tell here${why} · not repeated in this conversation`,
		telling: { toldCannotTell: true },
	}
}

const SHOWN_CHARS = 60

/**
 * A command as one short line of text. It came from the model, so control
 * characters (an escape sequence would be run by the terminal) become spaces.
 */
function shown(command: string): string {
	const plain = command
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return plain.length > SHOWN_CHARS ? `${plain.slice(0, SHOWN_CHARS - 1)}…` : plain
}
