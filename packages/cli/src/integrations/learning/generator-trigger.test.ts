import type { LearningModel } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import type { GeneratorOutcome, GeneratorRunOptions } from './generator-run.js'
import { resolveGeneratorSettings } from './generator-settings.js'
import {
	type BackgroundLearningOptions,
	createBackgroundLearning,
	withBackgroundLearning,
} from './generator-trigger.js'
import type { SessionLearningTarget } from './session-store.js'

const target = {} as SessionLearningTarget
const reply = { text: 'ok', tokens: 1, costUsd: null }
const skipped: GeneratorOutcome = { status: 'skipped', reason: 'few-observations' }

function setup(over: Partial<BackgroundLearningOptions> = {}) {
	let clock = 1_000_000
	const runs: GeneratorRunOptions[] = []
	const settled: Promise<unknown>[] = []
	const options: BackgroundLearningOptions = {
		settings: resolveGeneratorSettings(undefined),
		openTarget: () => target,
		learning: { model: async () => reply, route: async () => 'p/m' },
		flushObservations: async () => {},
		now: () => clock,
		run: async (run) => {
			runs.push(run)
			return skipped
		},
		...over,
	}
	const bg = createBackgroundLearning(options)
	return {
		bg,
		runs,
		settled,
		advance: (ms: number) => {
			clock += ms
		},
	}
}
const idle = async (bg: ReturnType<typeof createBackgroundLearning>) => {
	await bg.stop()
}

describe('background learning', () => {
	it('checks once a turn ends, in automatic mode, on the configured route', async () => {
		const { bg, runs } = setup()
		bg.turnStarted()
		bg.turnEnded()
		await idle(bg)
		expect(runs).toHaveLength(1)
		expect(runs[0]).toMatchObject({ mode: 'automatic' })
		expect(await (runs[0]?.route as () => Promise<string>)()).toBe('p/m')
	})

	it('does nothing when learning is turned off', async () => {
		const { bg, runs } = setup({ settings: resolveGeneratorSettings(false) })
		bg.turnStarted()
		bg.turnEnded()
		await idle(bg)
		expect(runs).toHaveLength(0)
	})

	it('does nothing when the project has kept nothing yet', async () => {
		const { bg, runs } = setup({ openTarget: () => null })
		bg.turnStarted()
		bg.turnEnded()
		await idle(bg)
		expect(runs).toHaveLength(0)
	})

	it('waits for the last open turn before it looks', async () => {
		const { bg, runs } = setup()
		bg.turnStarted()
		bg.turnStarted()
		bg.turnEnded()
		expect(runs).toHaveLength(0)
		bg.turnEnded()
		await idle(bg)
		expect(runs).toHaveLength(1)
	})

	it('looks again only after the check interval', async () => {
		const { bg, runs, advance } = setup()
		for (const gap of [0, 60_000, 11 * 60_000]) {
			advance(gap)
			bg.turnStarted()
			bg.turnEnded()
			// Let the pending check settle before the next turn ends.
			await new Promise((resolve) => setImmediate(resolve))
		}
		expect(runs).toHaveLength(2)
		await idle(bg)
	})

	it('holds a model call while a turn is open and sends it once the conversation is idle', async () => {
		const sent: string[] = []
		let started!: () => void
		const reached = new Promise<void>((resolve) => {
			started = resolve
		})
		const learning = {
			model: (async (request) => {
				sent.push(request.prompt)
				return reply
			}) as LearningModel,
			route: async () => 'p/m',
		}
		let finished!: (value: unknown) => void
		const done = new Promise((resolve) => {
			finished = resolve
		})
		const { bg } = setup({
			learning,
			run: async ({ model, signal }) => {
				started()
				const answer = await model({ system: 's', prompt: 'p', maxTokens: 1, signal })
				finished(answer)
				return skipped
			},
		})
		bg.turnStarted()
		bg.turnEnded()
		await reached
		// A new turn begins before the call is made; the call waits for it.
		bg.turnStarted()
		await new Promise((resolve) => setImmediate(resolve))
		expect(sent).toEqual([])
		bg.turnEnded()
		await done
		expect(sent).toEqual(['p'])
		await idle(bg)
	})

	it('stops a cycle that is waiting when the session closes', async () => {
		let outcome: unknown = 'pending'
		let waiting!: () => void
		const reached = new Promise<void>((resolve) => {
			waiting = resolve
		})
		const { bg } = setup({
			run: async ({ model, signal }) => {
				waiting()
				try {
					await model({ system: 's', prompt: 'p', maxTokens: 1, signal })
					outcome = 'answered'
				} catch (error) {
					outcome = (error as Error).message
				}
				return skipped
			},
		})
		bg.turnStarted()
		bg.turnEnded()
		await reached
		bg.turnStarted()
		await bg.stop()
		expect(outcome).toBe('The session closed.')
	})

	it('reports a cycle that reached a verdict', async () => {
		const seen: unknown[] = []
		const ran = {
			status: 'ran',
			cycle: { status: 'activated' },
			proposal: null,
			tokens: 3,
		} as never
		const { bg } = setup({ run: async () => ran, onOutcome: (o) => seen.push(o) })
		bg.turnStarted()
		bg.turnEnded()
		await idle(bg)
		expect(seen).toEqual([ran])
	})

	it('tells the host once for a cycle, however many turns end within the interval', async () => {
		const seen: unknown[] = []
		const ran = {
			status: 'ran',
			cycle: { status: 'activated' },
			proposal: null,
			tokens: 3,
		} as never
		const { bg, advance } = setup({ run: async () => ran, onOutcome: (o) => seen.push(o) })
		for (let i = 0; i < 4; i++) {
			bg.turnStarted()
			bg.turnEnded()
			advance(1_000)
			await Promise.resolve()
		}
		await idle(bg)
		expect(seen).toHaveLength(1)
	})

	it('never calls the model while the setting is off', async () => {
		let calls = 0
		const { bg, runs } = setup({
			settings: resolveGeneratorSettings({ enabled: false }),
			learning: {
				model: async () => {
					calls++
					return reply
				},
				route: async () => 'p/m',
			},
		})
		bg.turnStarted()
		bg.turnEnded()
		await idle(bg)
		expect(runs).toHaveLength(0)
		expect(calls).toBe(0)
	})

	it('swallows a failing check so the conversation never sees it', async () => {
		const { bg } = setup({
			run: async () => {
				throw new Error('disk full')
			},
		})
		bg.turnStarted()
		bg.turnEnded()
		await expect(bg.stop()).resolves.toBeUndefined()
	})
})

describe('withBackgroundLearning', () => {
	function fake() {
		const log: string[] = []
		const session = {
			async *send(text: string) {
				log.push(`send ${text}`)
				yield { kind: 'a' }
				yield { kind: 'done' }
			},
			async *resumePaused() {
				yield { kind: 'resumed' }
			},
			async close() {
				log.push('close')
			},
			label: 'kept',
		}
		return { session, log }
	}
	const counter = () => {
		const log: string[] = []
		return {
			log,
			bg: {
				turnStarted: () => log.push('start'),
				turnEnded: () => log.push('end'),
				stop: async () => {
					log.push('stop')
				},
			},
		}
	}

	it('counts each turn and passes every event through', async () => {
		const { session } = fake()
		const { bg, log } = counter()
		const watched = withBackgroundLearning(session, bg)
		const events: unknown[] = []
		for await (const event of watched.send('hi' as never)) events.push(event)
		for await (const event of watched.resumePaused()) events.push(event)
		expect(events).toEqual([{ kind: 'a' }, { kind: 'done' }, { kind: 'resumed' }])
		expect(log).toEqual(['start', 'end', 'start', 'end'])
		expect(watched.label).toBe('kept')
	})

	it('ends the turn even when the reader stops early', async () => {
		const { session } = fake()
		const { bg, log } = counter()
		const watched = withBackgroundLearning(session, bg)
		for await (const _ of watched.send('hi' as never)) break
		expect(log).toEqual(['start', 'end'])
	})

	it('stops the cycle before the session closes', async () => {
		const { session, log } = fake()
		const { bg, log: calls } = counter()
		const watched = withBackgroundLearning(session, bg)
		await watched.close()
		expect(calls).toEqual(['stop'])
		expect(log).toEqual(['close'])
	})
})
