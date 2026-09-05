import { expect, it, vi } from 'vitest'

import type { RunId, SandboxId } from '../../../types/ids/index.js'
import type { Sandbox } from '../../../types/sandbox/index.js'
import type { BackgroundJobRegistryRef, ToolContext } from '../../../types/tool/index.js'
import { BashTool, SANDBOX_CANNOT_DETACH } from '../bash.js'

const REFUSAL = SANDBOX_CANNOT_DETACH

function sandbox(): Sandbox {
	return {
		id: '51281012-1dd1-444d-98b8-487422669dff' as SandboxId,
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
		runId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as RunId,
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
