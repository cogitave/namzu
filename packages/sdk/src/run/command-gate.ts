/**
 * A {@link ReviewAnswer} that runs shell commands and hands the failure back.
 *
 * `reviewAnswer` was the seam for exactly this — judge the answer at the point
 * the model stops calling tools, and return it with feedback instead of
 * settling — and nothing shipped supplied one, so an operator who wanted
 * "don't finish until the build passes" had to write TypeScript. This is the
 * supplier. With it, `--gate 'pnpm test'` is the whole unattended story: the
 * model works, stops, the tests run, and a failure comes back as the next user
 * turn rather than as a green run somebody discovers in CI.
 *
 * The kernel already bounds it. The reviewer is consulted only when the model
 * stopped calling tools, never on the forced-final turn, and a rejection
 * budget stops the run with `answer_rejected` — a stop reason that names the
 * reviewer rather than blaming a token budget. None of that is re-implemented
 * here.
 *
 * ## The part that is not just "run a command"
 *
 * **Before re-running a command that already failed, the workspace is
 * fingerprinted, and an identical fingerprint means the command is NOT run.**
 *
 * This is the difference between a bounded loop and one that spends its whole
 * budget. A model that has run out of ideas answers again without editing
 * anything; re-running the suite then costs a full execution — often the most
 * expensive thing in the loop — to produce a failure already known character
 * for character. Worse, the feedback is identical, so the model is handed the
 * same prompt that just failed to help it. Saying instead "the workspace has
 * not changed since that failure; edit something before trying to finish"
 * is both cheaper and a different instruction.
 *
 * The attempt still advances. Skipping the command is a saving, not a pardon:
 * an answer that changed nothing has been rejected, and the run's budget must
 * see that or a stuck model loops forever for free.
 *
 * And it fails open on the cheap side. No fingerprint — a git invocation that
 * errored, a timeout, output past the cap, a tree with no commits — means the
 * command runs. See {@link fingerprintWorkspace}: the cost of re-running
 * unnecessarily is one execution; the cost of wrongly skipping is a
 * verification that silently did not happen.
 */

import { LocalExecutionContext } from '../execution/local.js'
import type { CommandOptions, CommandResult } from '../types/execution/index.js'
import type { AnswerReview, ReviewAnswer } from '../types/run/answer-review.js'
import { fingerprintWorkspace } from './workspace-fingerprint.js'

/** How the gate runs a command. Injected so a test needs no shell. */
export type GateExec = (
	command: string,
	args: string[],
	options?: CommandOptions,
) => Promise<CommandResult>

/** Default per-command deadline. A test suite is allowed to be slow. */
export const DEFAULT_GATE_TIMEOUT_MS = 600_000

/** How many attempts the gate will EXECUTE its commands for, by default. */
export const DEFAULT_GATE_MAX_RETRIES = 3

/**
 * Model-visible characters of a failing command's output.
 *
 * Head and tail, not head alone: a compiler names the file at the top and a
 * test runner names the failure at the bottom, and a gate that only ever kept
 * one end would be useless for one of them.
 */
export const DEFAULT_GATE_OUTPUT_CHARS = 4_000

export interface CommandGateOptions {
	/**
	 * Shell command lines, run in order, stopping at the first failure.
	 *
	 * In order and short-circuiting because that is what a person means by
	 * "typecheck then test": a type error makes the test output noise about
	 * the same cause, and handing the model both invites it to fix the
	 * symptom.
	 */
	readonly commands: readonly string[]
	/** Directory the commands run in, and the tree that is fingerprinted. */
	readonly cwd: string
	/**
	 * How many attempts will actually EXECUTE the commands.
	 *
	 * Past it the gate rejects without running anything, naming the
	 * exhaustion. It does not accept: an answer that never passed the gate
	 * has not passed the gate, and a reviewer that gave up by accepting would
	 * hand back a green run over a red build — the exact outcome the gate
	 * exists to prevent. What ENDS the run is the kernel's rejection budget,
	 * so set that to the same number (the CLI does).
	 */
	readonly maxRetries?: number
	/** Per-command deadline. See {@link DEFAULT_GATE_TIMEOUT_MS}. */
	readonly timeoutMs?: number
	/** Override the executor. Defaults to a local shell in `cwd`. */
	readonly exec?: GateExec
	/** See {@link DEFAULT_GATE_OUTPUT_CHARS}. */
	readonly maxOutputChars?: number
	/**
	 * Override the change detector. Defaults to
	 * {@link fingerprintWorkspace} over `cwd`.
	 *
	 * Returning `null` means "cannot tell", and the gate then runs its
	 * commands. A detector that returned a constant would silence the gate
	 * after its first failure, so this seam exists for tests and for a host
	 * whose workspace is not a git tree — not as a way to turn the check off.
	 */
	readonly fingerprint?: () => Promise<string | null>
}

/** Head and tail of a command's output, with the middle marked as dropped. */
export function clipOutput(text: string, max: number): string {
	const trimmed = text.trimEnd()
	if (trimmed.length <= max) return trimmed
	const half = Math.floor(max / 2)
	const dropped = trimmed.length - half * 2
	return `${trimmed.slice(0, half)}\n… ${dropped} characters omitted …\n${trimmed.slice(-half)}`
}

interface LastFailure {
	readonly command: string
	/** The tree as it stood when this failed. `null` = could not be taken. */
	readonly fingerprint: string | null
}

function failureFeedback(
	command: string,
	attempt: number,
	result: CommandResult,
	maxOutputChars: number,
): string {
	const output = clipOutput(`${result.stdout}\n${result.stderr}`, maxOutputChars)
	const truncatedStreams = [
		result.stdoutTruncated === true ? 'stdout' : undefined,
		result.stderrTruncated === true ? 'stderr' : undefined,
	].filter((stream): stream is string => stream !== undefined)
	const truncationWarning =
		truncatedStreams.length === 0
			? []
			: [
					'',
					`Retained output is incomplete: ${truncatedStreams.join(' and ')} ${truncatedStreams.length === 1 ? 'was' : 'were'} truncated by the execution context. Re-run with a narrower command or filter to recover the missing diagnostics.`,
				]
	return [
		`The answer was not accepted: \`${command}\` failed (attempt ${attempt}, exit ${result.exitCode}).`,
		'',
		'Output:',
		'```',
		output || '(no output)',
		'```',
		...truncationWarning,
		'',
		'Fix the cause and then finish. Do not restate the failure back to me; change the code so the command passes.',
	].join('\n')
}

function unchangedFeedback(command: string, attempt: number): string {
	return [
		`The answer was not accepted, and \`${command}\` was NOT re-run (attempt ${attempt}).`,
		'',
		'The workspace is byte-for-byte identical to what it was when that command last failed — no file was created, edited or deleted since. Running it again would produce the failure you have already been shown.',
		'',
		'Edit something before trying to finish again. If you believe the change you described was made, verify it by reading the file: it is not on disk.',
	].join('\n')
}

function exhaustedFeedback(command: string, maxRetries: number): string {
	return [
		`The answer was not accepted: \`${command}\` has failed and this gate has spent its ${maxRetries} attempts.`,
		'',
		'No further command will be run.',
	].join('\n')
}

/**
 * Build a reviewer that accepts an answer only when every command passes.
 *
 * Stateful across calls within one run, deliberately: the whole point is that
 * attempt N+1 can be compared with attempt N. Build one gate per run.
 */
export function createCommandGate(options: CommandGateOptions): ReviewAnswer {
	const { commands, cwd } = options
	const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
	const maxRetries = options.maxRetries ?? DEFAULT_GATE_MAX_RETRIES
	const maxOutputChars = options.maxOutputChars ?? DEFAULT_GATE_OUTPUT_CHARS

	// Built once and reused: constructing a context per attempt would re-stat
	// the directory for no gain, and the context holds nothing per-run.
	const context = new LocalExecutionContext({ id: 'namzu-command-gate', cwd })
	const exec: GateExec =
		options.exec ?? ((command, args, opts) => context.executeCommand(command, args, opts))
	const fingerprint =
		options.fingerprint ?? (() => fingerprintWorkspace({ cwd, exec, timeoutMs: 20_000 }))

	let attempt = 0
	let last: LastFailure | undefined
	let executions = 0

	return async (): Promise<AnswerReview> => {
		attempt += 1

		// A gate that already failed, over a tree nothing has touched since.
		// The command is skipped, and the attempt still counts.
		//
		// The comparison is a bare `===` rather than `now !== null && now ===
		// …`. The guard above already establishes that the recorded
		// fingerprint is non-null, so a `null` from this call cannot match it,
		// and the extra clause was a branch nothing could reach — a mutation
		// that deleted it killed no test, which is what a dead condition looks
		// like from the outside.
		if (last && last.fingerprint !== null) {
			const now = await fingerprint()
			if (now === last.fingerprint) {
				return { accept: false, feedback: unchangedFeedback(last.command, attempt) }
			}
		}

		if (last && executions >= maxRetries) {
			return { accept: false, feedback: exhaustedFeedback(last.command, maxRetries) }
		}

		executions += 1
		for (const command of commands) {
			// `shell: true` because the operator handed over a command LINE —
			// `pnpm test -- --run`, with its flags and its quoting — and taking
			// that as an executable name plus literal arguments would fail on
			// every gate anyone would actually write. Explicit, per the note on
			// `LocalExecutionContext.executeCommand`: shell interpretation is
			// opt-in, and this is the opt-in.
			const result = await exec(command, [], { cwd, timeoutMs, shell: true })
			if (result.exitCode === 0) continue

			// Taken AFTER the failure, not before the run: the comparison next
			// time is against the tree this verdict was formed over. A snapshot
			// from before the command would miss anything the command itself
			// wrote — a formatter, a snapshot updater, a lockfile.
			last = { command, fingerprint: await fingerprint() }
			return { accept: false, feedback: failureFeedback(command, attempt, result, maxOutputChars) }
		}

		// Cleared, so a later rejection by a DIFFERENT command is not compared
		// against a tree this one failed over.
		last = undefined
		return { accept: true }
	}
}
