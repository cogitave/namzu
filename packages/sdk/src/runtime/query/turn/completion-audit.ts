/**
 * The completion audit: before a turn that edited files is allowed to end,
 * check from the turn's own record whether anything was run to check the
 * edits. It judges what happened, not what the model says happened.
 *
 * It blocks at most once per turn. After the one reminder the turn may end
 * however it likes, so the audit can never trap a run.
 *
 * The one reminder has four wordings. The original says nothing was run; when
 * the turn's outcome record says more, the reminder says exactly that: a check
 * ran with its exit status hidden, a check passed and files then changed, or a
 * check failed. Which wording is used never changes how often the audit fires.
 */

import type { TurnOutcome } from '../../../types/session/outcome.js'

/** Tools that write to the project regardless of their input. */
export const WRITING_TOOLS: ReadonlySet<string> = new Set([
	'edit',
	'write',
	'apply_patch',
	'notebook_edit',
])

/**
 * A command that checks work: a project runner invoked with a test, lint,
 * typecheck, format-check or build target, or a checker invoked directly.
 */
const RUNNER =
	/\b(?:npm|pnpm|yarn|bun|npx|make|cargo|go|dotnet|gradle|gradlew|mvn|deno|just|task|uv|poetry|tox|nox|rake|bundle)\b[^|;&\n]*\b(?:test|tests|lint|check|typecheck|type-check|verify|build|vet|clippy|fmt)\b/i
const DIRECT =
	/(?:^|[\s;&|(])(?:vitest|jest|pytest|mocha|tsc|eslint|biome|prettier|ruff|mypy|pyright|flake8|golangci-lint|rubocop|phpunit|node\s+--test)(?=$|[\s;&|)])/i

/** Whether a shell command is one that checks work. */
export function isVerificationCommand(command: string): boolean {
	return RUNNER.test(command) || DIRECT.test(command)
}

/** Said to the model once, when it tries to end a turn that changed files and checked nothing. */
export const COMPLETION_AUDIT_MESSAGE =
	"Files were changed in this turn and nothing was run afterwards to check them. Before you finish: rerun the reproduction of the defect, if there was one; run the project's tests and its lint or format check; confirm the diff holds only what was asked; name any throwaway file you made. Then give your answer, stating what you ran and what you did not run. If a check cannot be run here, say which and why."

/** The longest command a reminder repeats back, in characters. */
export const COMPLETION_AUDIT_MAX_COMMAND_CHARS = 120

/** The command as a reminder may show it: one line, printable, backticks dropped, at most 120 characters. */
export function auditCommandText(command: string): string {
	let plain = ''
	for (const ch of command) {
		const code = ch.charCodeAt(0)
		plain += code < 0x20 || code === 0x7f || ch === '`' ? ' ' : ch
	}
	const flat = plain.replace(/\s+/g, ' ').trim()
	if (flat.length <= COMPLETION_AUDIT_MAX_COMMAND_CHARS) return flat
	return `${flat.slice(0, COMPLETION_AUDIT_MAX_COMMAND_CHARS - 3)}...`
}

const AUDIT_TAIL =
	'Then give your answer, stating what you ran and what you did not run. If a check cannot be run here, say which and why.'

/** The reminder for a check that ran with its exit status hidden (a pipe, `;`, `||`, a trailing `&`). */
export function maskedCheckMessage(command: string): string {
	return `Files were changed in this turn, and the only check run, \`${auditCommandText(command)}\`, had its exit status hidden, so it cannot be told whether it passed. Run it again on its own, without the pipe or anything else attached to it; its output is already trimmed to the head and tail. ${AUDIT_TAIL}`
}

/** The reminder for a check that passed before files changed again. */
export function staleCheckMessage(command: string | undefined): string {
	const named = command === undefined ? 'A check' : `\`${auditCommandText(command)}\``
	return `${named} passed in this turn, but files were changed after it, so it says nothing about the files as they are now. Run the checks again. ${AUDIT_TAIL}`
}

/** The reminder for a check whose latest run failed. */
export function failingCheckMessage(command: string | undefined): string {
	const named = command === undefined ? 'A check' : `\`${auditCommandText(command)}\``
	return `${named} failed in this turn and has not passed since. Fix what it reports, or say why it cannot pass, and run it again. ${AUDIT_TAIL}`
}

/** A finished tool call as the audit sees it. */
export interface AuditedCall {
	readonly toolName: string
	/** The call's parsed input, when it had one. */
	readonly input?: unknown
	readonly isError?: boolean
}

export class CompletionAudit {
	private edited = false
	private checkedSinceEdit = false
	private blocked = false

	/** Feed the calls of one finished step, in order. */
	observe(calls: readonly AuditedCall[]): void {
		for (const call of calls) {
			if (call.isError) continue
			if (WRITING_TOOLS.has(call.toolName)) {
				this.edited = true
				this.checkedSinceEdit = false
				continue
			}
			if (call.toolName === 'bash' && this.edited) {
				const command = (call.input as { command?: unknown } | undefined)?.command
				if (typeof command === 'string' && isVerificationCommand(command)) {
					this.checkedSinceEdit = true
				}
			}
		}
	}

	/**
	 * The reminder to give, or `undefined` when the turn may end. At most one per
	 * turn across every wording: asking records the block. Nothing is said for a
	 * turn that changed no file through a write tool. `outcome` is read only
	 * when the audit has something to say.
	 */
	takeReminder(outcome?: () => TurnOutcome | undefined): string | undefined {
		if (this.blocked || !this.edited) return undefined
		const record = outcome?.()
		let message: string | undefined
		const failed = record?.checks.find((check) => check.result === 'failed')
		const masked = record?.checks.find((check) => check.result === 'masked')
		if (record?.verdict === 'failing' && failed) message = failingCheckMessage(failed.command)
		else if (record?.verdict === 'stale') {
			message = staleCheckMessage(
				[...record.checks].reverse().find((c) => c.result === 'passed')?.command,
			)
		} else if (record?.verdict === 'inconclusive' && masked) {
			message = maskedCheckMessage(masked.command)
		} else if (!this.checkedSinceEdit) message = COMPLETION_AUDIT_MESSAGE
		if (message === undefined) return undefined
		this.blocked = true
		return message
	}

	/**
	 * Whether the turn must be held back from ending. True at most once: asking
	 * records the block.
	 */
	takeBlock(): boolean {
		if (this.blocked || !this.edited || this.checkedSinceEdit) return false
		this.blocked = true
		return true
	}
}
