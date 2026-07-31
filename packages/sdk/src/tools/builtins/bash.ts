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
			z.number().default(DEFAULT_BASH_TIMEOUT_MS),
		)
		.describe(`Command timeout in milliseconds. Default: ${DEFAULT_BASH_TIMEOUT_MS}`),
})

type BashInput = z.infer<typeof inputSchema>

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
		const { stdout, stderr } = await execAsync(input.command, {
			cwd: context.workingDirectory,
			timeout: input.timeout,
			env: { ...process.env, ...context.env },
			maxBuffer: DEFAULT_BASH_MAX_BUFFER_BYTES,
			signal: context.abortSignal,
		})

		const output = [stdout ? `STDOUT:\n${stdout}` : '', stderr ? `STDERR:\n${stderr}` : '']
			.filter(Boolean)
			.join('\n\n')

		return {
			success: true,
			output: output || '(no output)',
			data: { exitCode: 0 },
		}
	},
})

function readPositiveIntEnv(key: string, fallback: number): number {
	const value = process.env[key]?.trim()
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
