import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { DANGEROUS_PATTERNS } from '../../constants/tools/index.js'
import { defineTool } from '../defineTool.js'
import { scrubInheritedEnv } from '../env-scrub.js'

const execAsync = promisify(exec)
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

/**
 * The last line worth showing from one chunk of streamed output.
 *
 * A progress line is a status, not a log: the host renders one line and
 * replaces it as the next arrives, so sending a whole chunk sends a wall
 * of text into a slot that shows one line of it. A chunk usually ends
 * mid-line and usually ends with a newline, so the last NON-EMPTY line is
 * the most recent complete thing the command actually said.
 *
 * Progress is capped rather than truncated with an ellipsis: this is
 * glanced at, and a marker in a line nobody reads to the end is noise.
 */
function lastNonEmptyLine(chunk: string): string | undefined {
	const lines = chunk.split('\n')
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim()
		if (line) return line.length > 160 ? line.slice(0, 160) : line
	}
	return undefined
}

function isDangerousCommand(command: string): boolean {
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))
}

export const BashTool = defineTool({
	name: 'bash',
	description:
		'Executes a bash command and returns stdout/stderr output. Command timeout is configurable. The `command` parameter is required — never call this tool with empty arguments. For very long content (e.g. building a large file), prefer `write` for the opening and `edit` with insertLine: "end" for follow-up chunks over a heredoc to avoid hitting the output token limit mid-stream.',
	inputSchema,
	category: 'shell',
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
				onOutput: context.report
					? ({ data }) => {
							const line = lastNonEmptyLine(data)
							if (line) context.report?.(line)
						}
					: undefined,
			})

			if (result.timedOut) {
				return {
					success: false,
					output: '',
					error: `Command timed out after ${input.timeout}ms`,
				}
			}

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
					? `[${clipped.join(' and ')} was truncated by the sandbox output cap — re-run with a filter (grep/head/tail) to see the rest]`
					: '',
			]
				.filter(Boolean)
				.join('\n\n')

			return {
				success: result.exitCode === 0,
				output: output || '(no output)',
				data: {
					exitCode: result.exitCode,
					sandboxed: true,
					stdoutTruncated: result.stdoutTruncated ?? false,
					stderrTruncated: result.stderrTruncated ?? false,
				},
				error: result.exitCode !== 0 ? `Command exited with code ${result.exitCode}` : undefined,
			}
		}

		// Thread the run/deadline signal into the child process. Without it
		// a Stop tore down the model stream and left the command running,
		// and the executor's deadline could only ever DETACH from the tool
		// rather than end the work it started.
		// `exec` REJECTS on a non-zero exit, on its own timeout, and on a
		// kill — and the rejection carries `stdout`, `stderr`, `code` and
		// `killed`. Letting it propagate threw all of that away: the registry
		// turned the throw into a structured failure, so the model was told a
		// command failed and not one word about how.
		//
		// That is the common case, not an edge one. A failing test run and a
		// failing build are the two things an agent runs bash for most, and
		// both exit non-zero WITH the output that explains why. The sandbox
		// branch above already reports all of it; this branch did not, so the
		// same command told the model two different amounts depending on where
		// it happened to run.
		// The inherited half is scrubbed; `context.env` is not. Inheritance is
		// implicit — nobody decided this command should see `process.env` — while
		// a `context.env` key is one a host wrote on purpose. See
		// `../env-scrub.ts` for why this is a denylist here and an allowlist in
		// the sandbox, and for what it therefore does not catch.
		const inherited = scrubInheritedEnv()

		try {
			const { stdout, stderr } = await execAsync(input.command, {
				cwd: context.workingDirectory,
				timeout: input.timeout,
				env: { ...inherited.env, ...context.env },
				maxBuffer: DEFAULT_BASH_MAX_BUFFER_BYTES,
				signal: context.abortSignal,
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
				code?: number | string
				killed?: boolean
				signal?: string
			}

			// A caller-owned Stop is the caller's, not a command failure.
			if (context.abortSignal?.aborted) throw err

			// `exec` reports its own timeout as a kill, and the distinction
			// matters to the model: "ran out of time" is a different next move
			// from "exited 1".
			const timedOut = failure.killed === true && failure.signal === 'SIGTERM'
			const exitCode = typeof failure.code === 'number' ? failure.code : undefined
			// Only on the failure path. A successful command did not need to know,
			// and appending this to every result would make the common case noisy
			// to buy nothing. A failing one is exactly where "authentication
			// failed" has to be distinguishable from "the variable was withheld".
			const output = [
				formatShellOutput(failure.stdout, failure.stderr),
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
