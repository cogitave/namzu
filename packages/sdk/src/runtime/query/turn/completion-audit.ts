/**
 * The completion audit: before a turn that edited files is allowed to end,
 * check from the turn's own record whether anything was run to check the
 * edits. It judges what happened, not what the model says happened.
 *
 * It blocks at most once per turn. After the one reminder the turn may end
 * however it likes, so the audit can never trap a run.
 */

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
	 * Whether the turn must be held back from ending. True at most once: asking
	 * records the block.
	 */
	takeBlock(): boolean {
		if (this.blocked || !this.edited || this.checkedSinceEdit) return false
		this.blocked = true
		return true
	}
}
