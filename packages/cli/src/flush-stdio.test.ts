import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./__fixtures__/flush-exit.ts', import.meta.url))
const MB = 1024 * 1024

function run(
	bytes: number,
	code: number,
	onStdout: (chunk: Buffer, child: ReturnType<typeof spawn>) => void,
): Promise<{ exitCode: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			['--import', 'tsx', fixture, String(bytes), String(code)],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		)
		let stderr = ''
		child.stderr?.on('data', (d: Buffer) => {
			stderr += d.toString()
		})
		child.stdout?.on('data', (d: Buffer) => onStdout(d, child))
		child.on('error', reject)
		child.on('close', (exitCode) => resolve({ exitCode, stderr }))
	})
}

// Real subprocess I/O through a pipe: the default per-test timeout is for in-process work.
describe('flushStdio before exit', () => {
	it('delivers every byte written to a pipe and keeps the exit code', async () => {
		let received = 0
		const result = await run(MB, 7, (chunk) => {
			received += chunk.length
		})
		expect(received).toBe(MB)
		expect(result.exitCode).toBe(7)
	}, 60_000)

	it('exits with its code when the reader closes early, without an EPIPE crash', async () => {
		const result = await run(MB, 3, (_chunk, child) => {
			child.stdout?.destroy()
		})
		expect(result.exitCode).toBe(3)
		expect(result.stderr).not.toContain('EPIPE')
	}, 60_000)
})
