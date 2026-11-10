import type { TurnOutcome, TurnOutcomeCheck } from '../../types/session/outcome.js'
import { KERNEL_RECORD_PREFIX } from '../untrusted-envelope.js'

/**
 * The kernel's own sentence about what a delegated run did, for the parent
 * that delegated it.
 *
 * It states the record, not the child's account of itself, and it sits outside
 * the marked block that holds the child's words: the parent reads it as a fact
 * of the kernel's, the way it reads the task id. What it can say is exactly
 * what the record can say. `checked` means a recognised check passed and the
 * workspace did not change after it; it does not mean the check covers the
 * change.
 *
 * The command is the child's own text, so it is shown as plain data: one line
 * of printable ASCII with no quotes or backticks, cut short. A command that
 * does not survive that is named as "a command" instead.
 */
export function describeOutcomeRecord(outcome: TurnOutcome): string | undefined {
	const body = describe(outcome)
	return body === undefined ? undefined : `${KERNEL_RECORD_PREFIX}${body}`
}

const SHOWN_COMMAND_CHARS = 60

/** A command as data inside backticks, or `undefined` when it cannot be shown without being rewritten. */
export function showCommand(command: string): string | undefined {
	const trimmed = command.trim()
	if (trimmed === '' || trimmed.length > SHOWN_COMMAND_CHARS) return undefined
	// Printable ASCII, and none of the characters that open a quotation or a
	// substitution in whatever reads this next.
	if (!/^[\x20-\x7e]+$/.test(trimmed) || /[`'"$\\#]/.test(trimmed)) return undefined
	return `\`${trimmed}\``
}

function named(check: TurnOutcomeCheck): string {
	return showCommand(check.command) ?? 'a command'
}

function changedPhrase(outcome: TurnOutcome): string | undefined {
	const { total, outsideKnownTools } = outcome.changes
	if (total > 0) return total === 1 ? '1 file changed' : `${total} files changed`
	if (outsideKnownTools) return 'files changed, by something other than the edit tools'
	return undefined
}

function describe(outcome: TurnOutcome): string | undefined {
	const changed = changedPhrase(outcome)
	const failed = outcome.checks.filter((check) => check.result === 'failed')
	const lead = changed === undefined ? '' : `${changed}; `

	switch (outcome.verdict) {
		case 'unchanged':
			return outcome.basis === 'workspace'
				? 'nothing in the workspace changed.'
				: 'no file was changed by an edit tool. Shell commands are not recorded.'
		case 'unchecked':
			return `${lead}nothing was run to check ${total(outcome) === 1 ? 'it' : 'them'}.`
		case 'failing': {
			const first = failed[0]
			if (first === undefined) return undefined
			const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''
			return `${lead}${named(first)} failed${more}.`
		}
		case 'checked': {
			const passed = [...outcome.checks].reverse().find((c) => c.result === 'passed' && c.fresh)
			return `${lead}${passed ? named(passed) : 'a check'} passed and nothing changed after it.`
		}
		case 'stale': {
			const passed = [...outcome.checks].reverse().find((c) => c.result === 'passed')
			return `${lead}${passed ? named(passed) : 'a check'} passed, then files changed again.`
		}
		case 'inconclusive': {
			const masked = outcome.checks.find((c) => c.result === 'masked')
			if (masked) {
				const how = /(?<!\|)\|(?!\|)/.test(masked.command) ? 'the pipe' : 'the command line'
				return `${lead}${named(masked)} ran, but ${how} hides whether it passed.`
			}
			const unsettled = outcome.checks.find((c) => c.result === 'unsettled')
			if (unsettled) return `${lead}${named(unsettled)} ran, but its result was not seen.`
			const passed = outcome.checks.find((c) => c.result === 'passed')
			return `${lead}${passed ? named(passed) : 'a check'} passed, but it cannot be told whether files changed after it.`
		}
	}
}

function total(outcome: TurnOutcome): number {
	return outcome.changes.total
}
