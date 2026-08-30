import { EventEmitter, getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NOOP_LOGGER } from '../../utils/log/create-logger.js'

interface FakeChild extends EventEmitter {
	pid: number
	stdout: PassThrough
	stderr: PassThrough
	stdio: Array<PassThrough | null>
}

interface SpawnObservation {
	readonly args: readonly string[]
	readonly child: FakeChild
	readonly options: Readonly<Record<string, unknown>>
}

const observations: SpawnObservation[] = []

async function loadProvider(environment: 'basic' | 'linux-bwrap' = 'basic') {
	vi.resetModules()
	observations.length = 0
	vi.doMock('node:child_process', async () => {
		const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
		return {
			...actual,
			spawn: (
				_command: string,
				args: readonly string[],
				options: Readonly<Record<string, unknown>>,
			) => {
				const child = new EventEmitter() as FakeChild
				// Outside any practical host pid range: a late, accidentally retained
				// escalation cannot address an unrelated process after this test.
				child.pid = 2_147_483_000
				child.stdout = new PassThrough()
				child.stderr = new PassThrough()
				child.stdio = [
					new PassThrough(),
					child.stdout,
					child.stderr,
					new PassThrough(),
					new PassThrough(),
				]
				observations.push({ args, child, options })
				return child
			},
			spawnSync: () =>
				environment === 'linux-bwrap'
					? {
							status: 0,
							signal: null,
							stdout: 'namzu-sandbox-spawn-probe',
							stderr: '',
							output: [
								null,
								'namzu-sandbox-spawn-probe',
								'',
								'{ "child-pid": 2147482999 }\n',
								null,
							],
						}
					: {
							error: new Error('wrapper unavailable'),
							status: null,
							signal: null,
							stdout: null,
							stderr: null,
							output: [null, null, null],
						},
		}
	})
	return await import('../provider/local.js')
}

function close(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void {
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

describe('local sandbox cancellation ownership', () => {
	it('still owns cancellation after the direct wrapper exits but shared stdio remains open', async () => {
		vi.useFakeTimers()
		const { LocalSandboxProvider } = await loadProvider()
		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()
		const controller = new AbortController()
		const baseline = getEventListeners(controller.signal, 'abort')
		const kill = vi.spyOn(process, 'kill').mockReturnValue(true)

		try {
			const running = sandbox.exec('ignored', [], {
				timeout: 10,
				signal: controller.signal,
			})
			const observation = observations[0]
			expect(observation).toBeDefined()
			if (!observation) throw new Error('spawn was not observed')

			// This is the schedule Node documents as distinct: the wrapper has
			// exited, but a descendant still owns its copied stdout/stderr fds, so
			// `close` has not happened. Node removes spawn's abort subscription on
			// `exit`; the sandbox must keep its own until terminal settlement.
			observation.child.emit('exit', 0, null)
			controller.abort()
			expect(kill).toHaveBeenCalledWith(-observation.child.pid, 'SIGTERM')
			expect(observation.options).not.toHaveProperty('signal')

			// A deadline that fires while cancellation output drains cannot rewrite
			// the first cause from caller cancellation to timeout.
			await vi.advanceTimersByTimeAsync(10)
			close(observation.child, null, 'SIGTERM')
			const result = await running
			expect(result.timedOut).toBe(false)
			expect(kill.mock.calls).toEqual([
				[-observation.child.pid, 'SIGTERM'],
				[-observation.child.pid, 'SIGKILL'],
			])
			expect(getEventListeners(controller.signal, 'abort')).toEqual(baseline)
		} finally {
			await sandbox.destroy()
		}
	})

	it('releases an unused caller signal when an ordinary command closes', async () => {
		vi.useFakeTimers()
		const { LocalSandboxProvider } = await loadProvider()
		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()
		const controller = new AbortController()
		const baseline = getEventListeners(controller.signal, 'abort')
		const kill = vi.spyOn(process, 'kill').mockReturnValue(true)

		try {
			const running = sandbox.exec('ignored', [], {
				timeout: 60_000,
				signal: controller.signal,
			})
			const observation = observations[0]
			expect(observation).toBeDefined()
			if (!observation) throw new Error('spawn was not observed')

			close(observation.child, 0, null)
			await expect(running).resolves.toMatchObject({ exitCode: 0, timedOut: false })
			expect(getEventListeners(controller.signal, 'abort')).toEqual(baseline)

			controller.abort()
			expect(kill).not.toHaveBeenCalled()
		} finally {
			await sandbox.destroy()
		}
	})

	it('reaches the confined child when cancellation wins before bwrap publishes it', async () => {
		vi.useFakeTimers()
		const { LocalSandboxProvider } = await loadProvider('linux-bwrap')
		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		expect(provider.environment).toBe('linux-bwrap')
		const sandbox = await provider.create()
		const controller = new AbortController()
		const baseline = getEventListeners(controller.signal, 'abort')
		const kill = vi.spyOn(process, 'kill').mockReturnValue(true)

		try {
			const running = sandbox.exec('ignored', [], {
				timeout: 60_000,
				signal: controller.signal,
			})
			const observation = observations[0]
			expect(observation).toBeDefined()
			if (!observation) throw new Error('spawn was not observed')
			expect(observation.args).toContain('--info-fd')
			expect(observation.args).toContain('--block-fd')
			expect(observation.options.stdio).toEqual(['pipe', 'pipe', 'pipe', 'pipe', 'pipe'])

			// The outer wrapper can die before its inner namespace reaper has
			// published a pid. The later status record must inherit the cancellation
			// that already won instead of admitting an unowned process.
			observation.child.emit('exit', 0, null)
			controller.abort()
			expect(kill).not.toHaveBeenCalled()
			expect(observation.child.stdio[4]?.read()).toBeNull()

			const bwrapChildPid = 2_147_482_999
			observation.child.stdio[3]?.write(`{ "child-pid": ${bwrapChildPid} }\n`)
			expect(kill.mock.calls).toEqual([
				[-observation.child.pid, 'SIGKILL'],
				[-bwrapChildPid, 'SIGKILL'],
				[bwrapChildPid, 'SIGKILL'],
			])

			close(observation.child, null, 'SIGTERM')
			await expect(running).resolves.toMatchObject({ timedOut: false })
			expect(kill.mock.calls).toEqual([
				[-observation.child.pid, 'SIGKILL'],
				[-bwrapChildPid, 'SIGKILL'],
				[bwrapChildPid, 'SIGKILL'],
			])
			expect(getEventListeners(controller.signal, 'abort')).toEqual(baseline)
		} finally {
			await sandbox.destroy()
		}
	})

	it('admits a confined command only after recording its inner namespace owner', async () => {
		vi.useFakeTimers()
		const { LocalSandboxProvider } = await loadProvider('linux-bwrap')
		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()

		try {
			const running = sandbox.exec('ignored', [], { timeout: 60_000 })
			const observation = observations[0]
			expect(observation).toBeDefined()
			if (!observation) throw new Error('spawn was not observed')
			expect(observation.child.stdio[4]?.read()).toBeNull()

			observation.child.stdio[3]?.write('{\n  "child-pid": 2147482999\n}\n')
			expect(observation.child.stdio[4]?.read()?.toString('utf8')).toBe('\u0001')

			close(observation.child, 0, null)
			await expect(running).resolves.toMatchObject({ exitCode: 0, timedOut: false })
		} finally {
			await sandbox.destroy()
		}
	})
})
