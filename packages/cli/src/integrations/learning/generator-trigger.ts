import type { LearningModel } from '@namzu/sdk'
import {
	type GeneratorOutcome,
	type GeneratorRunOptions,
	runGeneratorCycle,
} from './generator-run.js'
import type { LearningGeneratorSettings } from './generator-settings.js'
import type { SessionLearningTarget } from './session-store.js'

/**
 * Learning that happens by itself. After a turn ends, and while no turn is in
 * progress, the project's kept observations are checked; when enough new ones
 * have accumulated and the pause and the daily allowance allow it, one cycle
 * runs in the background of the session. It waits for an idle conversation
 * before every model call, so it never competes with the person's own turn,
 * and a session that closes stops it.
 */

/** Look again at most this often, however many turns end. */
const CHECK_EVERY_MS = 10 * 60 * 1000

export interface BackgroundLearningOptions {
	readonly settings: LearningGeneratorSettings
	/** The observation store of this project, opened for writing, or null when it has none yet. */
	readonly openTarget: () => SessionLearningTarget | null
	readonly learning: {
		readonly model: LearningModel
		readonly route: (signal: AbortSignal) => Promise<string>
	}
	/** Resolves once every observation offered so far is on disk. */
	readonly flushObservations: () => Promise<void>
	readonly now?: () => number
	readonly run?: (options: GeneratorRunOptions) => Promise<GeneratorOutcome>
	/** Told after a cycle that reached a verdict, for a plain line the host may show. */
	readonly onOutcome?: (outcome: Extract<GeneratorOutcome, { status: 'ran' }>) => void
}

export interface BackgroundLearning {
	turnStarted(): void
	turnEnded(): void
	/** Aborts a running cycle and resolves when it has settled. */
	stop(): Promise<void>
}

export function createBackgroundLearning(options: BackgroundLearningOptions): BackgroundLearning {
	const now = options.now ?? Date.now
	const controller = new AbortController()
	let active = 0
	let running: Promise<void> | null = null
	let lastCheck = Number.NEGATIVE_INFINITY
	let waiters: (() => void)[] = []
	const release = () => {
		const ready = waiters
		waiters = []
		for (const resolve of ready) resolve()
	}
	const untilIdle = (signal: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason)
			if (active === 0) return resolve()
			const onAbort = () => {
				waiters = waiters.filter((w) => w !== done)
				reject(signal.reason)
			}
			const done = () => {
				signal.removeEventListener('abort', onAbort)
				resolve()
			}
			signal.addEventListener('abort', onAbort, { once: true })
			waiters.push(done)
		})
	// Every model call waits for the conversation to be idle, and again after each wait.
	const model: LearningModel = async (request) => {
		for (;;) {
			await untilIdle(request.signal)
			if (active === 0) return options.learning.model(request)
		}
	}
	const check = async () => {
		const target = options.openTarget()
		if (!target) return
		await options.flushObservations()
		const outcome = await (options.run ?? runGeneratorCycle)({
			target,
			model,
			route: () => options.learning.route(controller.signal),
			settings: options.settings,
			mode: 'automatic',
			signal: controller.signal,
			now,
		})
		if (outcome.status === 'ran') options.onOutcome?.(outcome)
	}
	return {
		turnStarted() {
			active++
		},
		turnEnded() {
			active = Math.max(0, active - 1)
			if (active === 0) release()
			if (!options.settings.enabled || controller.signal.aborted || running) return
			if (active !== 0 || now() - lastCheck < CHECK_EVERY_MS) return
			lastCheck = now()
			running = check()
				.catch(() => {
					/* A background cycle that fails costs the person nothing and is retried later. */
				})
				.finally(() => {
					running = null
				})
		},
		async stop() {
			controller.abort(new Error('The session closed.'))
			release()
			await running
		},
	}
}

interface TurnSession {
	send(...args: never[]): AsyncIterable<unknown>
	resumePaused(...args: never[]): AsyncIterable<unknown>
	close?(...args: never[]): unknown
}

/** The same session with its turns counted for `learning`; every event passes through unchanged. */
export function withBackgroundLearning<T extends TurnSession>(
	session: T,
	learning: BackgroundLearning,
): T {
	const watch =
		<A extends unknown[], E>(open: (...args: A) => AsyncIterable<E>) =>
		(...args: A): AsyncIterable<E> =>
			(async function* () {
				learning.turnStarted()
				try {
					yield* open(...args)
				} finally {
					learning.turnEnded()
				}
			})()
	return Object.create(session, {
		send: { value: watch(session.send.bind(session) as never), enumerable: true },
		resumePaused: {
			value: watch(session.resumePaused.bind(session) as never),
			enumerable: true,
		},
		...(session.close
			? {
					close: {
						value: async (...args: never[]) => {
							await learning.stop()
							return (session.close as (...a: never[]) => unknown)(...args)
						},
						enumerable: true,
					},
				}
			: {}),
	}) as T
}
