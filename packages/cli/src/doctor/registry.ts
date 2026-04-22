import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorCheckRecord,
	DoctorCheckResult,
	DoctorReport,
	DoctorStatus,
	Logger,
} from '@namzu/sdk'

const DEFAULT_PER_CHECK_TIMEOUT_MS = 5_000
const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 10_000

export interface RunDoctorOptions {
	readonly categories?: readonly DoctorCheck['category'][]
	readonly perCheckTimeoutMs?: number
	readonly wallClockTimeoutMs?: number
	readonly cwd?: string
	readonly env?: Readonly<Record<string, string | undefined>>
	readonly projectRoot?: string | null
	readonly version?: string
	readonly registry?: DoctorRegistry
	/**
	 * Fired immediately before a check's `run()` is invoked. The TUI uses
	 * this to mark the row as 'running'. Throws are caught + logged + do
	 * not affect the doctor run.
	 */
	readonly onCheckStart?: (check: DoctorCheck) => void
	/**
	 * Fired exactly once per check, after its record is built (whether
	 * pass / fail / inconclusive / warn — including timeout-induced
	 * inconclusive). Throws are caught + logged + do not affect the
	 * doctor run. Defended against double-fire by the same `completed`
	 * map that pins the record (ses_013 C4).
	 */
	readonly onCheckComplete?: (record: DoctorCheckRecord) => void
	/**
	 * Cooperative cancellation. When the signal aborts, in-flight checks
	 * stop being awaited; their records become `inconclusive` with an
	 * "aborted" message. Completed records are preserved. Caller
	 * (typically the CLI bin) decides the exit code (sysexits 130 for
	 * SIGINT). Library callers can synthesize their own AbortController.
	 */
	readonly signal?: AbortSignal
}

export class DoctorRegistry {
	private readonly checks: Map<string, DoctorCheck> = new Map()
	private log?: Logger

	setLogger(log: Logger): void {
		this.log = log.child({ component: 'DoctorRegistry' })
	}

	register(check: DoctorCheck): void {
		if (this.checks.has(check.id)) {
			throw new Error(
				`Doctor check with id "${check.id}" is already registered. Pick a different id or call clear() first.`,
			)
		}
		this.checks.set(check.id, check)
	}

	unregister(id: string): boolean {
		return this.checks.delete(id)
	}

	clear(): void {
		this.checks.clear()
	}

	list(): readonly DoctorCheck[] {
		return Array.from(this.checks.values())
	}

	async run(opts: Omit<RunDoctorOptions, 'registry'> = {}): Promise<DoctorReport> {
		const ctx = buildContext(opts)
		const perCheck = opts.perCheckTimeoutMs ?? DEFAULT_PER_CHECK_TIMEOUT_MS
		const wall = opts.wallClockTimeoutMs ?? DEFAULT_WALL_CLOCK_TIMEOUT_MS
		const signal = opts.signal

		const filteredChecks = opts.categories
			? this.list().filter((c) => opts.categories?.includes(c.category))
			: this.list()

		const startedAt = Date.now()
		const completed: Map<string, DoctorCheckRecord> = new Map()
		const wallTimer = sleep(wall).then(() => 'wall-timeout' as const)

		// Fast-fail if already aborted before any check runs.
		const abortPromise: Promise<'aborted'> = signal
			? signal.aborted
				? Promise.resolve('aborted')
				: new Promise((resolve) => {
						signal.addEventListener('abort', () => resolve('aborted'), { once: true })
					})
			: new Promise(() => {}) // never resolves

		const recordCompletion = (record: DoctorCheckRecord): void => {
			// Defend against double-fire: per-check timeout race vs the check
			// resolving, or signal-abort racing the same id. First record wins.
			if (completed.has(record.id)) return
			completed.set(record.id, record)
			// Fire onCheckComplete exactly once per id, isolated from the run.
			this.invokeCallback('onCheckComplete', () => opts.onCheckComplete?.(record))
		}

		const inFlight = filteredChecks.map(async (check): Promise<void> => {
			// onCheckStart fires before the check's run() is invoked. Isolated.
			this.invokeCallback('onCheckStart', () => opts.onCheckStart?.(check))

			const t0 = Date.now()
			const checkPromise = (async (): Promise<DoctorCheckResult> => check.run(ctx))()
			const timeoutPromise = sleep(perCheck).then(
				(): DoctorCheckResult => ({
					status: 'inconclusive',
					message: `check did not return within ${perCheck}ms`,
				}),
			)
			let result: DoctorCheckResult
			try {
				result = await Promise.race([checkPromise, timeoutPromise])
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				this.log?.warn('doctor check threw', { id: check.id, message })
				result = { status: 'fail', message: `check threw: ${message}` }
			}
			recordCompletion({
				id: check.id,
				category: check.category,
				status: result.status,
				message: result.message,
				remediation: result.remediation,
				durationMs: result.durationMs ?? Date.now() - t0,
			})
		})

		const allChecks = Promise.all(inFlight)
		const raceWinner = await Promise.race([allChecks, wallTimer, abortPromise])

		let records: DoctorCheckRecord[]
		if (raceWinner === 'wall-timeout' || raceWinner === 'aborted') {
			const reason =
				raceWinner === 'aborted'
					? 'aborted by signal before this check completed'
					: `wall-clock timeout (${wall}ms) reached before this check completed`
			const unfinished = filteredChecks.filter((c) => !completed.has(c.id))
			this.log?.warn(
				raceWinner === 'aborted' ? 'doctor aborted by signal' : 'doctor wall-clock timeout',
				{
					wall,
					total: filteredChecks.length,
					unfinished: unfinished.length,
				},
			)
			records = filteredChecks.map((check): DoctorCheckRecord => {
				const existing = completed.get(check.id)
				if (existing) return existing
				const record: DoctorCheckRecord = {
					id: check.id,
					category: check.category,
					status: 'inconclusive' as DoctorStatus,
					message: reason,
					durationMs: Date.now() - startedAt,
				}
				// Fire onCheckComplete for unfinished checks too — TUI rows
				// flip from 'running' to 'inconclusive' instead of staying
				// stuck. recordCompletion handles double-fire defense if the
				// inFlight promise eventually resolves.
				recordCompletion(record)
				return record
			})
		} else {
			// All checks finished within wall-clock budget. Read from `completed`
			// in registration order so the report layout is deterministic.
			records = filteredChecks.map((check): DoctorCheckRecord => {
				const existing = completed.get(check.id)
				if (existing) return existing
				// Belt + suspenders: if an inFlight callback somehow finished
				// without populating `completed` (shouldn't happen), surface as
				// inconclusive rather than throwing.
				return {
					id: check.id,
					category: check.category,
					status: 'inconclusive' as DoctorStatus,
					message: 'check resolved without producing a record (internal)',
					durationMs: Date.now() - startedAt,
				}
			})
		}

		return buildReport(records, opts.version ?? 'unknown')
	}

	/**
	 * Invoke a consumer callback (onCheckStart / onCheckComplete) with
	 * try/catch isolation. Per ses_013 C3: a throwing callback must not
	 * affect the doctor run or the final DoctorReport. Logged but
	 * swallowed.
	 */
	private invokeCallback(phase: 'onCheckStart' | 'onCheckComplete', fn: () => void): void {
		try {
			fn()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.log?.warn('doctor callback threw', { phase, message })
		}
	}
}

export const doctor: DoctorRegistry = new DoctorRegistry()

export function createDoctorRegistry(): DoctorRegistry {
	return new DoctorRegistry()
}

export function registerDoctorCheck(check: DoctorCheck): void {
	doctor.register(check)
}

export function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorReport> {
	const registry = opts.registry ?? doctor
	return registry.run({
		categories: opts.categories,
		perCheckTimeoutMs: opts.perCheckTimeoutMs,
		wallClockTimeoutMs: opts.wallClockTimeoutMs,
		cwd: opts.cwd,
		env: opts.env,
		projectRoot: opts.projectRoot,
		version: opts.version,
		onCheckStart: opts.onCheckStart,
		onCheckComplete: opts.onCheckComplete,
		signal: opts.signal,
	})
}

function buildContext(opts: Omit<RunDoctorOptions, 'registry'>): DoctorCheckContext {
	return Object.freeze({
		cwd: opts.cwd ?? process.cwd(),
		env: opts.env ?? process.env,
		projectRoot: opts.projectRoot ?? null,
	})
}

function buildReport(records: readonly DoctorCheckRecord[], version: string): DoctorReport {
	const summary = {
		pass: records.filter((r) => r.status === 'pass').length,
		fail: records.filter((r) => r.status === 'fail').length,
		inconclusive: records.filter((r) => r.status === 'inconclusive').length,
		warn: records.filter((r) => r.status === 'warn').length,
		total: records.length,
	}
	const exit: DoctorReport['exit'] = summary.fail > 0 ? 1 : summary.total === 0 ? 2 : 0
	return Object.freeze({
		version,
		timestamp: new Date().toISOString(),
		checks: records,
		summary,
		exit,
	})
}

function sleep(ms: number): Promise<'sleep-done'> {
	return new Promise((resolve) => setTimeout(() => resolve('sleep-done'), ms))
}
