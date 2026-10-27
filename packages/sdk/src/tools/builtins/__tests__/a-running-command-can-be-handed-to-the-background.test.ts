import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackgroundJobRegistry, bindOwner } from '../../../runtime/jobs/registry.js'
import { TurnCancelled } from '../../../types/session/cancel-cause.js'
import type { ToolContext } from '../../../types/tool/index.js'
import {
	BashTool,
	DISABLE_BACKGROUND_TASKS_ENV,
	FOREGROUND_HANDOFF_AFTER_MS,
	handedOffMessage,
} from '../bash.js'

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

describe('a running foreground command the person hands to the background', () => {
	it('is offered only once it has run for two seconds', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const pending = BashTool.execute({ command: 'make all', timeout: 600_000 }, turn(registry))

		vi.advanceTimersByTime(FOREGROUND_HANDOFF_AFTER_MS - 1)
		expect(registry.foregroundCommands('turn-1')).toHaveLength(0)
		expect(registry.backgroundForeground('turn-1', 'user')).toBe(0)

		vi.advanceTimersByTime(1)
		expect(registry.foregroundCommands('turn-1')).toMatchObject([{ command: 'make all' }])

		child.finish(0)
		await pending
		// A finished call withdraws its offer.
		expect(registry.foregroundCommands('turn-1')).toHaveLength(0)
	})

	it('keeps running as a job when the person asks, and the call says so', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const changes: string[] = []
		registry.onForegroundChange((owner) => changes.push(owner))
		const pending = BashTool.execute({ command: 'make all', timeout: 600_000 }, turn(registry))
		child.stdout.write('compiling a\n')
		vi.advanceTimersByTime(FOREGROUND_HANDOFF_AFTER_MS)
		expect(changes).toEqual(['turn-1'])

		expect(registry.backgroundForeground('turn-1', 'user')).toBe(1)
		const result = await pending

		const [job] = registry.list('turn-1')
		expect(job).toMatchObject({ command: 'make all', status: 'running' })
		expect(result.success).toBe(true)
		expect(result.output).toContain('STDOUT:\ncompiling a')
		expect(result.output).toContain(handedOffMessage(job?.id ?? '', 'user'))
		expect(result.data).toMatchObject({
			jobId: job?.id,
			background: true,
			movedToBackground: true,
			backgroundedBy: 'user',
		})
		expect(result.data).not.toHaveProperty('timedOut')
		expect(result.facts).toMatchObject({ kind: 'command', background: true, continued: true })
		expect(stopTree).not.toHaveBeenCalled()
		// Taken over: the offer is gone and the owner is told once more.
		expect(registry.foregroundCommands('turn-1')).toHaveLength(0)
		expect(changes).toEqual(['turn-1', 'turn-1'])

		const ended = registry.waitForExit(job?.id ?? '')
		child.finish(0)
		await expect(ended).resolves.toMatchObject({ status: 'exited', exitCode: 0 })
	})

	it('says a message from the person is why, when that is why', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const pending = BashTool.execute({ command: 'make all', timeout: 600_000 }, turn(registry))
		vi.advanceTimersByTime(FOREGROUND_HANDOFF_AFTER_MS)
		registry.backgroundForeground('turn-1', 'message')
		const result = await pending
		const [job] = registry.list('turn-1')
		expect(result.output).toContain(handedOffMessage(job?.id ?? '', 'message'))
		expect(result.output).toContain('a message from the person')
		expect(result.data).toMatchObject({ backgroundedBy: 'message' })
		child.finish(0)
	})

	it('also moves a command that only waits, which the deadline would still stop', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const pending = BashTool.execute(
			{ command: 'sleep 60 && echo done', timeout: 600_000 },
			turn(registry),
		)
		vi.advanceTimersByTime(FOREGROUND_HANDOFF_AFTER_MS)
		expect(registry.backgroundForeground('turn-1', 'user')).toBe(1)
		await pending
		expect(registry.list('turn-1')).toHaveLength(1)
		child.finish(0)
	})

	it('offers nothing to another owner', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const pending = BashTool.execute({ command: 'make all', timeout: 600_000 }, turn(registry))
		vi.advanceTimersByTime(FOREGROUND_HANDOFF_AFTER_MS)
		expect(registry.foregroundCommands('turn-2')).toHaveLength(0)
		expect(registry.backgroundForeground('turn-2', 'user')).toBe(0)
		child.finish(0)
		await pending
	})

	it('is not offered when background jobs are switched off', async () => {
		vi.stubEnv(DISABLE_BACKGROUND_TASKS_ENV, '1')
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const pending = BashTool.execute({ command: 'make all', timeout: 600_000 }, turn(registry))
		vi.advanceTimersByTime(FOREGROUND_HANDOFF_AFTER_MS)
		expect(registry.foregroundCommands('turn-1')).toHaveLength(0)
		child.finish(0)
		await pending
	})

	it('stays in the foreground when the owner is at its job limit', async () => {
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
		const pending = BashTool.execute({ command: 'make all', timeout: 600_000 }, turn(registry))
		vi.advanceTimersByTime(FOREGROUND_HANDOFF_AFTER_MS)
		expect(registry.backgroundForeground('turn-1', 'user')).toBe(0)
		// Still waiting on the command: it ends normally.
		child.stdout.write('done\n')
		child.finish(0)
		const result = await pending
		expect(result.success).toBe(true)
		expect(result.data).not.toHaveProperty('movedToBackground')
	})
})

describe('an interrupt while a foreground command runs', () => {
	it('moves the command to the background when the person pressed Esc', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const abort = new AbortController()
		const pending = BashTool.execute(
			{ command: 'make all', timeout: 600_000 },
			turn(registry, { abortSignal: abort.signal }),
		)
		child.stdout.write('compiling a\n')
		abort.abort(new TurnCancelled('user'))
		const result = await pending
		const [job] = registry.list('turn-1')
		expect(job).toMatchObject({ command: 'make all', status: 'running' })
		expect(result.output).toContain(handedOffMessage(job?.id ?? '', 'interrupt'))
		expect(result.data).toMatchObject({ backgroundedBy: 'interrupt', movedToBackground: true })
		expect(stopTree).not.toHaveBeenCalled()
		child.finish(0)
	})

	it('moves a command that has run for under two seconds as well', async () => {
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const abort = new AbortController()
		const pending = BashTool.execute(
			{ command: 'sleep 5 && make', timeout: 600_000 },
			turn(registry, { abortSignal: abort.signal }),
		)
		abort.abort(new TurnCancelled('user'))
		await pending
		expect(registry.list('turn-1')).toHaveLength(1)
		child.finish(0)
	})

	it('still stops the command when a parent or a budget ended the turn', async () => {
		for (const cause of ['parent', 'budget', 'hook'] as const) {
			startSpawn.mockReset()
			stopTree.mockReset()
			vi.useFakeTimers()
			const registry = new BackgroundJobRegistry()
			const child = runningCommand()
			const abort = new AbortController()
			const pending = BashTool.execute(
				{ command: 'make all', timeout: 600_000 },
				turn(registry, { abortSignal: abort.signal }),
			).catch((err: unknown) => err)
			abort.abort(new TurnCancelled(cause))
			expect(stopTree).toHaveBeenCalledWith(expect.anything(), 'SIGTERM')
			child.finish(null)
			await pending
			expect(registry.list('turn-1')).toHaveLength(0)
		}
	})

	it('still stops the command when nothing can hold a job', async () => {
		vi.useFakeTimers()
		const child = runningCommand()
		const abort = new AbortController()
		const pending = BashTool.execute(
			{ command: 'make all', timeout: 600_000 },
			turn(undefined, { abortSignal: abort.signal }),
		).catch((err: unknown) => err)
		abort.abort(new TurnCancelled('user'))
		expect(stopTree).toHaveBeenCalledWith(expect.anything(), 'SIGTERM')
		child.finish(null)
		await pending
	})

	it('still stops the command when background jobs are switched off', async () => {
		vi.stubEnv(DISABLE_BACKGROUND_TASKS_ENV, '1')
		vi.useFakeTimers()
		const registry = new BackgroundJobRegistry()
		const child = runningCommand()
		const abort = new AbortController()
		const pending = BashTool.execute(
			{ command: 'make all', timeout: 600_000 },
			turn(registry, { abortSignal: abort.signal }),
		).catch((err: unknown) => err)
		abort.abort(new TurnCancelled('user'))
		expect(stopTree).toHaveBeenCalledWith(expect.anything(), 'SIGTERM')
		child.finish(null)
		await pending
		expect(registry.list('turn-1')).toHaveLength(0)
	})
})
