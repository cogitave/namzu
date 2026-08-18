import { expect, it, vi } from 'vitest'

import type { RunId, SandboxId } from '../../../types/ids/index.js'
import type { Sandbox } from '../../../types/sandbox/index.js'
import type { BackgroundJobRegistryRef, ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'

const REFUSAL =
	'run_in_background is unavailable while a sandbox is active because the host background-job registry cannot preserve that sandbox boundary. Run the command in the foreground, or use a sandbox-aware persistent-process capability.'

function sandbox(): Sandbox {
	return {
		id: 'sbx_test' as SandboxId,
		status: 'ready',
		rootDir: '/workspace',
		environment: 'basic',
		exec: vi.fn(async () => {
			throw new Error('sandbox execution must not start for a refused background request')
		}),
		writeFile: vi.fn(async () => {}),
		readFile: vi.fn(async () => Buffer.alloc(0)),
		listFiles: vi.fn(async () => []),
		destroy: vi.fn(async () => {}),
	}
}

it('refuses a direct background call instead of changing its execution boundary', async () => {
	const start = vi.fn((): never => {
		throw new Error('the host process registry must not be reached')
	})
	const jobs = {
		start,
		get: (): never => {
			throw new Error('not used')
		},
		read: (): never => {
			throw new Error('not used')
		},
		kill: async (): Promise<never> => {
			throw new Error('not used')
		},
		list: () => [],
	} satisfies BackgroundJobRegistryRef
	const boundary = sandbox()
	const context: ToolContext = {
		runId: 'run_test' as RunId,
		workingDirectory: '/workspace',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		sandbox: boundary,
		backgroundJobs: jobs,
	}

	const result = await BashTool.execute(
		{ command: 'printf should-not-run', timeout: 1_000, run_in_background: true },
		context,
	)

	expect(result).toEqual({ success: false, output: '', error: REFUSAL })
	expect(start).not.toHaveBeenCalled()
	expect(boundary.exec).not.toHaveBeenCalled()
})
