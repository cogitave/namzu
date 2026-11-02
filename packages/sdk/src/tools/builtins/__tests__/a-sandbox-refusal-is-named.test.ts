import { describe, expect, it } from 'vitest'

import type { Sandbox, SandboxExecResult } from '../../../types/sandbox/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'

function run(result: Partial<SandboxExecResult>) {
	const sandbox = {
		async exec() {
			return { stdout: '', stderr: '', exitCode: 1, timedOut: false, durationMs: 1, ...result }
		},
	} as unknown as Sandbox
	const context = {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
		turnId: '37ddff8e-e13f-4e57-937f-d048fa323f5e',
		workingDirectory: '/workspace',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		sandbox,
	} as unknown as ToolContext
	return BashTool.execute({ command: 'touch /etc/x', timeout: 5000 } as never, context)
}

describe('a sandbox refusal is named to the model', () => {
	it('puts the denial note in the output and the error', async () => {
		const out = await run({
			stderr: 'x: Read-only file system',
			attribution: { kind: 'denial', message: 'This looks like a sandbox denial: ask.' },
		})
		expect(out.success).toBe(false)
		expect(out.output).toContain('looks like a sandbox denial')
		expect(out.error).toContain('looks like a sandbox denial')
	})

	it('reports a launcher failure as a runner failure, not as the command failing', async () => {
		const out = await run({
			stderr: 'bwrap: no namespace',
			attribution: { kind: 'runner-failure', message: 'launcher failed' },
		})
		expect(out.success).toBe(false)
		expect(out.error).toContain('runner failure')
		expect(out.error).not.toContain('exited with code')
	})
})
