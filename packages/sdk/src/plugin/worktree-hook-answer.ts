/**
 * What a hook on `worktree_create` or `worktree_remove` answered.
 *
 * These two events are not like the others: a hook does not advise the kernel,
 * it does the work. So the answer is read strictly and never falls back to the
 * outcome the person was trying to replace:
 *
 * - `worktree_create` needs a path. It is `hookSpecificOutput.worktreePath` of
 *   a JSON answer, or else the last non-empty line the hook printed. Anything
 *   else (no path, a failed hook, a refusal, output cut short) is an `error`
 *   answer carrying a sentence that names the hook and what it printed.
 * - `worktree_remove` needs the hook to finish cleanly. A failure is an `error`
 *   answer carrying the start and the end of what it printed.
 *
 * The host reads `error` as "do not create / do not remove behind the person's
 * back"; see `HookedWorkspaceDriver`.
 */

import type { PluginHookResult } from '../types/plugin/index.js'
import type { ShellHookOutcome } from './shell-hook.js'

/** The most characters of a hook's output shown at each end. */
export const WORKTREE_HOOK_SHOWN_CHARS = 300

/** The start and the end of what a hook printed, with the middle elided when it is long. */
export function worktreeHookPrinted(outcome: Pick<ShellHookOutcome, 'stdout' | 'stderr'>): string {
	const parts: string[] = []
	for (const [label, raw] of [
		['stdout', outcome.stdout],
		['stderr', outcome.stderr],
	] as const) {
		const text = raw.trim()
		if (text === '') continue
		const shown =
			text.length <= WORKTREE_HOOK_SHOWN_CHARS * 2
				? text
				: `${text.slice(0, WORKTREE_HOOK_SHOWN_CHARS)} … ${text.slice(-WORKTREE_HOOK_SHOWN_CHARS)}`
		parts.push(`${label}: ${shown}`)
	}
	return parts.length === 0 ? 'it printed nothing' : `it printed ${parts.join('; ')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The JSON object a hook printed, when its whole output is one. */
function jsonOf(stdout: string): Record<string, unknown> | undefined {
	const text = stdout.trim()
	if (!text.startsWith('{')) return undefined
	try {
		const parsed: unknown = JSON.parse(text)
		return isRecord(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/** A refusal written in JSON, as the other events read it: `continue: false` or `decision: "block"`. */
function refusalIn(json: Record<string, unknown>): string | undefined {
	const reason = (value: unknown, fallback: string): string =>
		typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
	if (json.continue === false) return reason(json.stopReason, 'it answered continue: false')
	if (json.decision === 'block') return reason(json.reason, 'it answered decision: block')
	return undefined
}

function failureOf(
	event: 'worktree_create' | 'worktree_remove',
	label: string,
	outcome: ShellHookOutcome,
): string | undefined {
	const what = event === 'worktree_create' ? 'create' : 'remove'
	if (outcome.spawnError !== undefined) {
		return `The ${event} hook \`${label}\` could not start (${outcome.spawnError}), so the worktree was not ${what === 'create' ? 'created' : 'removed'}.`
	}
	if (outcome.timedOut) {
		return `The ${event} hook \`${label}\` timed out, so the worktree was not ${what === 'create' ? 'created' : 'removed'}; ${worktreeHookPrinted(outcome)}.`
	}
	if (outcome.exitCode !== 0) {
		return `The ${event} hook \`${label}\` failed (exit ${outcome.exitCode ?? 'by signal'}), so the worktree was not ${what === 'create' ? 'created' : 'removed'}; ${worktreeHookPrinted(outcome)}.`
	}
	return undefined
}

/** The answer of one hook run on `worktree_create` or `worktree_remove`. */
export function worktreeHookVerdict(
	event: 'worktree_create' | 'worktree_remove',
	label: string,
	outcome: ShellHookOutcome,
): PluginHookResult {
	const failed = failureOf(event, label, outcome)
	if (failed !== undefined) return { action: 'error', message: failed }

	const json = jsonOf(outcome.stdout)
	if (json !== undefined) {
		const refused = refusalIn(json)
		if (refused !== undefined) {
			return {
				action: 'error',
				message: `The ${event} hook \`${label}\` refused: ${refused}.`,
			}
		}
	}
	if (event === 'worktree_remove') return { action: 'continue' }

	// worktree_create: a path is the answer.
	if (outcome.stdoutTruncated === true) {
		return {
			action: 'error',
			message: `The ${event} hook \`${label}\` printed more than is kept, so its last line cannot be trusted as the path; ${worktreeHookPrinted(outcome)}. Send progress to stderr and print only the path, or answer JSON with hookSpecificOutput.worktreePath.`,
		}
	}
	let path: string | undefined
	if (json !== undefined) {
		const specific = json.hookSpecificOutput
		const given = isRecord(specific) ? specific.worktreePath : undefined
		if (typeof given === 'string' && given.trim() !== '') path = given.trim()
		else if (given !== undefined) {
			return {
				action: 'error',
				message: `The ${event} hook \`${label}\` answered hookSpecificOutput.worktreePath that is not a path (a string); ${worktreeHookPrinted(outcome)}.`,
			}
		} else if (json.worktreePath !== undefined) {
			return {
				action: 'error',
				message: `The ${event} hook \`${label}\` wrote worktreePath at the top level of its answer; it is read under hookSpecificOutput. ${worktreeHookPrinted(outcome)}.`,
			}
		}
	} else {
		const lines = outcome.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
		const last = lines[lines.length - 1]
		if (last !== undefined) path = last.trim()
	}
	if (path === undefined) {
		return {
			action: 'error',
			message: `The ${event} hook \`${label}\` gave no worktree path, so none was created; ${worktreeHookPrinted(outcome)}. Print the folder it made as its last line, or answer JSON with hookSpecificOutput.worktreePath.`,
		}
	}
	return { action: 'continue', worktreePath: path }
}
