import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPUTER_STOP_CAP_MS, type ShutdownSteps, runShutdown } from './shutdown-sequence.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function build(overrides: Partial<ShutdownSteps> = {}) {
	const log: string[] = []
	const errors: unknown[] = []
	const step = (name: string) => async () => {
		log.push(`${name}:start`)
		await Promise.resolve()
		log.push(`${name}:end`)
	}
	const steps: ShutdownSteps = {
		stopListening: step('listening'),
		shutdownTerminals: step('terminals'),
		closeRuntimes: step('runtimes'),
		disposeSpeech: step('speech'),
		disposeListening: step('dispose-listening'),
		stopComputer: step('computer'),
		closeStreams: step('streams'),
		record: (error) => errors.push(error),
		after: (ms, run) => {
			const timer = setTimeout(run, ms)
			return () => clearTimeout(timer)
		},
		...overrides,
	}
	return { steps, log, errors }
}

describe('runShutdown', () => {
	it('lets the terminals finish before any runtime is stopped', async () => {
		const { steps, log } = build()
		await runShutdown(steps)
		const lastEarly = Math.max(log.indexOf('terminals:end'), log.indexOf('listening:end'))
		for (const name of ['runtimes', 'speech', 'dispose-listening', 'computer', 'streams'])
			expect(log.indexOf(`${name}:start`)).toBeGreaterThan(lastEarly)
	})

	it('runs the independent steps together, not one after another', async () => {
		const { steps, log } = build()
		await runShutdown(steps)
		const starts = ['runtimes', 'speech', 'dispose-listening', 'computer'].map((name) =>
			log.indexOf(`${name}:start`),
		)
		const firstEnd = Math.min(
			...['runtimes', 'speech', 'dispose-listening', 'computer'].map((n) =>
				log.indexOf(`${n}:end`),
			),
		)
		for (const start of starts) expect(start).toBeLessThan(firstEnd)
	})

	it('costs the slowest step, not the sum: 5 s runtime stop with a 5 s machine stop quits in 5 s', async () => {
		const wait = (ms: number) => () => new Promise<void>((resolve) => setTimeout(resolve, ms))
		const { steps } = build({
			stopListening: wait(200),
			shutdownTerminals: wait(300),
			closeRuntimes: wait(5000),
			disposeSpeech: wait(200),
			disposeListening: wait(100),
			stopComputer: wait(5000),
			closeStreams: wait(50),
		})
		const started = Date.now()
		let finished = 0
		const run = runShutdown(steps).then(() => {
			finished = Date.now() - started
		})
		await vi.advanceTimersByTimeAsync(10_000)
		await run
		// Before: 200 + 300 + 5000 + 5000 + 50 = 10 550 ms. Now: 300 + 5000 + 50 (the port after the runtimes).
		expect(finished).toBe(5350)
	})

	it('closes the live port only after the runtimes stopped, so live viewers are released first', async () => {
		const { steps, log } = build()
		await runShutdown(steps)
		expect(log.indexOf('runtimes:end')).toBeLessThan(log.indexOf('streams:start'))
	})

	it('closes the live port even when a runtime could not be confirmed stopped', async () => {
		const { steps, log } = build({ closeRuntimes: () => Promise.reject(new Error('stuck')) })
		await expect(runShutdown(steps)).rejects.toThrow('stuck')
		expect(log).toContain('streams:end')
	})

	it('goes on without a machine stop that never answers, after the cap', async () => {
		const { steps, log } = build({ stopComputer: () => new Promise<void>(() => undefined) })
		let done = false
		const run = runShutdown(steps).then(() => {
			done = true
		})
		await vi.advanceTimersByTimeAsync(COMPUTER_STOP_CAP_MS - 1)
		expect(done).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await run
		expect(done).toBe(true)
		expect(log).toContain('runtimes:end')
	})

	it('does not leave the cap timer behind when the machine stop answers', async () => {
		const { steps } = build()
		await runShutdown(steps)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('records a failed listening or terminal step and still stops the runtimes', async () => {
		const boom = new Error('terminals')
		const { steps, log, errors } = build({ shutdownTerminals: () => Promise.reject(boom) })
		await runShutdown(steps)
		expect(errors).toEqual([boom])
		expect(log).toContain('runtimes:end')
	})

	it('rejects when a runtime did not stop, after the other steps finished', async () => {
		const boom = new Error('could not confirm')
		const { steps, log } = build({ closeRuntimes: () => Promise.reject(boom) })
		await expect(runShutdown(steps)).rejects.toBe(boom)
		expect(log).toContain('streams:end')
		expect(log).toContain('computer:end')
	})

	it('never rejects because of the machine stop', async () => {
		const { steps, errors } = build({ stopComputer: () => Promise.reject(new Error('wsl')) })
		await runShutdown(steps)
		expect(errors).toHaveLength(1)
	})
})
