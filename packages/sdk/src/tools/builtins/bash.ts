import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { DANGEROUS_PATTERNS } from '../../constants/tools/index.js'
import { defineTool } from '../defineTool.js'

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
			`Command timeout in milliseconds. Default: ${DEFAULT_BASH_TIMEOUT_MS}, maximum: ${MAX_BASH_TIMEOUT_MS}. For work that legitimately runs longer than the maximum, start it in the background and poll, rather than holding the turn open.`,
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
		try {
			const { stdout, stderr } = await execAsync(input.command, {
				cwd: context.workingDirectory,
				timeout: input.timeout,
				env: { ...process.env, ...context.env },
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
			const output = formatShellOutput(failure.stdout, failure.stderr)

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

function readPositiveIntEnv(key: string, fallback: number): number {
	const value = process.env[key]?.trim()
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
