import { describe, expect, it } from 'vitest'
import {
	type BatteryWatch,
	type PowerBlocker,
	SleepGuard,
	type SleepWishes,
} from './sleep-guard.js'

function setup(initial: Partial<SleepWishes> = {}) {
	let next = 1
	const live = new Set<number>()
	const blocker: PowerBlocker = {
		start: () => {
			live.add(next)
			return next++
		},
		stop: (id) => void live.delete(id),
		isStarted: (id) => live.has(id),
	}
	let onBattery = false
	let listener: (() => void) | undefined
	const battery: BatteryWatch = {
		onBattery: () => onBattery,
		subscribe: (run) => {
			listener = run
			return () => {
				listener = undefined
			}
		},
	}
	let working = 0
	const wishes: SleepWishes = { appOpen: false, whileWorking: false, onBattery: false, ...initial }
	const guard = new SleepGuard(
		blocker,
		battery,
		() => working,
		() => wishes,
	)
	return {
		guard,
		live,
		wishes,
		work: (count: number) => {
			working = count
			guard.update()
		},
		unplug: (value: boolean) => {
			onBattery = value
			listener?.()
		},
	}
}

describe('the sleep guard', () => {
	it('holds nothing while no wish is on', () => {
		const run = setup()
		run.guard.start()
		run.work(2)
		expect(run.live.size).toBe(0)
	})

	it('holds the computer awake for as long as the app is open, and lets go when switched off', () => {
		const run = setup({ appOpen: true })
		run.guard.start()
		expect(run.guard.holding()).toEqual({ appOpen: true, working: false })
		run.guard.update()
		expect(run.live.size).toBe(1)
		run.wishes.appOpen = false
		run.guard.update()
		expect(run.live.size).toBe(0)
	})

	it('holds while a conversation works and lets go when none does', () => {
		const run = setup({ whileWorking: true })
		run.guard.start()
		expect(run.live.size).toBe(0)
		run.work(1)
		expect(run.guard.holding().working).toBe(true)
		run.work(3)
		expect(run.live.size).toBe(1)
		run.work(0)
		expect(run.live.size).toBe(0)
	})

	it('on battery holds only when the person said so, and follows the power source', () => {
		const run = setup({ whileWorking: true })
		run.guard.start()
		run.work(1)
		expect(run.live.size).toBe(1)
		run.unplug(true)
		expect(run.live.size).toBe(0)
		run.wishes.onBattery = true
		run.guard.update()
		expect(run.live.size).toBe(1)
		run.wishes.onBattery = false
		run.guard.update()
		run.unplug(false)
		expect(run.live.size).toBe(1)
	})

	it('keeps the two reasons apart: one ending leaves the other holding', () => {
		const run = setup({ appOpen: true, whileWorking: true })
		run.guard.start()
		run.work(1)
		expect(run.live.size).toBe(2)
		run.work(0)
		expect(run.guard.holding()).toEqual({ appOpen: true, working: false })
		expect(run.live.size).toBe(1)
	})

	it('lets everything go when closed and stops listening', () => {
		const run = setup({ appOpen: true, whileWorking: true })
		run.guard.start()
		run.work(1)
		run.guard.close()
		expect(run.live.size).toBe(0)
		run.unplug(true)
		expect(run.live.size).toBe(0)
	})
})
