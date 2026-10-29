import { rm } from 'node:fs/promises'
import { z } from 'zod'
import { isReadOnlyCommandLine } from '../../authorization/readonly-commands.js'
import { SANDBOX_KILL_GRACE_MS } from '../../constants/sandbox/index.js'
import { DANGEROUS_PATTERNS } from '../../constants/tools/index.js'
import { killTree } from '../../process/kill-tree.js'
import { genericLabel } from '../../registry/tool/presentation.js'
import { cancelCauseOf } from '../../types/session/cancel-cause.js'
import type { ToolFacts } from '../../types/tool/presentation.js'
import { subscribeToAbort } from '../../utils/abort.js'
import { readPositiveIntEnv } from '../../utils/env.js'
import {
	type CommandShell,
	WINDOWS_BASH_GUIDANCE,
	bashToolDialect,
	describeSpawnFailure,
	hostCommandShell,
	isWindowsBash,
	rewriteWindowsNullRedirect,
	sandboxShellSpawn,
	spawnHostShell,
	withoutBashStartup,
} from '../command-shell.js'
import { defineTool } from '../defineTool.js'
import { scrubInheritedEnv, withheldEnvNoticeText } from '../env-scrub.js'
import { createHostOutputDecoder } from '../host-output.js'
import { looksBinary, windowText } from '../text-window.js'
import {
	bashWorkingDirectoryForExecution,
	newCwdFile,
	recordDirectory,
	withCwdCapture,
} from './bash-cwd.js'
import { judgeExit } from './exit-semantics.js'
import { jsonStringEscapes } from './json-string-hint.js'
import { leadingLongSleep, longSleepRefusal } from './sleep-guard.js'

// Namzu owns its own bash timeout knob — `NAMZU_BASH_TIMEOUT_MS` — and
// reads no consumer's env name. A consumer that wants one knob aliases
// its own variable to `NAMZU_BASH_TIMEOUT_MS` at deploy time.
// Two minutes, not an hour. The old default meant a wedged command held
// the turn — and, before per-tool deadlines existed, the whole turn — for
// up to 3600s while ignoring Stop entirely. The model can still ask for
// longer via the tool's own `timeout` argument when it knows a build is
// slow; the point is that the DEFAULT is survivable.
const DEFAULT_BASH_TIMEOUT_MS = readPositiveIntEnv('NAMZU_BASH_TIMEOUT_MS', 2 * 60 * 1000)
const DEFAULT_BASH_MAX_BUFFER_BYTES = readPositiveIntEnv(
	'NAMZU_BASH_MAX_BUFFER_BYTES',
	100 * 1024 * 1024,
)

/**
 * The longest deadline this tool will accept from the model.
 *
 * There are two clocks on a bash call and until now only one of them was
 * declared. This tool enforces `input.timeout` itself; the EXECUTOR enforces
 * a separate per-tool deadline, and with none declared here it fell back to
 * its own generic default — also two minutes. The two agreed by coincidence,
 * so a model that asked for five minutes because it knew the build was slow
 * got two, from a clock it had not been told about, reported as an abandoned
 * tool rather than as a command that ran out of time.
 *
 * So the tool declares a ceiling and the executor is given a deadline above
 * it (see `timeoutMs` on the definition), which makes this the only clock
 * that can fire in practice. A request past the ceiling is CLAMPED to it: the command still runs, and a timeout reports
 * the deadline that was actually applied, so the number the model sees on a
 * timeout is the one that fired.
 */
const MAX_BASH_TIMEOUT_MS = readPositiveIntEnv('NAMZU_BASH_MAX_TIMEOUT_MS', 10 * 60 * 1000)

/**
 * Background work switched off for this process: a command that outruns its
 * timeout is killed, as it was before it could be moved to the background, and
 * `run_in_background` is refused. Read at each call so a host can flip it.
 */
export const DISABLE_BACKGROUND_TASKS_ENV = 'NAMZU_DISABLE_BACKGROUND_TASKS'

export function backgroundTasksDisabled(): boolean {
	const value = process.env[DISABLE_BACKGROUND_TASKS_ENV]?.trim().toLowerCase()
	return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}

/**
 * A command that is only waiting (`sleep 30`, also as the head of a chain)
 * has nothing to keep running when its time is up, so it is still stopped.
 */
function startsWithSleep(command: string): boolean {
	const head = command
		.split(/&&|\|\||;|\||\n/)[0]
		?.trim()
		.split(/\s+/)[0]
	return head === 'sleep'
}

/**
 * What the model is told when a foreground command outran its timeout and was
 * moved to the background instead of being stopped. Exported so the test
 * states the same words.
 */
export function movedToBackgroundMessage(jobId: string, timeoutMs: number): string {
	const seconds = Math.max(1, Math.round(timeoutMs / 1000))
	return `Command did not complete within its ${seconds}s timeout and was moved to the background as job ${jobId}; it was not stopped. You will be told when it ends. Its output so far is above.`
}

/**
 * How long a foreground command runs before it is offered for hand-over to
 * the background. A command that ends sooner is never interrupted by a stray
 * key press, and a host that shows a hint shows it from this moment.
 */
export const FOREGROUND_HANDOFF_AFTER_MS = 2_000

/**
 * What the model is told when the person moved a running foreground command to
 * the background instead of stopping it. Exported so the test states the same
 * words.
 */
export function handedOffMessage(jobId: string, reason: 'user' | 'message' | 'interrupt'): string {
	const why =
		reason === 'user'
			? "at the person's request"
			: reason === 'message'
				? 'so a message from the person could reach you'
				: 'because the person interrupted the turn'
	return `Command was moved to the background as job ${jobId} ${why}; it was not stopped. You will be told when it ends. Its output so far is above.`
}

const inputSchema = z.object({
	command: z
		.string()
		.min(1)
		// Git Bash on Windows: a model that writes `>nul` meant the null device.
		// Rewritten here, before the permission rules read the line and before
		// it runs, so the two see the same text.
		.transform((command) =>
			isWindowsBash(hostCommandShell()) ? rewriteWindowsNullRedirect(command) : command,
		)
		.describe(
			'The bash command to execute. Required, non-empty. Single command per call (use `&&` / `;` chaining for compound commands). Large file content belongs in `write` (see its description), not in a heredoc.',
		),
	timeout: z
		.preprocess(
			(v) => (typeof v === 'string' ? Number(v) : v),
			z
				.number()
				.positive()
				.default(DEFAULT_BASH_TIMEOUT_MS)
				.transform((ms) => Math.min(ms, MAX_BASH_TIMEOUT_MS)),
		)
		.describe(
			`Command timeout in milliseconds. Default: ${DEFAULT_BASH_TIMEOUT_MS}, maximum: ${MAX_BASH_TIMEOUT_MS}. For work that legitimately runs longer than the maximum, set run_in_background and await it with \`wait_for_job\`, rather than holding the turn open. A foreground command still running when the timeout elapses is moved to a background job (and reported as such) instead of being stopped, where the host has background jobs.`,
		),
	run_in_background: z
		.boolean()
		.optional()
		.describe(
			'Start the command as a background job and return its id immediately. For a finite build, await completion with `wait_for_job`. For a persistent server, use `wait_for_job` with output_contains and optional output_stream to observe its literal readiness marker without waiting for exit; verify health separately. Use `job` action "read" for incremental output or after a wait times out. Background a command with this parameter, since `cmd &` is not a registered job: strict execution ownership can retire the allocation when the launcher exits with live descendants. An interactive application may belong to a dedicated computer only when that computer explicitly supports application lifetime; its launch result is not a registered job or proof the application has finished.',
		),
	dangerously_disable_sandbox: z
		.boolean()
		.optional()
		.describe(
			'Run this one command on the host, outside the sandbox. Only meaningful when commands are sandboxed, and only for a command that cannot work inside it (it needs the network, a path the sandbox does not mount, a host tool). The user is asked to approve it every time, whatever else is approved (plan and strict modes refuse it); with nobody to ask it is refused. Never set it to get around a permission refusal, and never with run_in_background.',
		),
})

type BashInput = z.infer<typeof inputSchema>

/**
 * Whether this exact call only reads. A background job, or a command that
 * leaves the sandbox, is never read-only whatever its line says.
 */
function bashInputIsReadOnly(input: BashInput | undefined): boolean {
	// Asked with no input to describe the tool in general (a roster, an export).
	if (typeof input?.command !== 'string') return false
	if (input.run_in_background === true || input.dangerously_disable_sandbox === true) return false
	try {
		return isReadOnlyCommandLine(input.command, hostCommandShell().dialect)
	} catch {
		return false
	}
}

const MAX_SHELL_PROGRESS_CHARS = 160

/** Keep a bounded tail even when a process never writes a newline. */
function appendProgressTail(previous: string, chunk: string, start: number, end: number): string {
	return (previous + chunk.slice(Math.max(start, end - MAX_SHELL_PROGRESS_CHARS), end)).slice(
		-MAX_SHELL_PROGRESS_CHARS,
	)
}

/** Clipping a UTF-16 string must not display half of a surrogate pair. */
function progressLine(value: string): string {
	let line = value.trim()
	const first = line.charCodeAt(0)
	if (first >= 0xdc00 && first <= 0xdfff) line = line.slice(1)
	const last = line.charCodeAt(line.length - 1)
	if (last >= 0xd800 && last <= 0xdbff) line = line.slice(0, -1)
	return line
}

/**
 * One latest line per stream, independent of transport chunk boundaries.
 * Reports stay synchronous: the executor owns coalescing and backpressure.
 * This projection adds neither an output log nor a queue of pending reports.
 */
function shellProgress(report?: (message: string) => void) {
	if (!report) return undefined
	const partial = { stdout: '', stderr: '' }
	let lastMessage = ''
	return ({ stream, data }: { stream: 'stdout' | 'stderr'; data: string }): void => {
		let line = partial[stream]
		let latest = ''
		let start = 0
		// Scan delimiters without allocating an array for arbitrarily chatty output.
		for (const match of data.matchAll(/[\r\n]/g)) {
			line = appendProgressTail(line, data, start, match.index)
			latest = progressLine(line) || latest
			line = ''
			start = match.index + 1
		}
		line = appendProgressTail(line, data, start, data.length)
		partial[stream] = line
		const message = progressLine(line) || latest
		if (!message || message === lastMessage) return
		lastMessage = message
		try {
			report(message)
		} catch {
			// A diagnostic observer cannot break the process output reader.
		}
	}
}

/** A progress callback for {@link execHostShell}: one line, per stream, coalesced. */
export type ExecHostShellProgress = (report: {
	stream: 'stdout' | 'stderr'
	data: string
}) => void

/**
 * Keep the shell's process group until inherited pipes close. Node's exec
 * timeout/AbortSignal kills only the wrapper and closes its pipes immediately,
 * leaving the command and its descendants running after the promise settles.
 *
 * Exported so a host running a command line OUTSIDE a live turn — a
 * scheduled job's own script — gets the exact same spawn, dialect,
 * grace-period kill and capped-output behaviour the `bash` tool gives a
 * model's call, rather than a second, drifting copy of it.
 */
export function execHostShell(
	command: string,
	options: {
		cwd: string
		env: NodeJS.ProcessEnv
		timeout: number
		maxBuffer: number
		/** An interpreter selected and verified by the host for this command. */
		shell?: CommandShell
		signal?: AbortSignal
		onOutput?: ExecHostShellProgress
		/**
		 * Asked once, at the deadline, instead of killing the command. Given the
		 * LIVE child and what it has written so far, it may take the process over
		 * and return a job id; the command then keeps running, this call settles
		 * with `backgroundedJobId` set, and nothing here touches the process
		 * again (not on a later Stop, not on its exit). Returning `undefined`, or
		 * throwing, leaves the deadline to kill the command as it always did.
		 */
		onTimeout?: (running: {
			child: ReturnType<typeof spawnHostShell>
			initialOutput: readonly { stream: 'stdout' | 'stderr'; text: string }[]
		}) => string | undefined
		/**
		 * Takes the live process over for a hand-over the person asked for
		 * (a key press, a message that must reach the model, an interrupt),
		 * with the same contract as `onTimeout`. Absent, those hand-overs are
		 * not offered and an interrupt kills the command as it always did.
		 */
		adopt?: (running: {
			child: ReturnType<typeof spawnHostShell>
			initialOutput: readonly { stream: 'stdout' | 'stderr'; text: string }[]
		}) => string | undefined
		/**
		 * An interrupt the person caused (Esc, Ctrl+C) hands the command to
		 * `adopt` instead of killing it. Any other abort, a parent stopping a
		 * child or a budget stop, still kills it.
		 */
		adoptOnInterrupt?: boolean
		/**
		 * Called once, right after the process is spawned, with the means to
		 * hand it over later. `background` returns whether the process was
		 * taken over; it settles the call with `backgroundedJobId` set.
		 */
		onRunning?: (control: { background(reason: 'user' | 'message'): boolean }) => void
	},
): Promise<{
	/** Set when the process was taken over; the command was not stopped. */
	backgroundedJobId?: string
	/** Why it was taken over. */
	backgroundedBy?: 'timeout' | 'user' | 'message' | 'interrupt'
	stdout: string
	stderr: string
	/** Bytes captured on each stream, before decoding; absent from a runner that does not count them. */
	stdoutBytes?: number
	stderrBytes?: number
}> {
	options.signal?.throwIfAborted()
	return new Promise((resolve, reject) => {
		// bash where the host has it, `/bin/sh` where it does not; the
		// permission rules read the line in the matching dialect. See
		// `../command-shell.ts`.
		const child = spawnHostShell(command, {
			cwd: options.cwd,
			env: options.env,
			...(options.shell === undefined ? {} : { shell: options.shell }),
		})
		const captures = {
			stdout: {
				chunks: [] as Buffer[],
				bytes: 0,
				truncated: false,
				decoder: createHostOutputDecoder(),
			},
			stderr: {
				chunks: [] as Buffer[],
				bytes: 0,
				truncated: false,
				decoder: createHostOutputDecoder(),
			},
		}
		let cause: 'caller' | 'timeout' | 'maxBuffer' | undefined
		let failure: (Error & { code?: string | number }) | undefined
		let escalation: ReturnType<typeof setTimeout> | undefined
		let disposeAbort: (() => void) | undefined
		let closed = false
		const cancel = (origin: NonNullable<typeof cause>) => {
			if (closed || cause !== undefined) return
			cause = origin
			escalation = setTimeout(() => {
				escalation = undefined
				killTree(child, 'SIGKILL')
				// A descendant can deliberately start a separate session. It is
				// outside this group, but its inherited pipes must not hold the
				// cancelled call forever. Keep what was captured during grace.
				child.stdin?.destroy()
				child.stdout?.destroy()
				child.stderr?.destroy()
			}, SANDBOX_KILL_GRACE_MS)
			escalation.unref?.()
			killTree(child, 'SIGTERM')
		}
		const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
			const state = captures[stream]
			const kept = Math.min(chunk.length, options.maxBuffer - state.bytes)
			if (kept > 0) {
				state.chunks.push(Buffer.from(chunk.subarray(0, kept)))
				state.bytes += kept
			}
			if (kept < chunk.length) {
				state.truncated = true
				if (cause === undefined) {
					failure = Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), {
						code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
					})
					cancel('maxBuffer')
				}
			}
			if (options.onOutput) {
				const data = state.decoder.write(chunk)
				if (data) options.onOutput({ stream, data })
			}
		}
		const onStdout = (chunk: Buffer) => capture('stdout', chunk)
		const onStderr = (chunk: Buffer) => capture('stderr', chunk)
		child.stdout?.on('data', onStdout)
		child.stderr?.on('data', onStderr)
		let spawned = false
		const onSpawn = () => {
			spawned = true
		}
		child.once('spawn', onSpawn)
		const onError = (error: NodeJS.ErrnoException) => {
			// Same words as a background job that cannot start.
			failure ??= spawned
				? error
				: Object.assign(
						new Error(describeSpawnFailure(error, options.cwd), {
							cause: error,
						}),
						error.code === undefined ? {} : { code: error.code },
					)
		}
		child.once('error', onError)
		const decodeCapture = (stream: 'stdout' | 'stderr') => {
			const state = captures[stream]
			const bytes = Buffer.concat(state.chunks, state.bytes)
			// Do not flush an incomplete character cut by our byte cap.
			const decoder = createHostOutputDecoder()
			const text = decoder.write(bytes)
			return state.truncated ? text : text + decoder.end()
		}
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			closed = true
			disposeAbort?.()
			clearTimeout(deadline)
			if (escalation !== undefined) {
				clearTimeout(escalation)
				// Pipes closing can precede a descendant which closed its copies.
				// Force the owned group now instead of retaining its PID in a timer.
				killTree(child, 'SIGKILL')
			}
			child.stdout?.off('data', onStdout)
			child.stderr?.off('data', onStderr)
			for (const stream of ['stdout', 'stderr'] as const) {
				const data = captures[stream].decoder.end()
				if (data) options.onOutput?.({ stream, data })
			}
			const stdout = decodeCapture('stdout')
			const stderr = decodeCapture('stderr')
			if (!failure && cause === undefined && code === 0 && signal === null) {
				resolve({
					stdout,
					stderr,
					stdoutBytes: captures.stdout.bytes,
					stderrBytes: captures.stderr.bytes,
				})
				return
			}
			const error =
				failure ??
				(cause === 'caller'
					? Object.assign(
							new Error('The operation was aborted', {
								cause: options.signal?.reason,
							}),
							{
								name: 'AbortError',
								code: 'ABORT_ERR',
							},
						)
					: new Error(`Command failed: ${command}\n${stderr}`))
			reject(
				Object.assign(error, {
					stdout,
					stderr,
					stdoutBytes: captures.stdout.bytes,
					stderrBytes: captures.stderr.bytes,
					stdoutTruncated: captures.stdout.truncated,
					stderrTruncated: captures.stderr.truncated,
					code: failure?.code ?? (cause === 'caller' ? 'ABORT_ERR' : code),
					killed: cause !== undefined,
					signal,
					timedOut: cause === 'timeout',
				}),
			)
		}
		child.once('close', onClose)
		// Hands the live process to the host's job registry, once. `onTimeout`
		// answers for the deadline; every other reason goes to `adopt`.
		const takeOver = (reason: 'timeout' | 'user' | 'message' | 'interrupt'): boolean => {
			const adopter =
				reason === 'timeout' ? options.onTimeout : (options.adopt ?? options.onTimeout)
			if (!adopter || closed || cause !== undefined) return false
			let jobId: string | undefined
			try {
				jobId = adopter({
					child,
					initialOutput: (['stdout', 'stderr'] as const)
						.map((stream) => ({ stream, text: decodeCapture(stream) }))
						.filter((part) => part.text !== ''),
				})
			} catch {
				// A host that cannot take the process over leaves the process where it is.
			}
			if (jobId === undefined) return false
			// The registry owns the process from here: stop listening to it,
			// so a later Stop or its exit is not this call's business.
			closed = true
			disposeAbort?.()
			clearTimeout(deadline)
			child.stdout?.off('data', onStdout)
			child.stderr?.off('data', onStderr)
			child.off('close', onClose)
			child.off('error', onError)
			child.off('spawn', onSpawn)
			resolve({
				backgroundedJobId: jobId,
				backgroundedBy: reason,
				stdout: decodeCapture('stdout'),
				stderr: decodeCapture('stderr'),
			})
			return true
		}
		const deadline = setTimeout(() => {
			if (takeOver('timeout')) return
			cancel('timeout')
		}, options.timeout)
		deadline.unref?.()
		if (options.signal) {
			const signal = options.signal
			const onAbort = () => {
				// Esc or Ctrl+C keeps what the command was doing; any other stop
				// (a parent cancelling a child, a budget) still ends it.
				if (
					options.adoptOnInterrupt === true &&
					cancelCauseOf(signal.reason) === 'user' &&
					takeOver('interrupt')
				)
					return
				cancel('caller')
			}
			disposeAbort = subscribeToAbort(signal, onAbort)
			if (signal.aborted) onAbort()
		}
		options.onRunning?.({ background: (reason) => takeOver(reason) })
	})
}

/** The dangerous-pattern check `bash` applies, shared so the `monitor` tool refuses the same lines. */
export function isDangerousCommand(command: string): boolean {
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))
}

/** The refusal when a sandbox cannot host a detached process; exported so the test states the same words. */
export const SANDBOX_CANNOT_DETACH =
	'run_in_background is unavailable: this sandbox cannot start a detached process, and the job will not be run on the host to get around it. Run the command in the foreground, or raise `timeout` up to the tool maximum.'

/**
 * The refusal when a call asks to leave the sandbox without a confirmed
 * approval; exported so the test states the same words.
 */
export const SANDBOX_ESCAPE_NOT_APPROVED =
	'dangerously_disable_sandbox was not approved for this call, so the command did not run. Leaving the sandbox needs the user to confirm it each time, and this turn either cannot ask or does not allow it. Run the command inside the sandbox, or tell the user what it needs and let them run it.'

const BASH_DESCRIPTION =
	'Executes a command line using the execution shell disclosed in the system context and returns stdout/stderr output. The working directory persists between calls, but shell state does not. Command timeout is configurable. The `command` parameter is required, so every call carries one. Long file content goes through `write`, not a heredoc, so it cannot hit the output token limit mid-stream.'

const BashToolBase = defineTool({
	name: 'bash',
	description: BASH_DESCRIPTION,
	inputSchema,
	// A command carries quotes and backslashes of its own, and a heredoc
	// carries newlines: copied into the JSON string raw, they end it.
	malformedInputHint: `Required shape: {"command":"..."}. ${jsonStringEscapes('"command"')}`,
	// The same advice the description gives up front, for the call that did
	// not take it: a heredoc is the long bash call, and a file tool writes the
	// same content in parts.
	truncatedInputHint:
		'To create a long file, do not use a heredoc: write a short opening with the write tool, then add the rest in parts with edit and insertLine: "end".',
	category: 'shell',
	// This tool's own description tells the model to chain with `&&` and `;`,
	// so a permission rule about it is a rule about several commands more often
	// than not. Naming the argument is what lets the gate read it that way.
	commandArgument: 'command',
	// The classifier judges the command line, not the surrounding options.
	classifierInput: (input: BashInput) =>
		`${input.dangerously_disable_sandbox === true ? '[outside the sandbox] ' : ''}${input.command}`,
	// The shell that runs it, so the rules read the line as that shell will.
	commandDialect: bashToolDialect,
	// The kernel reviews a call that sets it under a sandbox every time and
	// confirms it only by id; see `ToolDefinition.sandboxEscapeArgument`.
	sandboxEscapeArgument: 'dangerously_disable_sandbox',
	permissions: ['shell_execute'],
	// A line made only of vetted read-only commands (`ls`, `cat`, `git status`,
	// `git diff`, ...) needs no prompt and may run beside other reads; see
	// `authorization/readonly-commands.ts`. Anything else is not read-only.
	readOnly: (input: BashInput) => bashInputIsReadOnly(input),
	destructive: (input: BashInput) => isDangerousCommand(input.command),
	concurrencySafe: (input: BashInput) => bashInputIsReadOnly(input),
	// Above the ceiling the input schema accepts, so the executor's deadline
	// is a backstop rather than a second clock racing this tool's own. It used
	// to be undefined, which meant the executor's generic default applied —
	// the same two minutes as this tool's DEFAULT, so they agreed by accident
	// and diverged the moment a model asked for longer.
	timeoutMs: MAX_BASH_TIMEOUT_MS + 30_000,

	// The same one-line label every tool without an opinion gets, plus the
	// command itself as a field so a host can headline and tooltip it whole.
	presentCall(input) {
		if (typeof input.command !== 'string') return undefined
		return {
			kind: 'generic',
			label: genericLabel(input),
			facts: { kind: 'command', command: input.command },
		}
	},

	async execute(input, context) {
		const startDirectory = bashWorkingDirectoryForExecution(context)
		if (isDangerousCommand(input.command)) {
			return {
				success: false,
				output: '',
				error: `Dangerous command blocked: "${input.command}"`,
				facts: { kind: 'failure', reason: 'blocked', subject: 'bash' },
			}
		}

		// Where a job registry exists to wait on, a long leading sleep only
		// holds the turn; it is refused with the better ways to wait.
		if (!input.run_in_background && context.backgroundJobs && !backgroundTasksDisabled()) {
			const longSleep = leadingLongSleep(input.command)
			if (longSleep !== null) {
				return { success: false, output: '', error: longSleepRefusal(longSleep) }
			}
		}

		// Asked to leave the sandbox. Honoured only on the executor's word that
		// a reviewer confirmed THIS call (`sandboxEscapeApproved`); the input
		// alone is the model's request, never the permission. Without a
		// sandbox there is nothing to leave and the flag changes nothing.
		const leaveSandbox = input.dangerously_disable_sandbox === true && context.sandbox !== undefined
		if (leaveSandbox && context.sandboxEscapeApproved !== true) {
			return {
				success: false,
				output: '',
				error: SANDBOX_ESCAPE_NOT_APPROVED,
			}
		}
		if (leaveSandbox && input.run_in_background) {
			return {
				success: false,
				output: '',
				error:
					'dangerously_disable_sandbox cannot be combined with run_in_background: a job started on the host would outlive the approval given for this one call. Run it in the foreground.',
			}
		}

		if (input.run_in_background && backgroundTasksDisabled()) {
			return {
				success: false,
				output: '',
				error: `Background jobs are switched off here (${DISABLE_BACKGROUND_TASKS_ENV}). Run the command in the foreground, or raise \`timeout\` up to the tool maximum.`,
			}
		}

		if (input.run_in_background) {
			// A sandboxed turn gets a registry only when its sandbox can start a
			// detached process inside the boundary (`Sandbox.spawnDetached`);
			// the executor withholds it otherwise. This check is for direct
			// tool callers, who could hand a host registry and a sandbox to the
			// same context: the boolean is never an escape from the boundary.
			if (context.sandbox && context.sandbox.spawnDetached === undefined) {
				return {
					success: false,
					output: '',
					error: SANDBOX_CANNOT_DETACH,
				}
			}
			// Refused, not degraded to `cmd &`. The fallback is not a lesser
			// version of this: under the local sandbox's `linux-namespace` tier
			// the wrapping `sh` is PID 1 of a fresh PID namespace, so the
			// backgrounded grandchild dies the moment that shell exits — on the
			// successful path, in milliseconds, looking like it worked. Telling
			// the model its watcher is running when it is already dead is worse
			// than telling it backgrounding is unavailable here.
			if (!context.backgroundJobs) {
				return {
					success: false,
					output: '',
					error:
						'run_in_background was requested, but this host provides no background job registry. Run the command in the foreground, or raise `timeout` up to the tool maximum.',
				}
			}
			try {
				const job = context.backgroundJobs.start({
					command: input.command,
					workingDirectory: startDirectory,
				})
				// `start` returns before the process exists, and a spawn that
				// fails (no such shell, bad directory) reports a tick later.
				// Wait for that one event so "Started" is never said of a job
				// that could not start. No timer: it settles on spawn or error.
				const startup = await context.backgroundJobs.awaitStarted?.(job.id)
				if (startup?.error !== undefined) {
					return {
						success: false,
						output: '',
						error: `${startup.error} (job ${job.id} did not run).`,
						data: { jobId: job.id, background: true, startFailed: true },
					}
				}
				return {
					success: true,
					output: `Started background job ${job.id}; state: running.`,
					data: { jobId: job.id, background: true },
					facts: { kind: 'command', command: input.command, background: true },
				}
			} catch (err) {
				// The per-owner cap, most likely. A refusal that names the limit
				// is actionable; a generic failure sends the model round again.
				return {
					success: false,
					output: '',
					error: err instanceof Error ? err.message : String(err),
				}
			}
		}

		// Sandbox-aware: route through sandbox.exec() when available.
		//
		// `context.workingDirectory` is the HOST-side workspace path the
		// SDK consumer chose for the turn (e.g. `/var/lib/<host>/sessions/<task>`),
		// which is meaningless inside the sandbox container. Forwarding
		// it as `cwd` would either land on a path that doesn't exist
		// (and the worker would `mkdir -p` it inside the container,
		// silently divorcing the model's filesystem view from where its
		// deliverables actually need to land) or, in the case of the
		// `container:docker` worker, fail the workspace-confinement
		// guard outright. The right behaviour is to let the worker
		// fall through to its own default (`NAMZU_SANDBOX_WORKSPACE`
		// → the per-task mount root the host configured at provider
		// construction time). Tools that need a sub-cwd inside the
		// sandbox can be added later as an explicit
		// `SandboxExecOptions.workspaceRelativeCwd` field; the bash
		// builtin doesn't have that requirement today.
		const onOutput = shellProgress(context.report)
		if (context.sandbox && !leaveSandbox) {
			// bash if the guest has it, `/bin/sh` if not; read in the `sh`
			// dialect, which holds for both.
			const launch = sandboxShellSpawn(input.command)
			const result = await context.sandbox.exec(launch.file, launch.args, {
				timeout: input.timeout,
				...(context.env ? { env: withoutBashStartup(context.env) } : {}),
				// Same reason as the host path below: a Stop must reach the
				// process, not just the promise waiting on it.
				signal: context.abortSignal,
				// The worker has always streamed its output; nothing asked for
				// it, so a command that ran for minutes said nothing until it
				// exited. `report` is ephemeral by design — it answers "is it
				// still working?" for a live view and is excluded from the
				// durable transcript — so this is a progress signal, not a
				// second copy of the output. `result.stdout` remains the
				// answer the model is given.
				onOutput,
			})

			// The sandbox reports when IT clipped a stream. Dropping those
			// flags meant the model saw a complete-looking result that had
			// silently lost its tail — and the kernel's own convention is
			// that it does not truncate silently.
			const clipped = [
				result.stdoutTruncated ? 'stdout' : '',
				result.stderrTruncated ? 'stderr' : '',
			].filter(Boolean)

			const output = [
				result.stdout ? `STDOUT:\n${result.stdout}` : '',
				result.stderr ? `STDERR:\n${result.stderr}` : '',
				clipped.length > 0
					? `[${clipped.join(' and ')} was truncated by the sandbox output cap. The omitted output is unavailable in this result. Use a saved artifact or a read-only observation; do not repeat a state-changing action to recover its output.]`
					: '',
			]
				.filter(Boolean)
				.join('\n\n')

			const judged = result.timedOut ? undefined : judgeExit(input.command, result.exitCode)
			const answered = judged !== undefined && !judged.isError
			return {
				success: answered,
				output: output || '(no output)',
				data: {
					exitCode: result.exitCode,
					...(judged?.note ? { exitNote: judged.note } : {}),
					sandboxed: true,
					timedOut: result.timedOut,
					stdoutTruncated: result.stdoutTruncated ?? false,
					stderrTruncated: result.stderrTruncated ?? false,
				},
				error: result.timedOut
					? `Command timed out after ${input.timeout}ms. Any captured output before the deadline is above.`
					: !answered
						? `Command exited with code ${result.exitCode}`
						: undefined,
				facts: commandFacts({
					command: input.command,
					exitCode: result.exitCode,
					...(judged?.note ? { exitNote: judged.note } : {}),
					timedOut: result.timedOut,
					stdout: result.stdout,
					stderr: result.stderr,
				}),
			}
		}

		// The owned runner retains stdout/stderr on non-zero exit and timeout,
		// so a failed command still returns the evidence explaining its failure.
		// The inherited half is scrubbed; `context.env` is not. Inheritance is
		// implicit — nobody decided this command should see `process.env` — while
		// a `context.env` key is one a host wrote on purpose. See
		// `../env-scrub.ts` for why this is a denylist here and an allowlist in
		// the sandbox, and for what it therefore does not catch.
		const inherited = scrubInheritedEnv()

		// Where a job registry can take the process over, running out of time
		// moves the command to the background instead of killing it: a build
		// stopped at two minutes loses everything it did. Nowhere else (no
		// registry, a sandboxed turn, a one-off sandbox escape, a plain wait)
		// is there anything to hand the process to, so those keep the kill.
		const adopt = context.backgroundJobs?.adopt?.bind(context.backgroundJobs)
		const canHandOff =
			adopt !== undefined && context.sandbox === undefined && !backgroundTasksDisabled()
		const canMoveOnTimeout = canHandOff && !startsWithSleep(input.command)
		const adoptRunning = (running: {
			child: Parameters<NonNullable<typeof adopt>>[0]['child']
			initialOutput: Parameters<NonNullable<typeof adopt>>[0]['initialOutput']
		}) =>
			adopt?.({
				command: input.command,
				child: running.child,
				workingDirectory: context.workingDirectory,
				initialOutput: running.initialOutput,
			}).id
		// Offered for hand-over once it has run long enough to be worth moving.
		let offerTimer: ReturnType<typeof setTimeout> | undefined
		let withdrawOffer: (() => void) | undefined
		const offer = context.backgroundJobs?.registerForeground?.bind(context.backgroundJobs)

		// The directory carries over between calls of a session on a POSIX host
		// shell; the shell records where it ended, read back in `finally`.
		const hostShell = hostCommandShell()
		const carryDirectory =
			context.sandbox === undefined &&
			typeof context.sessionId === 'string' &&
			hostShell.path !== undefined &&
			hostShell.windows !== true
		const cwdFile = carryDirectory ? newCwdFile() : undefined
		let settled = false
		const settle = async (): Promise<string | undefined> => {
			if (cwdFile === undefined) return undefined
			settled = true
			return recordDirectory(context.sessionId, cwdFile, context)
		}

		try {
			const { stdout, stderr, stdoutBytes, stderrBytes, backgroundedJobId, backgroundedBy } =
				await execHostShell(
					cwdFile === undefined ? input.command : withCwdCapture(input.command, cwdFile),
					{
						cwd: startDirectory,
						timeout: input.timeout,
						env: { ...inherited.env, ...context.env },
						maxBuffer: DEFAULT_BASH_MAX_BUFFER_BYTES,
						signal: context.abortSignal,
						onOutput,
						...(canMoveOnTimeout ? { onTimeout: adoptRunning } : {}),
						...(canHandOff
							? {
									adopt: adoptRunning,
									adoptOnInterrupt: true,
									...(offer
										? {
												onRunning: (control: {
													background(reason: 'user' | 'message'): boolean
												}) => {
													offerTimer = setTimeout(() => {
														withdrawOffer = offer({
															command: input.command,
															background: (reason) => control.background(reason),
														})
													}, FOREGROUND_HANDOFF_AFTER_MS)
													offerTimer.unref?.()
												},
											}
										: {}),
								}
							: {}),
					},
				)
			if (backgroundedJobId !== undefined) {
				const timedOut = backgroundedBy === 'timeout'
				return {
					success: true,
					output: [
						formatShellOutput(stdout, stderr),
						timedOut || backgroundedBy === undefined
							? movedToBackgroundMessage(backgroundedJobId, input.timeout)
							: handedOffMessage(backgroundedJobId, backgroundedBy),
					]
						.filter(Boolean)
						.join('\n\n'),
					data: {
						jobId: backgroundedJobId,
						background: true,
						...(timedOut || backgroundedBy === undefined ? { timedOut: true } : {}),
						movedToBackground: true,
						...(backgroundedBy ? { backgroundedBy } : {}),
					},
					facts: { kind: 'command', command: input.command, background: true, continued: true },
				}
			}
			const reset = await settle()
			return {
				success: true,
				output: withResetNotice(formatShellOutput(stdout, stderr) || '(no output)', reset),
				data: {
					exitCode: 0,
					...(leaveSandbox ? { sandboxed: false, sandboxEscape: true } : {}),
				},
				facts: commandFacts({
					command: input.command,
					exitCode: 0,
					stdout,
					stderr,
					stdoutBytes,
					stderrBytes,
				}),
			}
		} catch (err) {
			const failure = err as NodeJS.ErrnoException & {
				stdout?: string
				stderr?: string
				stdoutBytes?: number
				stderrBytes?: number
				stdoutTruncated?: boolean
				stderrTruncated?: boolean
				code?: number | string
				killed?: boolean
				signal?: string
				timedOut?: boolean
			}

			// A caller-owned Stop is the caller's, not a command failure.
			if (context.abortSignal?.aborted) throw err

			// A maxBuffer stop or an ordinary signal is not a deadline. The
			// runner latches the first cancellation cause before signalling.
			const timedOut = failure.timedOut === true
			const exitCode = typeof failure.code === 'number' ? failure.code : undefined
			const clipped = [
				failure.stdoutTruncated ? 'stdout' : '',
				failure.stderrTruncated ? 'stderr' : '',
			].filter(Boolean)
			// Only the failure path reports removed variables (in `data`, for the
			// kernel's notice). A successful command did not need to know; a failing
			// one is where "authentication failed" has to be distinguishable from
			// "the variable was withheld".
			// A status the command uses to answer (no match, files differ) is a
			// result, not a failure; the model sees it as an ordinary call.
			const judged =
				!timedOut && exitCode !== undefined ? judgeExit(input.command, exitCode) : undefined
			const answered = judged !== undefined && !judged.isError
			const reset = await settle()
			const output = [
				formatShellOutput(failure.stdout, failure.stderr),
				clipped.length > 0
					? `[${clipped.join(' and ')} ${clipped.length === 1 ? 'was' : 'were'} truncated by the host output cap. The omitted output is unavailable in this result.]`
					: '',
			]
				.filter(Boolean)
				.join('\n\n')

			return {
				success: answered,
				output: withResetNotice(output || '(no output)', reset),
				data: {
					...(exitCode !== undefined ? { exitCode } : {}),
					...(judged?.note ? { exitNote: judged.note } : {}),
					// How many variables were removed, for the kernel's own notice; the
					// model's result stays what the command printed.
					...(!answered && inherited.dropped.length > 0
						? { withheldEnv: inherited.dropped.length }
						: {}),
					...(leaveSandbox ? { sandboxed: false, sandboxEscape: true } : {}),
					timedOut,
					stdoutTruncated: failure.stdoutTruncated ?? false,
					stderrTruncated: failure.stderrTruncated ?? false,
					...(failure.signal ? { signal: failure.signal } : {}),
				},
				error: answered
					? undefined
					: timedOut
						? `Command timed out after ${input.timeout}ms. Any output it produced before the deadline is above.`
						: exitCode !== undefined
							? `Command exited with code ${exitCode}`
							: `Command failed: ${failure.message}`,
				facts: commandFacts({
					command: input.command,
					...(exitCode !== undefined ? { exitCode } : {}),
					...(judged?.note ? { exitNote: judged.note } : {}),
					timedOut,
					...(failure.signal ? { signal: failure.signal } : {}),
					stdout: failure.stdout ?? '',
					stderr: failure.stderr ?? '',
					...(failure.stdoutBytes !== undefined ? { stdoutBytes: failure.stdoutBytes } : {}),
					...(failure.stderrBytes !== undefined ? { stderrBytes: failure.stderrBytes } : {}),
				}),
			}
		} finally {
			if (cwdFile !== undefined && !settled) await rm(cwdFile, { force: true })
			if (offerTimer !== undefined) clearTimeout(offerTimer)
			withdrawOffer?.()
		}
	},
})

/**
 * What a finished command did, as typed fields for the person's view: the exit
 * code, each stream on its own as a head-and-tail window, and whether the
 * output was bytes rather than text. The model's text (labels, the withheld
 * environment note) is not an input here and is never reproduced.
 */
function commandFacts(input: {
	command: string
	exitCode?: number
	exitNote?: string
	timedOut?: boolean
	signal?: string
	stdout: string
	stderr: string
	stdoutBytes?: number
	stderrBytes?: number
}): ToolFacts {
	const outBinary = looksBinary(input.stdout)
	const errBinary = looksBinary(input.stderr)
	const outBytes = input.stdoutBytes ?? Buffer.byteLength(input.stdout, 'utf8')
	const errBytes = input.stderrBytes ?? Buffer.byteLength(input.stderr, 'utf8')
	const binaryBytes = (outBinary ? outBytes : 0) + (errBinary ? errBytes : 0)
	return {
		kind: 'command',
		command: input.command,
		...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
		...(input.exitNote ? { exitNote: input.exitNote } : {}),
		...(input.timedOut ? { timedOut: true } : {}),
		...(input.signal ? { signal: input.signal } : {}),
		...(input.stdout && !outBinary ? { stdout: windowText(input.stdout, outBytes) } : {}),
		...(input.stderr && !errBinary ? { stderr: windowText(input.stderr, errBytes) } : {}),
		...(outBinary || errBinary ? { binary: { bytes: binaryBytes } } : {}),
	}
}

/**
 * The two streams, labelled, with empty ones left out.
 *
 * Shared by the success and failure paths so a command tells the model the
 * same shape either way — the failure path used to tell it nothing at all.
 */
function formatShellOutput(stdout: string | undefined, stderr: string | undefined): string {
	return [stdout ? `STDOUT:\n${stdout}` : '', stderr ? `STDERR:\n${stderr}` : '']
		.filter(Boolean)
		.join('\n\n')
}

/** The result text with the directory-reset line, when there is one, on its own last line. */
function withResetNotice(output: string, notice: string | undefined): string {
	return notice === undefined ? output : `${output}\n${notice}`
}

/**
 * The notice text for the credential-shaped variables left out of a command's
 * environment (see {@link withheldEnvNoticeText}). It is sent as a notice after
 * the tool batch, never written into the command's result.
 */
export function describeWithheldEnv(dropped: readonly string[]): string {
	return withheldEnvNoticeText(dropped.length)
}

/**
 * The same tool, whose description gains the Windows guidance when the host
 * shell is Git Bash. Resolved on first read, not at import: finding Git Bash
 * runs `where.exe`, which a program that only imports the SDK must not pay.
 */
export const BashTool: typeof BashToolBase = Object.defineProperty(
	{ ...BashToolBase },
	'description',
	{
		enumerable: true,
		configurable: true,
		get: () =>
			isWindowsBash(hostCommandShell())
				? `${BASH_DESCRIPTION} ${WINDOWS_BASH_GUIDANCE}`
				: BASH_DESCRIPTION,
	},
)
