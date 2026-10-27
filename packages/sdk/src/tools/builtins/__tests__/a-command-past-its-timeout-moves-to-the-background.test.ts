import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackgroundJobRegistry, bindOwner } from '../../../runtime/jobs/registry.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool, DISABLE_BACKGROUND_TASKS_ENV, movedToBackgroundMessage } from '../bash.js'

const { startSpawn, stopTree } = vi.hoisted(() => ({
	startSpawn: vi.fn(),
	stopTree: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	return { ...actual, spawn: startSpawn }
})
vi.mock('../../../process/kill-tree.js', () => ({ killTree: stopTree }))

afterEach(() => {
	startSpawn.mockReset()
	stopTree.mockReset()
	vi.unstubAllEnvs()
	vi.useRealTimers()
})

/** A live child that stays pending until the test ends it. */
function runningCommand() {
	const stdout = new PassThrough()
	const stderr = new PassThrough()
	const child = Object.assign(new EventEmitter(), {
		pid: 4242 as number | undefined,
		stdout,
		stderr,
	})
	startSpawn.mockReturnValue(child)
	return {
		stdout,
		stderr,
		finish: (code: number | null = 0) => {
			stdout.end()
			stderr.end()
			child.emit('close', code, null)
		},
	}
}

function turn(registry?: BackgroundJobRegistry, extra: Partial<ToolContext> = {}): ToolContext {
	return {
		workingDirectory: '/workspace',
		...(registry
			? {
					backgroundJobs: bindOwner(registry, 'turn-1', {
						workingDirectory: '/workspace',
					}),
				}
			: {}),
		...extra,
	} as ToolContext
}

describe('a foreground command that outruns its timeout', () => {
	it('keeps running as a background job, with what it printed so far and the way to read and stop it', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const pending = BashTool.execute({ command: 'make all', timeout: 120_000 }, turn(registry))
		child.stdout.write('compiling a\n')
		child.stderr.write('warning: slow\n')

		vi.advanceTimersByTime(120_000)
		const result = await pending

		const [job] = registry.list('turn-1')
		expect(job).toMatchObject({ command: 'make all', status: 'running' })
		expect(result.success).toBe(true)
		expect(result.output).toContain('STDOUT:\ncompiling a')
		expect(result.output).toContain('STDERR:\nwarning: slow')
		expect(result.output).toContain(movedToBackgroundMessage(job?.id ?? '', 120_000))
		expect(result.output).toContain('120s timeout')
		// The result states what happened; how to wait, read or stop is in the job tools' descriptions.
		expect(result.output).not.toContain('wait_for_job')
		expect(result.data).toMatchObject({
			jobId: job?.id,
			background: true,
			movedToBackground: true,
		})
		// Moved, not stopped.
		expect(stopTree).not.toHaveBeenCalled()

		// The job carries on and its later output is readable from the start.
		child.stdout.write('compiling b\n')
		const read = registry.read(job?.id ?? '', {})
		expect(read.chunk).toContain('compiling a')
		expect(read.chunk).toContain('compiling b')

		// The exit is announced like any job's, and the process was left alone.
		const ended = registry.waitForExit(job?.id ?? '')
		child.finish(0)
		await expect(ended).resolves.toMatchObject({
			status: 'exited',
			exitCode: 0,
		})
		expect(stopTree).not.toHaveBeenCalled()
	})

	it('is not stopped by the call being stopped afterwards', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const abort = new AbortController()
		const pending = BashTool.execute(
			{ command: 'make all', timeout: 1000 },
			turn(registry, { abortSignal: abort.signal }),
		)
		vi.advanceTimersByTime(1000)
		await pending
		abort.abort()
		expect(stopTree).not.toHaveBeenCalled()
		child.finish(0)
	})

	it('is still stopped and reported as timed out when the host has no job registry', async () => {
		vi.useFakeTimers()
		const child = runningCommand()
		const pending = BashTool.execute({ command: 'make all', timeout: 1000 }, turn())
		vi.advanceTimersByTime(1000)
		expect(stopTree).toHaveBeenCalledWith(expect.anything(), 'SIGTERM')
		child.finish(null)
		const result = await pending
		expect(result.success).toBe(false)
		expect(result.error).toContain('timed out after 1000ms')
	})

	it('is still stopped when it only waits (sleep)', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const pending = BashTool.execute(
			{ command: 'sleep 600 && echo done', timeout: 1000 },
			turn(registry),
		)
		vi.advanceTimersByTime(1000)
		expect(stopTree).toHaveBeenCalled()
		child.finish(null)
		const result = await pending
		expect(result.data).toMatchObject({ timedOut: true })
		expect(registry.list('turn-1')).toHaveLength(0)
	})

	it('is still stopped when background jobs are switched off, and run_in_background is refused', async () => {
		vi.stubEnv(DISABLE_BACKGROUND_TASKS_ENV, '1')
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const pending = BashTool.execute({ command: 'make all', timeout: 1000 }, turn(registry))
		vi.advanceTimersByTime(1000)
		expect(stopTree).toHaveBeenCalled()
		child.finish(null)
		expect((await pending).success).toBe(false)
		expect(registry.list('turn-1')).toHaveLength(0)

		const refused = await BashTool.execute(
			{ command: 'make all', timeout: 1000, run_in_background: true },
			turn(registry),
		)
		expect(refused.success).toBe(false)
		expect(refused.error).toContain(DISABLE_BACKGROUND_TASKS_ENV)
	})

	it('is still stopped when the owner is already at its job limit', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry({ maxJobsPerOwner: 1 })
		registry.start({
			owner: 'turn-1',
			command: 'server',
			workingDirectory: '/workspace',
			spawn: () => ({
				child: Object.assign(new EventEmitter(), {
					pid: 1,
					stdout: new PassThrough(),
					stderr: new PassThrough(),
				}) as never,
			}),
		})
		const child = runningCommand()
		const pending = BashTool.execute({ command: 'make all', timeout: 1000 }, turn(registry))
		vi.advanceTimersByTime(1000)
		expect(stopTree).toHaveBeenCalled()
		child.finish(null)
		expect((await pending).success).toBe(false)
	})
})
