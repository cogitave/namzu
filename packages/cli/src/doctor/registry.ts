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

		const filteredChecks = opts.categories
			? this.list().filter((c) => opts.categories?.includes(c.category))
			: this.list()

		const startedAt = Date.now()
		const wallTimer = sleep(wall).then(() => 'wall-timeout' as const)

		const inFlight = filteredChecks.map(async (check): Promise<DoctorCheckRecord> => {
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
			return {
				id: check.id,
				category: check.category,
				status: result.status,
				message: result.message,
				remediation: result.remediation,
				durationMs: result.durationMs ?? Date.now() - t0,
			}
		})

		const allChecks = Promise.all(inFlight)
		const raceWinner = await Promise.race([allChecks, wallTimer])

		let records: DoctorCheckRecord[]
		if (raceWinner === 'wall-timeout') {
			this.log?.warn('doctor wall-clock timeout', {
				wall,
				total: filteredChecks.length,
			})
			records = filteredChecks.map((check) => ({
				id: check.id,
				category: check.category,
				status: 'inconclusive' as DoctorStatus,
				message: `wall-clock timeout (${wall}ms) reached before all checks completed`,
				durationMs: Date.now() - startedAt,
			}))
		} else {
			records = raceWinner
		}

		return buildReport(records, opts.version ?? 'unknown')
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
