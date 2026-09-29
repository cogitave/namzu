import { describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { describeJobWaitTimeout, waitForJobWithBounds } from '../wait-for-job-bounds.js'
import { WaitForJobTool } from '../wait-for-job.js'

/**
 * A job's only progress signal is bytes on stdout/stderr, unlike a
 * delegated task's `onTaskProgress` callback. These tests drive a fake job
 * reader by hand — advancing a fake clock and feeding it output — for the
 * same reason `wait-with-idle-bound.test.ts` (the task-surface sibling this
 * mirrors) does: the real bounds are measured in minutes, and a test that
 * actually waits them out is a test nobody runs.
 */

interface JobFixture {
	jobs: {
		read: (
			id: string,
			opts?: { fromOffset?: number },
		) => {
			chunk: string
			nextOffset: number
			droppedBytes: number
			status: string
			exitCode?: number
		}
		waitForExit: (
			id: string,
			opts?: { signal?: AbortSignal },
		) => Promise<{ id: string; status: string; exitCode?: number }>
		kill: ReturnType<typeof vi.fn>
	}
	write: (chunk: string) => void
	finish: (status?: 'exited' | 'killed', exitCode?: number) => void
}

function jobFor(): JobFixture {
	let full = ''
	let status: 'running' | 'exited' | 'killed' = 'running'
	let exitCode: number | undefined
	let resolveExit: (() => void) | undefined
	const exited = new Promise<void>((resolve) => {
		resolveExit = resolve
	})
	const kill = vi.fn()

	const record = () => ({
		id: 'job_1',
		status,
		...(exitCode === undefined ? {} : { exitCode }),
	})

	return {
		jobs: {
			read: (_id, opts) => {
				const from = opts?.fromOffset ?? 0
				const bytes = Buffer.from(full, 'utf8')
				return {
					chunk: bytes.subarray(from).toString('utf8'),
					nextOffset: bytes.length,
					droppedBytes: 0,
					status,
					...(exitCode === undefined ? {} : { exitCode }),
				}
			},
			waitForExit: (_id, waitOpts) =>
				new Promise((resolve, reject) => {
					if (status !== 'running') {
						resolve(record())
						return
					}
					if (waitOpts?.signal?.aborted) {
						reject(waitOpts.signal.reason)
						return
					}
					exited.then(() => resolve(record()))
					waitOpts?.signal?.addEventListener('abort', () => reject(waitOpts.signal?.reason), {
						once: true,
					})
				}),
			kill,
		},
		write: (chunk) => {
			full += chunk
		},
		finish: (finalStatus = 'exited', code = 0) => {
			status = finalStatus
			exitCode = code
			resolveExit?.()
		},
	}
}

function contextFor(jobs: JobFixture['jobs']): ToolContext {
	return {
		backgroundJobs: {
			...jobs,
			get: () => ({ id: 'job_1', status: 'running' }),
			markAwaited: vi.fn(),
		},
		abortSignal: new AbortController().signal,
	} as unknown as ToolContext
}

/** A clock the test moves by hand. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
	let t = 1_000_000
	return {
		now: () => t,
		advance: (ms) => {
			t += ms
		},
	}
}

describe('a job that is still producing output is not cut off for being slow', () => {
	it('keeps waiting past the idle bound while new output keeps arriving', async () => {
		vi.useFakeTimers()
		try {
			const clock = fakeClock()
			const { jobs, write, finish } = jobFor()

			const waiting = waitForJobWithBounds(
				jobs,
				'job_1',
				{ wallMs: 60_000, idleMs: 5_000 },
				clock.now,
			)

			// Four times the idle bound in elapsed time, but never quiet for
			// more than half of it.
			for (let i = 0; i < 8; i += 1) {
				clock.advance(2_500)
				write(`line ${i}\n`)
				await vi.advanceTimersByTimeAsync(1_000)
			}

			finish('exited', 0)
			await vi.advanceTimersByTimeAsync(1_000)

			const outcome = await waiting
			expect(outcome.kind, 'a job that kept producing output was cut off').toBe('exited')
			if (outcome.kind !== 'exited') return
			expect(outcome.output).toContain('line 0')
			expect(outcome.output).toContain('line 7')
			expect(jobs.kill).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('a job that has gone quiet is reported as quiet', () => {
	it('fires the idle bound only after real silence, and says which clock it was', async () => {
		vi.useFakeTimers()
		try {
			const clock = fakeClock()
			const { jobs } = jobFor()
			const originalWaitForExit = jobs.waitForExit
			let waitSignal: AbortSignal | undefined
			jobs.waitForExit = (id, opts) => {
				waitSignal = opts?.signal
				return originalWaitForExit(id, opts)
			}

			const waiting = waitForJobWithBounds(
				jobs,
				'job_1',
				{ wallMs: 600_000, idleMs: 5_000 },
				clock.now,
			)

			clock.advance(6_000)
			await vi.advanceTimersByTimeAsync(1_100)

			const outcome = await waiting
			expect(outcome.kind).toBe('timeout')
			if (outcome.kind !== 'timeout') return
			expect(outcome.cause).toBe('idle')
			expect(waitSignal?.aborted, 'a timed-out wait retained its exit subscription').toBe(true)
			expect(vi.getTimerCount(), 'a timed-out wait retained its polling timer').toBe(0)
			expect(jobs.kill, 'a timed-out wait must never stop the job').not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it('says it went quiet, and that the job was not stopped', () => {
		const text = describeJobWaitTimeout('job_1', {
			kind: 'timeout',
			cause: 'idle',
			elapsedMs: 30_000,
			output: '',
			nextOffset: 12,
			droppedBytes: 0,
			omittedOutputBytes: 0,
		})

		expect(text).toContain('went quiet')
		expect(text).toContain('not been stopped')
	})
})

describe('a bounded wait is an observation that can be resumed', () => {
	it('returns partial output without a tool error, then reads only bytes after next_offset', async () => {
		vi.useFakeTimers()
		try {
			const { jobs, write, finish } = jobFor()
			const context = contextFor(jobs)
			write('BEGIN\n')
			const firstWait = WaitForJobTool.execute(
				{ id: 'job_1', timeout_ms: 15_000, idle_timeout_ms: 1_000 },
				context,
			)
			await vi.advanceTimersByTimeAsync(2_000)
			const first = await firstWait
			expect(first.success).toBe(true)
			expect(first.output).toContain('BEGIN\n')
			expect(first.output).toContain('went quiet')
			expect(first.output).not.toContain('Tool execution failed')
			expect(first.data).toMatchObject({ timedOut: 'idle', nextOffset: 6 })

			write('END\n')
			finish('exited', 0)
			const second = await WaitForJobTool.execute(
				{ id: 'job_1', from_offset: 6, timeout_ms: 15_000 },
				context,
			)
			expect(second.success).toBe(true)
			expect(second.output).toContain('END\n')
			expect(second.output).not.toContain('BEGIN')
			expect(second.data).toMatchObject({ nextOffset: 10, exitCode: 0 })
		} finally {
			vi.useRealTimers()
		}
	})

	it('reports retention loss and resumes at the absolute byte offset', async () => {
		let produced = `${'a'.repeat(100)}TAIL`
		const read = vi.fn((_id: string, opts?: { fromOffset?: number }) => {
			const bytes = Buffer.from(produced)
			const start = bytes.length - 4
			const from = opts?.fromOffset ?? 0
			const effective = Math.max(from, start)
			return {
				chunk: bytes.subarray(effective).toString('utf8'),
				nextOffset: bytes.length,
				droppedBytes: Math.max(0, effective - from),
				status: 'exited',
				exitCode: 0,
			}
		})
		const context = contextFor({
			read,
			waitForExit: async () => ({ id: 'job_1', status: 'exited', exitCode: 0 }),
			kill: vi.fn(),
		})
		const first = await WaitForJobTool.execute({ id: 'job_1' }, context)
		expect(first.output).toContain('100 bytes were dropped')
		expect(first.output).toContain('TAIL')
		expect(first.data).toMatchObject({ droppedBytes: 100, nextOffset: 104 })

		produced += 'NEXT'
		const second = await WaitForJobTool.execute({ id: 'job_1', from_offset: 104 }, context)
		expect(read).toHaveBeenLastCalledWith('job_1', { fromOffset: 104 })
		expect(second.output).toContain('NEXT')
		expect(second.output).not.toContain('TAIL')
		expect(second.data).toMatchObject({ droppedBytes: 0, nextOffset: 108 })
	})

	it('bounds a multibyte stream by UTF-8 bytes and reports the omitted bytes', async () => {
		const { jobs, write, finish } = jobFor()
		write('😀'.repeat(10_000))
		finish()
		const outcome = await waitForJobWithBounds(jobs, 'job_1', {
			wallMs: 60_000,
		})
		expect(outcome.kind).toBe('exited')
		expect(Buffer.byteLength(outcome.output, 'utf8')).toBe(32 * 1024)
		expect(outcome.output).not.toContain('�')
		expect(outcome.omittedOutputBytes).toBe(40_000 - 32 * 1024)
		expect(outcome.nextOffset).toBe(40_000)
		const result = await WaitForJobTool.execute({ id: 'job_1' }, contextFor(jobs))
		expect(result.output).toContain('[7232 earlier bytes omitted from this bounded wait result]')
		expect(result.data).toMatchObject({
			omittedOutputBytes: 7232,
			nextOffset: 40_000,
		})
	})
})

describe('the turn bound still catches a job that never stops', () => {
	it('fires on elapsed time even while output keeps arriving', async () => {
		vi.useFakeTimers()
		try {
			const clock = fakeClock()
			const { jobs, write } = jobFor()

			const waiting = waitForJobWithBounds(
				jobs,
				'job_1',
				{ wallMs: 10_000, idleMs: 5_000 },
				clock.now,
			)

			for (let i = 0; i < 6; i += 1) {
				clock.advance(2_000)
				write(`tick ${i}\n`)
				await vi.advanceTimersByTimeAsync(1_000)
			}

			const outcome = await waiting
			expect(outcome.kind).toBe('timeout')
			if (outcome.kind !== 'timeout') return
			expect(outcome.cause).toBe('wall')
			// A run-bound timeout still hands back what it read on the way.
			expect(outcome.output).toContain('tick 0')
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('an already-exited job', () => {
	it('returns immediately with its full output, without needing a single tick', async () => {
		vi.useFakeTimers()
		try {
			const { jobs, write, finish } = jobFor()
			write('all of it, before anyone waited\n')
			finish('exited', 7)

			// No `advanceTimersByTimeAsync` anywhere in this test: if the
			// result depended on a poll tick firing, this would hang against
			// a fake clock that never moves.
			const outcome = await waitForJobWithBounds(jobs, 'job_1', {
				wallMs: 60_000,
				idleMs: 5_000,
			})
			expect(vi.getTimerCount(), 'a completed wait retained its polling timer').toBe(0)

			expect(outcome.kind).toBe('exited')
			if (outcome.kind !== 'exited') return
			expect(outcome.output).toBe('all of it, before anyone waited\n')
			expect(outcome.exitCode).toBe(7)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('an abandoned wait', () => {
	it('preempts on abort and does not stop the job', async () => {
		vi.useFakeTimers()
		try {
			const controller = new AbortController()
			const { jobs } = jobFor()
			const originalWaitForExit = jobs.waitForExit
			let waitSignal: AbortSignal | undefined
			jobs.waitForExit = (id, opts) => {
				waitSignal = opts?.signal
				return originalWaitForExit(id, opts)
			}

			const waiting = waitForJobWithBounds(jobs, 'job_1', {
				wallMs: 60_000,
				idleMs: 30_000,
				signal: controller.signal,
			})

			const reason = new Error('stop pressed')
			controller.abort(reason)

			await expect(waiting).rejects.toThrow('stop pressed')
			expect(waitSignal?.aborted).toBe(true)
			expect(waitSignal?.reason).toBe(reason)
			expect(vi.getTimerCount(), 'an aborted wait retained its polling timer').toBe(0)
			expect(jobs.kill, 'aborting a WAIT must never stop the WORK').not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it('rejects at once for a signal that was already aborted', async () => {
		const controller = new AbortController()
		controller.abort(new Error('already gone'))
		const { jobs } = jobFor()

		await expect(
			waitForJobWithBounds(jobs, 'job_1', {
				wallMs: 60_000,
				signal: controller.signal,
			}),
		).rejects.toThrow('already gone')
	})
})
