import type { spawn } from 'node:child_process'
import { EventEmitter, getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackgroundJobOutputWaitLimitError, BackgroundJobRegistry, bindOwner } from '../registry.js'

function fixture(
	config: ConstructorParameters<typeof BackgroundJobRegistry>[0] = {},
	owner = 'owner',
	sharedRegistry?: BackgroundJobRegistry,
) {
	const registry = sharedRegistry ?? new BackgroundJobRegistry(config)
	const child = Object.assign(new EventEmitter(), {
		pid: undefined,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	})
	const kill = vi.fn()
	const job = registry.start({
		owner,
		command: 'synthetic server',
		workingDirectory: process.cwd(),
		spawn: () => ({ child: child as unknown as ReturnType<typeof spawn>, kill }),
	})
	return {
		registry,
		child,
		kill,
		id: job.id,
		wait: (literal = 'READY', opts: Partial<Parameters<typeof registry.waitForOutput>[1]> = {}) =>
			registry.waitForOutput(job.id, { literal, timeoutMs: 1000, ...opts }),
		finish: (code = 0) => child.emit('close', code, null),
	}
}

afterEach(() => vi.useRealTimers())

describe('bounded output readiness on an owned background process', () => {
	it('observes retained output, including an already exited job, without another invocation', async () => {
		const f = fixture()
		f.child.stdout.write('server READY\n')
		expect(await f.wait()).toMatchObject({
			kind: 'matched',
			matchedStream: 'stdout',
			status: 'running',
			nextOffset: 13,
		})
		f.finish(7)
		expect(await f.wait()).toMatchObject({ kind: 'matched', status: 'exited', exitCode: 7 })
		expect(f.registry.list('owner')).toHaveLength(1)
		expect(f.kill).not.toHaveBeenCalled()
	})

	it('joins split chunks and UTF-8 bytes within a pipe, including retained-to-live boundaries', async () => {
		const f = fixture()
		const marker = Buffer.from('準備✓')
		f.child.stdout.write(marker.subarray(0, 1))
		f.child.stdout.write(marker.subarray(1, 4))
		const waiting = f.wait('準備✓')
		f.child.stdout.write(marker.subarray(4, 7))
		f.child.stdout.write(marker.subarray(7))
		expect(await waiting).toMatchObject({
			kind: 'matched',
			matchedStream: 'stdout',
			output: '準備✓',
			nextOffset: marker.length,
			droppedBytes: 0,
		})
		f.finish()
	})

	it('never joins pipes for either, while interleaved output preserves each pipe sequence', async () => {
		const f = fixture()
		f.child.stdout.write('RE')
		f.child.stderr.write('ADY')
		const waiting = f.wait()
		f.child.stderr.write('unrelated')
		f.finish(1)
		expect(await waiting).toMatchObject({ kind: 'exited', exitCode: 1 })
		const g = fixture()
		g.child.stdout.write('RE')
		const live = g.wait()
		g.child.stderr.write('interleaved')
		g.child.stdout.write('ADY')
		expect(await live).toMatchObject({
			kind: 'matched',
			matchedStream: 'stdout',
			output: 'REinterleavedADY',
		})
		g.finish()
	})

	it('respects a selected pipe and treats metacharacters as literals', async () => {
		const f = fixture()
		const waiting = f.wait('R.*Y', { stream: 'stderr' })
		f.child.stdout.write('R.*Y')
		f.child.stderr.write('READY')
		f.child.stderr.write('R.*')
		f.child.stderr.write('Y')
		expect(await waiting).toMatchObject({ kind: 'matched', matchedStream: 'stderr' })
		f.finish()
	})

	it('excludes history before the byte cursor and excludes a partial prefix across it', async () => {
		const f = fixture()
		f.child.stdout.write('READY\nRE')
		const cursor = f.registry.read(f.id).nextOffset
		const waiting = f.wait('READY', { fromOffset: cursor })
		f.child.stdout.write('ADY')
		f.finish()
		expect(await waiting).toMatchObject({ kind: 'exited', output: 'ADY', nextOffset: cursor + 3 })
		const g = fixture()
		g.child.stdout.write('READY')
		const live = g.wait('READY', { fromOffset: 2 })
		g.child.stdout.write(' READY')
		expect(await live).toMatchObject({ kind: 'matched', output: 'ADY READY' })
		g.finish()
	})

	it('reports truncated history and retains valid UTF-8 at a byte cap and cursor', async () => {
		const f = fixture({ maxOutputBytesPerJob: 4 })
		f.child.stdout.write('x準備')
		expect(f.registry.read(f.id)).toMatchObject({ chunk: '備', nextOffset: 7, droppedBytes: 4 })
		expect(f.registry.read(f.id, { fromOffset: 5 })).toMatchObject({
			chunk: '',
			nextOffset: 7,
			droppedBytes: 2,
		})
		f.finish()
		expect(await f.wait('準備')).toMatchObject({ kind: 'exited', output: '備', droppedBytes: 4 })
	})

	it('searches a large live chunk even when normal retention drops its marker', async () => {
		const f = fixture({ maxOutputBytesPerJob: 8 })
		const waiting = f.wait()
		f.child.stdout.write(`READY${'x'.repeat(50)}`)
		expect(await waiting).toMatchObject({
			kind: 'matched',
			output: 'xxxxxxxx',
			nextOffset: 55,
			droppedBytes: 47,
		})
		f.finish()
	})

	it('bounds returned output independently and reports the omitted bytes', async () => {
		const f = fixture()
		const waiting = f.wait()
		f.child.stdout.write('x'.repeat(40_000))
		f.child.stdout.write('READY')
		const result = await waiting
		expect(result.kind).toBe('matched')
		expect(Buffer.byteLength(result.output)).toBe(32 * 1024)
		expect(result.omittedOutputBytes).toBe(40_005 - 32 * 1024)
		f.finish()
	})

	it('reports searchable history lost to the metadata bound instead of fabricating a match', async () => {
		const f = fixture()
		f.child.stdout.write('READY')
		for (let i = 0; i < 4096; i++) f.child.stderr.write('x')
		f.finish()
		expect(await f.wait()).toMatchObject({ kind: 'exited', droppedBytes: 0, unsearchedBytes: 5 })
	})

	it('keeps independent concurrent observers; one cancellation does not detach the other', async () => {
		vi.useFakeTimers()
		const f = fixture({ maxOutputWaitersPerOwner: 2 })
		const abort = new AbortController()
		const one = f.wait('ONE', { signal: abort.signal })
		const two = f.wait('TWO')
		abort.abort()
		expect(await one).toMatchObject({ kind: 'aborted', status: 'running' })
		f.child.stderr.write('T')
		f.child.stdout.write('ONE')
		f.child.stderr.write('WO')
		expect(await two).toMatchObject({ kind: 'matched', matchedStream: 'stderr' })
		expect(vi.getTimerCount()).toBe(0)
		expect(f.kill).not.toHaveBeenCalled()
		f.finish()
	})

	it('enforces owner and global subscription bounds and releases them at every outcome', async () => {
		vi.useFakeTimers()
		const f = fixture({ maxOutputWaiters: 1, maxOutputWaitersPerOwner: 1 })
		const abort = new AbortController()
		const waiting = f.wait('one', { signal: abort.signal })
		expect(() => f.wait('two')).toThrow(BackgroundJobOutputWaitLimitError)
		abort.abort()
		await waiting
		const next = f.wait('two', { timeoutMs: 3 })
		await vi.advanceTimersByTimeAsync(3)
		expect(await next).toMatchObject({ kind: 'timeout', cause: 'wall' })
		const last = f.wait('three')
		f.finish()
		expect(await last).toMatchObject({ kind: 'exited' })
		expect(vi.getTimerCount()).toBe(0)
	})

	it('uses event-driven idle progress from either pipe but never moves the wall bound', async () => {
		vi.useFakeTimers()
		const f = fixture()
		const waiting = f.wait('READY', { stream: 'stdout', timeoutMs: 10, idleTimeoutMs: 4 })
		await vi.advanceTimersByTimeAsync(3)
		f.child.stderr.write('progress')
		await vi.advanceTimersByTimeAsync(3)
		f.child.stderr.write('progress')
		await vi.advanceTimersByTimeAsync(3)
		f.child.stderr.write('progress')
		await vi.advanceTimersByTimeAsync(1)
		expect(await waiting).toMatchObject({
			kind: 'timeout',
			cause: 'wall',
			elapsedMs: 10,
			status: 'running',
		})
		const quiet = f.wait('READY', { timeoutMs: 20, idleTimeoutMs: 4 })
		await vi.advanceTimersByTimeAsync(4)
		expect(await quiet).toMatchObject({ kind: 'timeout', cause: 'idle', elapsedMs: 4 })
		expect(vi.getTimerCount()).toBe(0)
		f.finish()
	})

	it('keeps the admitted idle bound when a caller mutates its options later', async () => {
		vi.useFakeTimers()
		const f = fixture()
		const options = { literal: 'READY', timeoutMs: 1000, idleTimeoutMs: 4 }
		const waiting = f.registry.waitForOutput(f.id, options)
		await vi.advanceTimersByTimeAsync(3)
		options.idleTimeoutMs = 3_600_000
		options.literal = 'progress'
		f.child.stdout.write('progress')
		await vi.advanceTimersByTimeAsync(4)
		expect(await waiting).toMatchObject({
			kind: 'timeout',
			cause: 'idle',
			elapsedMs: 7,
			status: 'running',
		})
		expect(vi.getTimerCount()).toBe(0)
		f.finish()
	})

	it('bounds observers across different owners and removes long-lived signal subscriptions', async () => {
		vi.useFakeTimers()
		const f = fixture({ maxOutputWaiters: 1 })
		const g = fixture({}, 'other', f.registry)
		const controller = new AbortController()
		const waiting = f.wait('READY', { signal: controller.signal, timeoutMs: 5 })
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
		expect(() => g.wait()).toThrow(
			expect.objectContaining({ details: { owner: 'other', limit: 1, scope: 'registry' } }),
		)
		await vi.advanceTimersByTimeAsync(5)
		expect(await waiting).toMatchObject({ kind: 'timeout' })
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
		const next = g.wait('READY', { signal: controller.signal })
		g.child.stdout.write('READY')
		expect(await next).toMatchObject({ kind: 'matched' })
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
		expect(vi.getTimerCount()).toBe(0)
		f.finish()
		g.finish()
	})

	it('settles observers as stopped as soon as shutdown is requested, without claiming completed shutdown', async () => {
		vi.useFakeTimers()
		const f = fixture()
		const waiting = f.wait()
		const killing = f.registry.kill(f.id)
		expect(await waiting).toMatchObject({ kind: 'stopped', status: 'killed' })
		expect(f.registry.get(f.id).exitedAt).toBeUndefined()
		f.finish()
		await killing
		expect(vi.getTimerCount()).toBe(0)
	})

	it('denies cross-owner observation and validates explicit bounds before subscribing', async () => {
		const f = fixture()
		expect(() =>
			bindOwner(f.registry, 'other').waitForOutput(f.id, { literal: 'READY', timeoutMs: 10 }),
		).toThrow(`No background job ${f.id}`)
		for (const literal of ['', '\ud800', 'x'.repeat(4097)])
			expect(() => f.wait(literal)).toThrow('UTF-8')
		expect(() => f.wait('READY', { timeoutMs: 0 })).toThrow('timeoutMs')
		expect(() => f.wait('READY', { timeoutMs: 3_600_001 })).toThrow('timeoutMs')
		expect(() => f.wait('READY', { idleTimeoutMs: -1 })).toThrow('idleTimeoutMs')
		expect(() => f.wait('READY', { fromOffset: 1 })).toThrow('fromOffset')
		f.finish()
	})
})
