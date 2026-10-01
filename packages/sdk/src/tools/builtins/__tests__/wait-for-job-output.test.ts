import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackgroundJobRegistry, bindOwner } from '../../../runtime/jobs/registry.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { WaitForJobTool } from '../wait-for-job.js'

function fixture() {
	const child = Object.assign(new EventEmitter(), {
		pid: undefined,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	})
	const registry = new BackgroundJobRegistry()
	const job = registry.start({
		owner: 'session',
		command: 'synthetic server',
		workingDirectory: process.cwd(),
		spawn: () => ({ child: child as unknown as ReturnType<typeof spawn> }),
	})
	const markAwaited = vi.fn()
	const context = {
		backgroundJobs: bindOwner(registry, 'session', { onAwaited: markAwaited }),
		abortSignal: new AbortController().signal,
	} as unknown as ToolContext
	return { registry, child, context, markAwaited, id: job.id }
}

afterEach(() => vi.useRealTimers())

describe('wait_for_job output mode', () => {
	it('reports a marker and byte cursor with the job still running, without exit-wait intent', async () => {
		const f = fixture()
		f.child.stdout.write('READY\n')
		const result = await WaitForJobTool.execute({ id: f.id, output_contains: 'READY' }, f.context)
		expect(result.success).toBe(true)
		expect(result.output).toContain('Output marker observed on stdout')
		expect(result.output).toContain('not a health check or completion claim')
		expect(result.data).toMatchObject({ outcome: 'matched', status: 'running', nextOffset: 6 })
		expect(f.markAwaited).not.toHaveBeenCalled()
		f.child.emit('close', 0, null)
	})

	it('refuses an older host without falling back to an exit wait or marking intent', async () => {
		const f = fixture()
		const waitForExit = vi.fn()
		const { waitForOutput: _unsupported, ...jobs } = f.context.backgroundJobs!
		const result = await WaitForJobTool.execute(
			{ id: f.id, output_contains: 'READY' },
			{ ...f.context, backgroundJobs: { ...jobs, waitForExit } },
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('no exit wait was started')
		expect(waitForExit).not.toHaveBeenCalled()
		expect(f.markAwaited).not.toHaveBeenCalled()
		f.child.emit('close', 0, null)
	})

	it('retains the default exit mode and its explicit markAwaited behavior', async () => {
		const f = fixture()
		const waiting = WaitForJobTool.execute({ id: f.id }, f.context)
		f.child.stdout.write('done\n')
		f.child.emit('close', 0, null)
		expect((await waiting).data).toMatchObject({ status: 'exited', exitCode: 0 })
		expect(f.markAwaited).toHaveBeenCalledExactlyOnceWith(f.id)
	})

	it('returns bounded timeout evidence without marking the server outstanding or killing it', async () => {
		vi.useFakeTimers()
		const f = fixture()
		const waiting = WaitForJobTool.execute(
			{ id: f.id, output_contains: 'READY', timeout_ms: 10 },
			f.context,
		)
		await vi.advanceTimersByTimeAsync(10)
		const result = await waiting
		expect(result.success).toBe(true)
		expect(result.data).toMatchObject({ outcome: 'timeout', timedOut: 'wall', status: 'running' })
		expect(f.markAwaited).not.toHaveBeenCalled()
		expect(f.registry.get(f.id).status).toBe('running')
		f.child.emit('close', 0, null)
	})

	it('says exit-before-match rather than claiming readiness after a failed process', async () => {
		const f = fixture()
		const waiting = WaitForJobTool.execute(
			{ id: f.id, output_contains: 'READY', output_stream: 'stderr' },
			f.context,
		)
		f.child.stdout.write('READY')
		f.child.emit('close', 9, null)
		const result = await waiting
		expect(result.output).toContain('Job exited before the marker was observed')
		expect(result.data).toMatchObject({ outcome: 'exited', status: 'exited', exitCode: 9 })
		expect(f.markAwaited).not.toHaveBeenCalled()
	})

	it('validates literal bounds and requires a condition when selecting a pipe', () => {
		const schema = WaitForJobTool.inputSchema
		for (const output_contains of ['', '\ud800', '準'.repeat(1366)]) {
			expect(schema.safeParse({ id: 'job_1', output_contains }).success).toBe(false)
		}
		expect(schema.safeParse({ id: 'job_1', output_stream: 'stderr' }).success).toBe(false)
		expect(
			schema.safeParse({ id: 'job_1', output_contains: 'R.*Y', output_stream: 'either' }).success,
		).toBe(true)
	})
})
