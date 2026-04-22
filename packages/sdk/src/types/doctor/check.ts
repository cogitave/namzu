export type DoctorStatus = 'pass' | 'fail' | 'inconclusive' | 'warn'

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
		readonly total: number
	}
	readonly exit: 0 | 1 | 2 | 70
}
