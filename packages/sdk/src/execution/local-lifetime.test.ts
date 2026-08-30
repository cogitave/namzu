import { EventEmitter, getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeChild extends EventEmitter {
	pid: number
	stdout: PassThrough
	stderr: PassThrough
}

interface SpawnObservation {
	readonly child: FakeChild
	readonly options: Readonly<Record<string, unknown>>
}

const observations: SpawnObservation[] = []

async function loadLocalExecutionContext() {
	vi.resetModules()
	observations.length = 0
	vi.doMock('node:child_process', async () => {
		const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
		return {
			...actual,
			spawn: (
				_command: string,
				_args: readonly string[],
				options: Readonly<Record<string, unknown>>,
			) => {
				const child = new EventEmitter() as FakeChild
				// Outside practical host pid allocation. A retained timer must never
				// address an unrelated process after this fixture closes.
				child.pid = 2_147_483_000 + observations.length
				child.stdout = new PassThrough()
				child.stderr = new PassThrough()
				observations.push({ child, options })
				return child
			},
		}
	})
	return (await import('./local.js')).LocalExecutionContext
}

function close(child: FakeChild, code: number | null, signal: NodeJS.Signals | null = null): void {
	child.stdout.end()
	child.stderr.end()
	child.emit('close', code, signal)
}

afterEach(() => {
	vi.clearAllTimers()
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.doUnmock('node:child_process')
	vi.resetModules()
})

describe.skipIf(process.platform === 'win32')('LocalExecutionContext command lifetime', () => {
	it('owns the deadline after direct-child exit until inherited stdio closes', async () => {
		vi.useFakeTimers()
		const LocalExecutionContext = await loadLocalExecutionContext()
		const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })

		const running = context.executeCommand('ignored', [], { timeoutMs: 10 })
		const observation = observations[0]
		expect(observation).toBeDefined()
		if (!observation) throw new Error('spawn was not observed')

		expect(observation.options).toMatchObject({ detached: true })
		expect(observation.options).not.toHaveProperty('timeout')
		expect(observation.options).not.toHaveProperty('signal')

		// Node's direct child has gone, but a descendant can still own the
		// copied stdout/stderr descriptors. The deadline owner must remain live.
		observation.child.emit('exit', 0, null)
		await vi.advanceTimersByTimeAsync(10)
		expect(kill).toHaveBeenCalledWith(-observation.child.pid, 'SIGTERM')

		close(observation.child, null)
		await expect(running).resolves.toMatchObject({
			exitCode: null,
			termination: { origin: 'timeout', admitted: true },
		})
		expect(kill.mock.calls).toEqual([
			[-observation.child.pid, 'SIGTERM'],
			[-observation.child.pid, 'SIGKILL'],
		])

		await vi.advanceTimersByTimeAsync(3_000)
		expect(kill).toHaveBeenCalledTimes(2)
	})

	it('fences new commands synchronously and waits for every admitted close', async () => {
		vi.useFakeTimers()
		const LocalExecutionContext = await loadLocalExecutionContext()
		const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })

		const running = context.executeCommand('held', [], { timeoutMs: 60_000 })
		const observation = observations[0]
		expect(observation).toBeDefined()
		if (!observation) throw new Error('spawn was not observed')

		let teardownSettled = false
		const teardown = context.teardown().then(() => {
			teardownSettled = true
		})
		expect(kill).toHaveBeenCalledWith(-observation.child.pid, 'SIGTERM')
		const tooLate = context.executeCommand('too-late')
		expect(observations).toHaveLength(1)
		await expect(tooLate).rejects.toThrow('tearing down or torn down')
		await Promise.resolve()
		expect(teardownSettled).toBe(false)

		close(observation.child, null)
		await expect(running).resolves.toMatchObject({
			exitCode: null,
			termination: { origin: 'teardown', admitted: true },
		})
		await teardown
		expect(teardownSettled).toBe(true)

		// Constructor-to-execute is a supported front door, and explicit
		// initialization likewise reopens a context after teardown.
		await context.initialize()
		const reopened = context.executeCommand('reopened', [], { timeoutMs: 0 })
		const reopenedObservation = observations[1]
		expect(reopenedObservation).toBeDefined()
		if (!reopenedObservation) throw new Error('reopened spawn was not observed')
		close(reopenedObservation.child, 0)
		await expect(reopened).resolves.toMatchObject({ exitCode: 0 })
	})

	it('clears an ordinary deadline and keeps timeout zero unbounded', async () => {
		vi.useFakeTimers()
		const LocalExecutionContext = await loadLocalExecutionContext()
		const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })

		const ordinary = context.executeCommand('ordinary', [], { timeoutMs: 10 })
		const ordinaryObservation = observations[0]
		expect(ordinaryObservation).toBeDefined()
		if (!ordinaryObservation) throw new Error('ordinary spawn was not observed')
		close(ordinaryObservation.child, 0)
		const ordinaryResult = await ordinary
		expect(ordinaryResult).toMatchObject({ exitCode: 0, stdout: '', stderr: '' })
		expect(ordinaryResult).not.toHaveProperty('termination')

		const unbounded = context.executeCommand('unbounded', [], { timeoutMs: 0 })
		const unboundedObservation = observations[1]
		expect(unboundedObservation).toBeDefined()
		if (!unboundedObservation) throw new Error('unbounded spawn was not observed')
		await vi.advanceTimersByTimeAsync(60_000)
		expect(kill).not.toHaveBeenCalled()
		close(unboundedObservation.child, 0)
		await expect(unbounded).resolves.toMatchObject({ exitCode: 0 })
	})

	it('refuses a pre-aborted caller before spawn with an explicit not-admitted result', async () => {
		const LocalExecutionContext = await loadLocalExecutionContext()
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })
		const caller = new AbortController()
		caller.abort(new Error('do not start'))

		const result = context.executeCommand('never', [], { timeoutMs: 0, signal: caller.signal })
		expect(observations).toEqual([])
		await expect(result).resolves.toEqual({
			exitCode: null,
			stdout: '',
			stderr: '',
			durationMs: 0,
			termination: { origin: 'caller', admitted: false },
		})
	})

	it('owns caller cancellation through close and records the actual close signal', async () => {
		vi.useFakeTimers()
		const LocalExecutionContext = await loadLocalExecutionContext()
		const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })
		const caller = new AbortController()

		let settled = false
		const running = context
			.executeCommand('held', [], { timeoutMs: 60_000, signal: caller.signal })
			.then((result) => {
				settled = true
				return result
			})
		const observation = observations[0]
		expect(observation).toBeDefined()
		if (!observation) throw new Error('spawn was not observed')

		caller.abort(new Error('stop'))
		expect(kill).toHaveBeenCalledWith(-observation.child.pid, 'SIGTERM')
		await Promise.resolve()
		expect(settled).toBe(false)

		close(observation.child, null, 'SIGKILL')
		await expect(running).resolves.toMatchObject({
			exitCode: null,
			termination: { origin: 'caller', admitted: true, signal: 'SIGKILL' },
		})
		expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
	})

	it('detaches an untriggered caller signal after ordinary completion', async () => {
		const LocalExecutionContext = await loadLocalExecutionContext()
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })
		const caller = new AbortController()

		const running = context.executeCommand('ordinary', [], {
			timeoutMs: 0,
			signal: caller.signal,
		})
		const observation = observations[0]
		expect(observation).toBeDefined()
		if (!observation) throw new Error('spawn was not observed')
		expect(getEventListeners(caller.signal, 'abort')).toHaveLength(1)

		close(observation.child, 0)
		await expect(running).resolves.toMatchObject({ exitCode: 0 })
		expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
	})

	it('latches timeout before a later caller abort', async () => {
		vi.useFakeTimers()
		const LocalExecutionContext = await loadLocalExecutionContext()
		vi.spyOn(process, 'kill').mockReturnValue(true)
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })
		const caller = new AbortController()

		const running = context.executeCommand('expiring', [], {
			timeoutMs: 10,
			signal: caller.signal,
		})
		const observation = observations[0]
		expect(observation).toBeDefined()
		if (!observation) throw new Error('spawn was not observed')

		await vi.advanceTimersByTimeAsync(10)
		caller.abort(new Error('too late'))
		close(observation.child, null, 'SIGTERM')

		await expect(running).resolves.toMatchObject({
			termination: { origin: 'timeout', admitted: true, signal: 'SIGTERM' },
		})
	})

	it('latches caller cancellation before a later timeout', async () => {
		vi.useFakeTimers()
		const LocalExecutionContext = await loadLocalExecutionContext()
		vi.spyOn(process, 'kill').mockReturnValue(true)
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })
		const caller = new AbortController()

		const running = context.executeCommand('cancelled-first', [], {
			timeoutMs: 10,
			signal: caller.signal,
		})
		const observation = observations[0]
		expect(observation).toBeDefined()
		if (!observation) throw new Error('spawn was not observed')

		caller.abort(new Error('first cause'))
		await vi.advanceTimersByTimeAsync(10)
		close(observation.child, null, 'SIGTERM')

		await expect(running).resolves.toMatchObject({
			termination: { origin: 'caller', admitted: true, signal: 'SIGTERM' },
		})
	})

	it('does not invent a Namzu termination for an externally signalled child', async () => {
		const LocalExecutionContext = await loadLocalExecutionContext()
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })

		const running = context.executeCommand('self-signalled', [], { timeoutMs: 0 })
		const observation = observations[0]
		expect(observation).toBeDefined()
		if (!observation) throw new Error('spawn was not observed')
		close(observation.child, null, 'SIGTERM')

		const result = await running
		expect(result).toMatchObject({ exitCode: null, stdout: '', stderr: '' })
		expect(result).not.toHaveProperty('termination')
	})

	it('keeps concurrent command lifetimes independent', async () => {
		vi.useFakeTimers()
		const LocalExecutionContext = await loadLocalExecutionContext()
		const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })

		const expiring = context.executeCommand('expiring', [], { timeoutMs: 10 })
		const held = context.executeCommand('held', [], { timeoutMs: 60_000 })
		const expiringObservation = observations[0]
		const heldObservation = observations[1]
		expect(expiringObservation).toBeDefined()
		expect(heldObservation).toBeDefined()
		if (!expiringObservation || !heldObservation) throw new Error('both spawns were not observed')

		await vi.advanceTimersByTimeAsync(10)
		expect(kill.mock.calls).toEqual([[-expiringObservation.child.pid, 'SIGTERM']])
		close(expiringObservation.child, null)
		await expiring

		const teardown = context.teardown()
		expect(kill).toHaveBeenCalledWith(-heldObservation.child.pid, 'SIGTERM')
		close(heldObservation.child, null)
		await held
		await teardown
	})

	it('rejects an invalid deadline before spawning', async () => {
		const LocalExecutionContext = await loadLocalExecutionContext()
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })

		await expect(context.executeCommand('never', [], { timeoutMs: -1 })).rejects.toThrow(
			'unsigned integer',
		)
		expect(observations).toEqual([])
	})

	it('keeps deadline validation ahead of pre-abort classification', async () => {
		const LocalExecutionContext = await loadLocalExecutionContext()
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })
		const caller = new AbortController()
		caller.abort()

		await expect(
			context.executeCommand('never', [], { timeoutMs: -1, signal: caller.signal }),
		).rejects.toThrow('unsigned integer')
		expect(observations).toEqual([])
	})

	it('keeps command admission closed after initialization fails', async () => {
		const LocalExecutionContext = await loadLocalExecutionContext()
		const context = new LocalExecutionContext({
			id: 'missing-cwd',
			cwd: `${process.cwd()}/does-not-exist`,
		})

		await expect(context.initialize()).rejects.toThrow('Working directory does not exist')
		await expect(context.executeCommand('never')).rejects.toThrow(
			'Call initialize() before executing another command',
		)
		expect(observations).toEqual([])
	})

	it('retains a spawn error until close and settles exactly once', async () => {
		vi.useFakeTimers()
		const LocalExecutionContext = await loadLocalExecutionContext()
		const context = new LocalExecutionContext({ id: 'local', cwd: process.cwd() })

		let settled = 0
		const running = context.executeCommand('missing', [], { timeoutMs: 60_000 }).then((result) => {
			settled++
			return result
		})
		const observation = observations[0]
		expect(observation).toBeDefined()
		if (!observation) throw new Error('spawn was not observed')

		observation.child.emit('error', new Error('spawn failed'))
		await Promise.resolve()
		expect(settled).toBe(0)

		close(observation.child, -2)
		await expect(running).resolves.toMatchObject({ exitCode: 1, stderr: 'spawn failed' })
		expect(settled).toBe(1)
	})
})
