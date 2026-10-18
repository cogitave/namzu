import { WorkflowRuntime } from '../runtime.js'
import type {
	WorkflowAgentOutcome,
	WorkflowAgentRequest,
	WorkflowEvent,
	WorkflowRunOptions,
	WorkflowRunResult,
	WorkflowSpawnAgent,
} from '../types.js'

export interface Pending {
	readonly request: WorkflowAgentRequest
	readonly signal: AbortSignal
	finish(outcome?: Partial<WorkflowAgentOutcome>): void
}

/**
 * A scripted host. By default an agent finishes at once with `ok:<prompt>`.
 * With `manual`, each agent waits for the test to finish it, and the test
 * awaits `reached(n)` (resolved by the host itself, never by a timer).
 */
export function makeHost(options: { manual?: boolean } = {}) {
	const timeline: string[] = []
	const started: Pending[] = []
	let running = 0
	let maxRunning = 0
	const waiters: { count: number; resolve: () => void }[] = []

	const spawnAgent: WorkflowSpawnAgent = (request, signal) => {
		timeline.push(`start:${request.index}`)
		running++
		maxRunning = Math.max(maxRunning, running)
		return new Promise<WorkflowAgentOutcome>((resolve) => {
			const done = (outcome: Partial<WorkflowAgentOutcome> = {}): void => {
				running--
				timeline.push(`end:${request.index}`)
				resolve({
					state: 'done',
					text: `ok:${request.prompt}`,
					tokens: 10,
					toolCalls: 1,
					...outcome,
				})
			}
			signal.addEventListener(
				'abort',
				() => {
					if (!pending.settled) {
						pending.settled = true
						done({ state: 'error', error: 'aborted', tokens: 0, toolCalls: 0 })
					}
				},
				{ once: true },
			)
			const pending = {
				request,
				signal,
				settled: false,
				finish(outcome?: Partial<WorkflowAgentOutcome>) {
					if (pending.settled) return
					pending.settled = true
					done(outcome)
				},
			}
			started.push(pending)
			for (const w of waiters.filter((x) => started.length >= x.count)) w.resolve()
			if (!options.manual) pending.finish()
		})
	}

	return {
		spawnAgent,
		timeline,
		started,
		get maxRunning() {
			return maxRunning
		},
		reached(count: number): Promise<void> {
			if (started.length >= count) return Promise.resolve()
			return new Promise((resolve) => waiters.push({ count, resolve }))
		},
	}
}

export async function runScript(
	script: string,
	options: Partial<WorkflowRunOptions> & { host?: ReturnType<typeof makeHost> } = {},
): Promise<{ result: WorkflowRunResult; events: WorkflowEvent[] }> {
	const events: WorkflowEvent[] = []
	const host = options.host ?? makeHost()
	const { host: _ignored, onEvent, limits, ...rest } = options
	const result = await new WorkflowRuntime().run({
		script,
		spawnAgent: host.spawnAgent,
		onEvent: (event) => {
			events.push(event)
			onEvent?.(event)
		},
		// The default concurrency follows this machine's CPU count, so a test that
		// holds several agents at once would hang on a small CI runner. Tests get a
		// fixed cap unless they set their own.
		limits: { maxConcurrency: 8, ...limits },
		...rest,
	})
	return { result, events }
}

export const META = "export const meta = { name: 't', description: 'test workflow' }\n"
