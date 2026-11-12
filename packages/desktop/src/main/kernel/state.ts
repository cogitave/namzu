import { join } from 'node:path'
import type { KernelFs } from './fs.js'
import { isKernelVersion } from './version.js'

/** `<userData>/kernel/state.json`: what the app has installed, and what it has learned. */

export interface BadEntry {
	reason: string
	at: number
}

export interface LastCheck {
	/** When the check ran (the app's clock). */
	at: number
	/** Plain words for the screen when the check did not end well, else undefined. */
	problem?: string
	/** The result kind, for the screen. */
	kind: string
	/** For a failed check: the step it stopped at (a fixed word). */
	stage?: string
}

/** Stages after a trusted manifest showed a newer engine and before it was stored. */
export function leftEngineUnfetched(stage: string | undefined): boolean {
	return stage === 'download' || stage === 'install'
}

export interface KernelState {
	schema: 1
	current?: string
	previous?: string
	pending?: string
	bad: Record<string, BadEntry>
	lastSequence: number
	/** The latest issue time seen in any signed manifest: the clock the app trusts as a floor. */
	highestIssuedAt: number
	/** The highest floor seen, never lowered. */
	minimumKernel?: string
	lastFreshCheckAt?: number
	lastCheck?: LastCheck
	/** When `current` became current, and when `previous` had. */
	updatedAt?: number
	previousUpdatedAt?: number
	/** Version -> number of hosts started on it, and how many ended early. */
	starts: Record<string, number>
	earlyExits: Record<string, number>
}

export function emptyState(): KernelState {
	return {
		schema: 1,
		bad: {},
		lastSequence: 0,
		highestIssuedAt: 0,
		starts: {},
		earlyExits: {},
	}
}

export interface KernelPaths {
	root: string
	state: string
	stateTemp: string
	versions: string
	tmp: string
	log: string
}

export function kernelPaths(root: string): KernelPaths {
	return {
		root,
		state: join(root, 'state.json'),
		stateTemp: join(root, 'state.json.tmp'),
		versions: join(root, 'versions'),
		tmp: join(root, 'tmp'),
		log: join(root, 'updates.log'),
	}
}

export function versionFolder(paths: KernelPaths, version: string): string {
	return join(paths.versions, version)
}

export function pairPaths(
	paths: KernelPaths,
	version: string,
): { manifest: string; signature: string } {
	return {
		manifest: join(paths.versions, `${version}.manifest.json`),
		signature: join(paths.versions, `${version}.manifest.json.sig`),
	}
}

function counter(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function counterMap(value: unknown): Record<string, number> {
	const out: Record<string, number> = {}
	if (value && typeof value === 'object' && !Array.isArray(value))
		for (const [key, entry] of Object.entries(value)) {
			const n = counter(entry)
			if (isKernelVersion(key) && n !== undefined) out[key] = n
		}
	return out
}

/**
 * Reads what a state file says, field by field. Anything that is not a plain valid value is
 * dropped, so a damaged or hand-edited file can only mean "less is managed", never a crash
 * or a path outside the folder (versions are checked as versions).
 */
export function readState(value: unknown): KernelState {
	const state = emptyState()
	if (!value || typeof value !== 'object' || Array.isArray(value)) return state
	const raw = value as Record<string, unknown>
	if (raw.schema !== 1) return state
	if (isKernelVersion(raw.current)) state.current = raw.current
	if (isKernelVersion(raw.previous) && raw.previous !== state.current) state.previous = raw.previous
	if (
		isKernelVersion(raw.pending) &&
		raw.pending !== state.current &&
		raw.pending !== state.previous
	)
		state.pending = raw.pending
	if (raw.bad && typeof raw.bad === 'object' && !Array.isArray(raw.bad))
		for (const [version, entry] of Object.entries(raw.bad)) {
			if (!isKernelVersion(version) || !entry || typeof entry !== 'object') continue
			const { reason, at } = entry as Record<string, unknown>
			if (typeof reason === 'string' && counter(at) !== undefined)
				state.bad[version] = { reason: reason.slice(0, 300), at: at as number }
		}
	// A version that is bad is never held as current, previous or pending.
	for (const slot of ['current', 'previous', 'pending'] as const) {
		const held = state[slot]
		if (held && state.bad[held]) state[slot] = undefined
	}
	state.lastSequence = counter(raw.lastSequence) ?? 0
	state.highestIssuedAt = counter(raw.highestIssuedAt) ?? 0
	if (isKernelVersion(raw.minimumKernel)) state.minimumKernel = raw.minimumKernel
	const fresh = counter(raw.lastFreshCheckAt)
	if (fresh !== undefined) state.lastFreshCheckAt = fresh
	const updated = counter(raw.updatedAt)
	if (updated !== undefined) state.updatedAt = updated
	const previousUpdated = counter(raw.previousUpdatedAt)
	if (previousUpdated !== undefined) state.previousUpdatedAt = previousUpdated
	if (raw.lastCheck && typeof raw.lastCheck === 'object' && !Array.isArray(raw.lastCheck)) {
		const { at, kind, problem, stage } = raw.lastCheck as Record<string, unknown>
		if (counter(at) !== undefined && typeof kind === 'string')
			state.lastCheck = {
				at: at as number,
				kind: kind.slice(0, 40),
				...(typeof problem === 'string' ? { problem: problem.slice(0, 300) } : {}),
				...(typeof stage === 'string' ? { stage: stage.slice(0, 40) } : {}),
			}
	}
	state.starts = counterMap(raw.starts)
	state.earlyExits = counterMap(raw.earlyExits)
	return state
}

/** Missing, unreadable or damaged: nothing is managed, the bundled engine runs. */
export async function loadState(fs: KernelFs, paths: KernelPaths): Promise<KernelState> {
	try {
		return readState(JSON.parse((await fs.readFile(paths.state)).toString('utf8')))
	} catch {
		return emptyState()
	}
}

/**
 * Temp file, flush, rename over the old one. Either the old file or the whole new one is on
 * disk afterwards; a failure leaves the old one (and removes the temp, if it can).
 */
export async function saveState(
	fs: KernelFs,
	paths: KernelPaths,
	state: KernelState,
): Promise<void> {
	const text = `${JSON.stringify(state)}\n`
	try {
		await fs.mkdir(paths.root, { recursive: true })
		await fs.writeFile(paths.stateTemp, text)
		await fs.rename(paths.stateTemp, paths.state)
	} catch (error) {
		await fs.rm(paths.stateTemp).catch(() => undefined)
		throw error
	}
}
