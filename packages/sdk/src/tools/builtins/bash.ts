import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { SANDBOX_KILL_GRACE_MS } from '../../constants/sandbox/index.js'
import { DANGEROUS_PATTERNS } from '../../constants/tools/index.js'
import { killTree } from '../../process/kill-tree.js'
import { subscribeToAbort } from '../../utils/abort.js'
import { defineTool } from '../defineTool.js'
import { scrubInheritedEnv } from '../env-scrub.js'

// Namzu owns its own bash timeout knob — `NAMZU_BASH_TIMEOUT_MS`.
// The Vandal fallback (`VANDAL_NAMZU_TIMEOUT_MS`) lived here as a
// historical bridge while Namzu was carved out of the Vandal repo,
// but Namzu shouldn't read a consumer's env name. Consumers can
// still alias their own var to `NAMZU_BASH_TIMEOUT_MS` at deploy
// time if they want a unified knob.
// Two minutes, not an hour. The old default meant a wedged command held
// the turn — and, before per-tool deadlines existed, the whole run — for
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
 * that can fire in practice. A request past the ceiling is REFUSED rather
 * than quietly clamped: the model asked for something specific, and silently
 * giving it a different number is how it learns to distrust the answer.
 */
const MAX_BASH_TIMEOUT_MS = readPositiveIntEnv('NAMZU_BASH_MAX_TIMEOUT_MS', 10 * 60 * 1000)

const inputSchema = z.object({
	command: z
		.string()
		.min(1)
		.describe(
			'The bash command to execute. Required, non-empty. Single command per call (use `&&` / `;` chaining for compound commands). Avoid heredocs that span more than a few hundred bytes — large content should be created with `write`, then extended with `edit` insertLine: "end", not piped into bash.',
		),
	timeout: z
		.preprocess(
			(v) => (typeof v === 'string' ? Number(v) : v),
			z.number().positive().max(MAX_BASH_TIMEOUT_MS).default(DEFAULT_BASH_TIMEOUT_MS),
		)
		.describe(
			`Command timeout in milliseconds. Default: ${DEFAULT_BASH_TIMEOUT_MS}, maximum: ${MAX_BASH_TIMEOUT_MS}. For work that legitimately runs longer than the maximum, set run_in_background and poll with the \`job\` tool, rather than holding the turn open.`,
		),
	run_in_background: z
		.boolean()
		.optional()
		.describe(
			'Start the command as a background job and return its id immediately, instead of waiting. The turn is not held open; read its output with the `job` tool. Use for watchers, dev servers and long builds. Do NOT write `cmd &` yourself — under the sandbox the shell that backgrounds it exits immediately and takes the job with it.',
		),
})

type BashInput = z.infer<typeof inputSchema>

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

/**
 * Keep the shell's process group until inherited pipes close. Node's exec
 * timeout/AbortSignal kills only the wrapper and closes its pipes immediately,
 * leaving the command and its descendants running after the promise settles.
 */
function execHostShell(
	command: string,
	options: {
		cwd: string
		env: NodeJS.ProcessEnv
		timeout: number
		maxBuffer: number
		signal?: AbortSignal
		onOutput?: ReturnType<typeof shellProgress>
	},
): Promise<{ stdout: string; stderr: string }> {
	options.signal?.throwIfAborted()
	return new Promise((resolve, reject) => {
		const child = spawn(command, {
			cwd: options.cwd,
			env: options.env,
			shell: true,
			// killTree's negative PID must never target the caller's own group.
			detached: process.platform !== 'win32',
		})
		const captures = {
			stdout: {
				chunks: [] as Buffer[],
				bytes: 0,
				truncated: false,
				decoder: new StringDecoder('utf8'),
			},
			stderr: {
				chunks: [] as Buffer[],
				bytes: 0,
				truncated: false,
				decoder: new StringDecoder('utf8'),
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
		child.once('error', (error: NodeJS.ErrnoException) => {
			failure ??= error
		})
		child.once('close', (code, signal) => {
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
			const decodeCapture = (stream: 'stdout' | 'stderr') => {
				const state = captures[stream]
				const bytes = Buffer.concat(state.chunks, state.bytes)
				// Do not flush an incomplete UTF-8 character cut by our byte cap.
				return state.truncated ? new StringDecoder('utf8').write(bytes) : bytes.toString('utf8')
			}
			const stdout = decodeCapture('stdout')
			const stderr = decodeCapture('stderr')
			if (!failure && cause === undefined && code === 0 && signal === null) {
				resolve({ stdout, stderr })
				return
			}
			const error =
				failure ??
				(cause === 'caller'
					? Object.assign(
							new Error('The operation was aborted', { cause: options.signal?.reason }),
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
					stdoutTruncated: captures.stdout.truncated,
					stderrTruncated: captures.stderr.truncated,
					code: failure?.code ?? (cause === 'caller' ? 'ABORT_ERR' : code),
					killed: cause !== undefined,
					signal,
					timedOut: cause === 'timeout',
				}),
			)
		})
		const deadline = setTimeout(() => cancel('timeout'), options.timeout)
		deadline.unref?.()
		if (options.signal) {
			disposeAbort = subscribeToAbort(options.signal, () => cancel('caller'))
			if (options.signal.aborted) cancel('caller')
		}
	})
}

function isDangerousCommand(command: string): boolean {
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))
}

/** The refusal when a sandbox cannot host a detached process; exported so the test states the same words. */
export const SANDBOX_CANNOT_DETACH =
	'run_in_background is unavailable: this sandbox cannot start a detached process, and the job will not be run on the host to get around it. Run the command in the foreground, or raise `timeout` up to the tool maximum.'

export const BashTool = defineTool({
	name: 'bash',
	description:
		'Executes a bash command and returns stdout/stderr output. Command timeout is configurable. The `command` parameter is required — never call this tool with empty arguments. For very long content (e.g. building a large file), prefer `write` for the opening and `edit` with insertLine: "end" for follow-up chunks over a heredoc to avoid hitting the output token limit mid-stream.',
	inputSchema,
	category: 'shell',
	// This tool's own description tells the model to chain with `&&` and `;`,
	// so a permission rule about it is a rule about several commands more often
	// than not. Naming the argument is what lets the gate read it that way.
	commandArgument: 'command',
	permissions: ['shell_execute'],
	readOnly: false,
	destructive: (input: BashInput) => isDangerousCommand(input.command),
	concurrencySafe: false,
	// Above the ceiling the input schema accepts, so the executor's deadline
	// is a backstop rather than a second clock racing this tool's own. It used
	// to be undefined, which meant the executor's generic default applied —
	// the same two minutes as this tool's DEFAULT, so they agreed by accident
	// and diverged the moment a model asked for longer.
	timeoutMs: MAX_BASH_TIMEOUT_MS + 30_000,

	async execute(input, context) {
		if (isDangerousCommand(input.command)) {
			return {
				success: false,
				output: '',
				error: `Dangerous command blocked: "${input.command}"`,
			}
		}

		if (input.run_in_background) {
			// A sandboxed run gets a registry only when its sandbox can start a
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
					workingDirectory: context.workingDirectory,
				})
				return {
					success: true,
					output: `Started background job ${job.id}. Read its output with the \`job\` tool: {"action":"read","id":"${job.id}"}.`,
					data: { jobId: job.id, background: true },
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
		// SDK consumer chose for the run (Vandal: `/var/lib/vandal/sessions/<task>`),
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
		if (context.sandbox) {
			const result = await context.sandbox.exec('/bin/sh', ['-c', input.command], {
				timeout: input.timeout,
				env: context.env,
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

			return {
				success: !result.timedOut && result.exitCode === 0,
				output: output || '(no output)',
				data: {
					exitCode: result.exitCode,
					sandboxed: true,
					timedOut: result.timedOut,
					stdoutTruncated: result.stdoutTruncated ?? false,
					stderrTruncated: result.stderrTruncated ?? false,
				},
				error: result.timedOut
					? `Command timed out after ${input.timeout}ms. Any captured output before the deadline is above.`
					: result.exitCode !== 0
						? `Command exited with code ${result.exitCode}`
						: undefined,
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

		try {
			const { stdout, stderr } = await execHostShell(input.command, {
				cwd: context.workingDirectory,
				timeout: input.timeout,
				env: { ...inherited.env, ...context.env },
				maxBuffer: DEFAULT_BASH_MAX_BUFFER_BYTES,
				signal: context.abortSignal,
				onOutput,
			})
			return {
				success: true,
				output: formatShellOutput(stdout, stderr) || '(no output)',
				data: { exitCode: 0 },
			}
		} catch (err) {
			const failure = err as NodeJS.ErrnoException & {
				stdout?: string
				stderr?: string
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
			// Only on the failure path. A successful command did not need to know,
			// and appending this to every result would make the common case noisy
			// to buy nothing. A failing one is exactly where "authentication
			// failed" has to be distinguishable from "the variable was withheld".
			const output = [
				formatShellOutput(failure.stdout, failure.stderr),
				clipped.length > 0
					? `[${clipped.join(' and ')} ${clipped.length === 1 ? 'was' : 'were'} truncated by the host output cap. The omitted output is unavailable in this result.]`
					: '',
				describeWithheldEnv(inherited.dropped),
			]
				.filter(Boolean)
				.join('\n\n')

			return {
				success: false,
				output: output || '(no output)',
				data: {
					...(exitCode !== undefined ? { exitCode } : {}),
					timedOut,
					stdoutTruncated: failure.stdoutTruncated ?? false,
					stderrTruncated: failure.stderrTruncated ?? false,
					...(failure.signal ? { signal: failure.signal } : {}),
				},
				error: timedOut
					? `Command timed out after ${input.timeout}ms. Any output it produced before the deadline is above.`
					: exitCode !== undefined
						? `Command exited with code ${exitCode}`
						: `Command failed: ${failure.message}`,
			}
		}
	},
})

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

/** How many withheld names to print before summarising the rest. */
const WITHHELD_ENV_PREVIEW = 10

/**
 * Name the credential-shaped variables this command did not inherit.
 *
 * Names only, never values. A command that failed because it wanted
 * `FOO_TOKEN` otherwise reports an authentication error pointing nowhere; the
 * next move — have the host pass it explicitly through `context.env` — is only
 * available to a reader who knows it was withheld rather than unset.
 */
function describeWithheldEnv(dropped: readonly string[]): string {
	if (dropped.length === 0) return ''
	const shown = dropped.slice(0, WITHHELD_ENV_PREVIEW).join(', ')
	const rest = dropped.length - WITHHELD_ENV_PREVIEW
	const names = rest > 0 ? `${shown}, and ${rest} more` : shown
	return `NOTE: ${dropped.length} credential-shaped environment variable(s) were withheld from this command and are unset rather than empty: ${names}. A host that means this command to have one passes it explicitly.`
}

function readPositiveIntEnv(key: string, fallback: number): number {
	const value = process.env[key]?.trim()
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
