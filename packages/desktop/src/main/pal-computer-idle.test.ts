import { describe, expect, it, vi } from 'vitest'
import { IdleStopper } from './pal-computer-idle.js'

/** A clock the test moves by hand: `advance` runs what became due. */
function clock() {
	let now = 0
	const timers = new Map<number, { at: number; run: () => void }>()
	let next = 0
	return {
		schedule: (ms: number, run: () => void) => {
			const id = next++
			timers.set(id, { at: now + ms, run })
			return () => void timers.delete(id)
		},
		advance: async (ms: number) => {
			now += ms
			for (const [id, timer] of [...timers])
				if (timer.at <= now) {
					timers.delete(id)
					timer.run()
				}
			await Promise.resolve()
			await Promise.resolve()
		},
		pending: () => timers.size,
	}
}

function make(answer: 'stopped' | 'busy' | 'not-running' | 'failed' = 'stopped') {
	const time = clock()
	const stop = vi.fn(async () => answer)
	const idle = new IdleStopper({ delayMs: 600_000, stop, schedule: time.schedule })
	return { time, stop, idle }
}

describe('IdleStopper', () => {
	it('stops the machine after ten quiet minutes, not before', async () => {
		const { time, stop, idle } = make()
		idle.start()
		await time.advance(599_999)
		expect(stop).not.toHaveBeenCalled()
		await time.advance(1)
		expect(stop).toHaveBeenCalledTimes(1)
	})

	it('does not count down while a Pal computer runs, and starts again when the last one stops', async () => {
		const { time, stop, idle } = make()
		idle.start()
		idle.observe('kiro', true)
		expect(time.pending()).toBe(0)
		await time.advance(3_600_000)
		expect(stop).not.toHaveBeenCalled()
		idle.observe('kiro', false)
		await time.advance(599_999)
		expect(stop).not.toHaveBeenCalled()
		await time.advance(1)
		expect(stop).toHaveBeenCalledTimes(1)
	})

	it('waits for every Pal computer to stop', async () => {
		const { time, stop, idle } = make()
		idle.start()
		idle.observe('kiro', true)
		idle.observe('mo', true)
		idle.observe('kiro', false)
		await time.advance(700_000)
		expect(stop).not.toHaveBeenCalled()
		idle.observe('mo', false)
		await time.advance(600_000)
		expect(stop).toHaveBeenCalledTimes(1)
	})

	it('looks again after another quiet period when the machine says it is busy', async () => {
		const { time, stop, idle } = make('busy')
		idle.start()
		await time.advance(600_000)
		expect(stop).toHaveBeenCalledTimes(1)
		await time.advance(600_000)
		expect(stop).toHaveBeenCalledTimes(2)
	})

	it('does not look again after it stopped the machine', async () => {
		const { time, stop, idle } = make('stopped')
		idle.start()
		await time.advance(600_000)
		await time.advance(6_000_000)
		expect(stop).toHaveBeenCalledTimes(1)
	})

	it('does not stop the machine while a setup runs, and looks again later', async () => {
		const time = clock()
		let busy = true
		const stop = vi.fn(async () => 'stopped' as const)
		const idle = new IdleStopper({
			delayMs: 600_000,
			stop,
			schedule: time.schedule,
			busy: () => busy,
		})
		idle.start()
		await time.advance(600_000)
		expect(stop).not.toHaveBeenCalled()
		busy = false
		await time.advance(600_000)
		expect(stop).toHaveBeenCalledTimes(1)
	})

	it('stops once on quit when nothing runs, and never when something does', async () => {
		const quiet = make()
		quiet.idle.start()
		await quiet.idle.stopForQuit()
		expect(quiet.stop).toHaveBeenCalledTimes(1)
		await quiet.time.advance(6_000_000)
		expect(quiet.stop).toHaveBeenCalledTimes(1)

		const busy = make()
		busy.idle.start()
		busy.idle.observe('kiro', true)
		await busy.idle.stopForQuit()
		expect(busy.stop).not.toHaveBeenCalled()
	})

	it('is silent before start and after dispose', async () => {
		const { time, stop, idle } = make()
		idle.observe('kiro', true)
		idle.observe('kiro', false)
		await time.advance(6_000_000)
		expect(stop).not.toHaveBeenCalled()
		idle.start()
		idle.dispose()
		await time.advance(6_000_000)
		expect(stop).not.toHaveBeenCalled()
	})
})
