import type {
	EngineDeliveryView,
	EngineProblem,
	EngineRun,
	EngineStatus,
	EngineVersions,
} from '../../shared/engine-delivery-protocol.js'
import type { KernelState } from './state.js'
import { isKernelVersion } from './version.js'

/**
 * The screen's view of the engine (section 5.5), derived from the stored state, the last
 * check and what runs. Pure: the same inputs give the same view.
 */

/** After this long without a fresh answer, the screen says the check is not working. */
export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export interface ViewInput {
	available: boolean
	enabled: boolean
	override: boolean
	state: KernelState
	running: EngineRun
	bundled: EngineVersions
	checking: boolean
	now: number
}

/** A stored reason in one of a few fixed kinds; undefined for a reason that is not a failure. */
export function problemOf(reason: string): EngineProblem | undefined {
	if (reason === 'withdrawn' || reason.includes('chose this app')) return undefined
	if (reason.startsWith('host failed')) return 'did-not-start'
	if (reason.includes('ended early')) return 'ended-early'
	return 'failed-checks'
}

/** The newest give-up that is later than the engine now in use, if it was a failure. */
function lastGiveUp(state: KernelState): { version: string; problem: EngineProblem } | undefined {
	let found: { version: string; problem: EngineProblem; at: number } | undefined
	for (const [version, entry] of Object.entries(state.bad)) {
		if (!isKernelVersion(version)) continue
		const problem = problemOf(entry.reason)
		if (!problem) continue
		if (entry.at <= (state.updatedAt ?? 0)) continue
		if (!found || entry.at > found.at) found = { version, problem, at: entry.at }
	}
	return found ? { version: found.version, problem: found.problem } : undefined
}

export function engineStatus(input: ViewInput): EngineStatus {
	if (input.override) return { kind: 'override' }
	if (!input.enabled) return { kind: 'off' }
	if (input.checking) return { kind: 'checking' }
	const { state } = input
	if (state.pending && isKernelVersion(state.pending))
		return { kind: 'ready', version: state.pending }
	const gave = lastGiveUp(state)
	if (gave) {
		const to = input.running.commandLine ?? input.bundled.commandLine
		return { kind: 'went-back', ...gave, ...(to ? { to } : {}) }
	}
	if (state.lastCheck?.kind === 'needs-newer-app') return { kind: 'needs-newer-app' }
	const fresh = state.lastFreshCheckAt
	if (fresh !== undefined && input.now - fresh > STALE_AFTER_MS)
		return { kind: 'cannot-check', since: fresh }
	if (fresh !== undefined) return { kind: 'current', checkedAt: fresh }
	return { kind: 'unknown' }
}

export function buildEngineView(input: ViewInput): EngineDeliveryView {
	const { state } = input
	return {
		available: input.available,
		enabled: input.enabled,
		runs: input.running,
		bundled: input.bundled,
		status: engineStatus(input),
		// Offered only while a fetched engine runs or is the one the next start would use.
		canUseOwn: input.running.source === 'managed' || Boolean(state.current),
	}
}
