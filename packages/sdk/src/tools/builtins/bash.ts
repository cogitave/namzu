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
	name: 'bash',
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
