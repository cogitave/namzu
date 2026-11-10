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

	const lead =
		changes.total > 0
			? `Changed ${changes.total} ${changes.total === 1 ? 'file' : 'files'}`
			: changes.outsideKnownTools
				? 'Changed files outside the edit tools'
				: 'No files changed'

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
