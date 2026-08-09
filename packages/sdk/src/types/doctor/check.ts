/**
 * What a check concluded.
 *
 * `skipped` and `inconclusive` are the two ways a check produces no verdict,
 * and they are separate because a caller acts on them differently.
 *
 * - `skipped` — the check LOOKED and there was nothing here to check: an
 *   optional package is not installed, a registry the check reads has no
 *   auto-discovery to read, nothing is configured yet. A permanent or
 *   by-design absence, and an ordinary state of a healthy machine.
 * - `inconclusive` — the check DID NOT ANSWER: it timed out, it was aborted,
 *   the thing it reads threw. Nothing is known either way, and that is itself
 *   a gap in the report worth acting on.
 *
 * The word used to cover both, so `namzu doctor` could not tell "healthy" from
 * "did not manage to look", and neither could anything reading its exit code.
 */
export type DoctorStatus = 'pass' | 'fail' | 'inconclusive' | 'warn' | 'skipped'

export type DoctorCategory =
	| 'sandbox'
	| 'providers'
	| 'vault'
	| 'telemetry'
	| 'runtime'
	| 'plugins'
	| 'custom'

export interface DoctorCheckContext {
	readonly cwd: string
	readonly env: Readonly<Record<string, string | undefined>>
	readonly projectRoot: string | null
}

export interface DoctorCheckResult {
	readonly status: DoctorStatus
	readonly message?: string
	readonly remediation?: string
	readonly durationMs?: number
}

export interface DoctorCheck {
	readonly id: string
	readonly category: DoctorCategory
	readonly run: (ctx: DoctorCheckContext) => Promise<DoctorCheckResult>
	readonly fix?: (ctx: DoctorCheckContext) => Promise<DoctorCheckResult>
}

export interface DoctorCheckRecord {
	readonly id: string
	readonly category: DoctorCategory
	readonly status: DoctorStatus
	readonly message?: string
	readonly remediation?: string
	readonly durationMs: number
}

export interface DoctorReport {
	readonly version: string
	readonly timestamp: string
	readonly checks: readonly DoctorCheckRecord[]
	readonly summary: {
		readonly pass: number
		readonly fail: number
		readonly inconclusive: number
		readonly warn: number
		readonly skipped: number
		/** Every other count sums to this. A reader may rely on that. */
		readonly total: number
	}
	/**
	 * `69` is sysexits `EX_UNAVAILABLE`, whose own definition ends "a catchall
	 * when something you wanted to do doesn't work, but you don't know why".
	 * That is `inconclusive`. It is not `2`, which this report already spends on
	 * "nothing was registered", and not `70`, which says the CLI is broken and
	 * is worth a bug report.
	 */
	readonly exit: 0 | 1 | 2 | 69 | 70
}
