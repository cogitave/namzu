import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * What the generator remembers between cycles: how far into the observations it
 * has read, when it last ran, and what it spent today. A plain file beside the
 * learning database, private to the project, never uploaded. A file that cannot
 * be read is treated as empty, which can only make a cycle start sooner, never
 * spend past the cap, because the cap is re-derived from the recorded cycles.
 */
export interface GeneratorState {
	readonly version: 1
	/** The highest observation ordinal a finished cycle has read. */
	readonly lastOrdinal: number
	readonly lastCycleAt: number | null
	/** The local calendar day the spend below belongs to, as YYYY-MM-DD. */
	readonly day: string
	readonly dayTokens: number
}

const EMPTY: GeneratorState = {
	version: 1,
	lastOrdinal: 0,
	lastCycleAt: null,
	day: '',
	dayTokens: 0,
}
const STALE_LOCK_MS = 30 * 60 * 1000

export function localDay(now: number): string {
	const d = new Date(now)
	const p = (n: number) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function readGeneratorState(dir: string): GeneratorState {
	try {
		const raw = JSON.parse(
			readFileSync(join(dir, 'generator.json'), 'utf8'),
		) as Partial<GeneratorState>
		if (raw.version !== 1) return EMPTY
		return {
			version: 1,
			lastOrdinal: Number.isSafeInteger(raw.lastOrdinal) ? (raw.lastOrdinal as number) : 0,
			lastCycleAt: Number.isFinite(raw.lastCycleAt) ? (raw.lastCycleAt as number) : null,
			day: typeof raw.day === 'string' ? raw.day : '',
			dayTokens: Number.isSafeInteger(raw.dayTokens) ? (raw.dayTokens as number) : 0,
		}
	} catch {
		return EMPTY
	}
}

export function writeGeneratorState(dir: string, state: GeneratorState): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const target = join(dir, 'generator.json')
	const temporary = `${target}.${process.pid}.tmp`
	writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
	renameSync(temporary, target)
}

/** Tokens still available today under `cap`, given what the state recorded. */
export function dailyTokensLeft(state: GeneratorState, cap: number, now: number): number {
	return Math.max(0, cap - (state.day === localDay(now) ? state.dayTokens : 0))
}

/**
 * One cycle at a time per project. A lock older than half an hour belongs to a
 * process that died and is taken over. Returns the release function, or null
 * when another cycle holds the lock.
 */
export function acquireGeneratorLock(dir: string, now: number): (() => void) | null {
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const path = join(dir, 'generator.lock')
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, 'wx', 0o600)
			writeFileSync(fd, String(process.pid))
			closeSync(fd)
			return () => rmSync(path, { force: true })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null
			try {
				if (existsSync(path) && now - statSync(path).mtimeMs > STALE_LOCK_MS) {
					rmSync(path, { force: true })
					continue
				}
			} catch {
				/* Someone else is deciding the same thing. */
			}
			return null
		}
	}
	return null
}
