import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { DANGEROUS_PATTERNS } from '../../constants/tools/index.js'
import { defineTool } from '../defineTool.js'

const execAsync = promisify(exec)

const inputSchema = z.object({
	command: z.string().describe('The bash command to execute'),
	timeout: z
		.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().default(30_000))
		.describe('Command timeout in milliseconds. Default: 30000'),
})

type BashInput = z.infer<typeof inputSchema>

function isDangerousCommand(command: string): boolean {
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))
}

export const BashTool = defineTool({
	name: 'Bash',
	description:
		'Executes a bash command and returns stdout/stderr output. Command timeout is configurable.',
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
			})

			if (result.timedOut) {
				return {
					success: false,
					output: '',
					error: `Command timed out after ${input.timeout}ms`,
				}
			}

			const output = [
				result.stdout ? `STDOUT:\n${result.stdout}` : '',
				result.stderr ? `STDERR:\n${result.stderr}` : '',
			]
				.filter(Boolean)
				.join('\n\n')

			return {
				success: result.exitCode === 0,
				output: output || '(no output)',
				data: { exitCode: result.exitCode, sandboxed: true },
				error: result.exitCode !== 0 ? `Command exited with code ${result.exitCode}` : undefined,
			}
		}

		const { stdout, stderr } = await execAsync(input.command, {
			cwd: context.workingDirectory,
			timeout: input.timeout,
			env: { ...process.env, ...context.env },
			maxBuffer: 1024 * 1024 * 10,
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
