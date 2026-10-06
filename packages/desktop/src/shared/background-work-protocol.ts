/** Volatile, display-only knowledge of one ordinary conversation's shell jobs. */
export type BackgroundWorkStatus =
	| { readonly state: 'unknown' }
	| { readonly state: 'unavailable' }
	| {
			readonly state: 'known'
			readonly runningCount: number
			readonly needsAttention: boolean
			readonly checkedAt: number
			readonly expiresAt: number
	  }

export interface BackgroundWorkStatusEvent {
	readonly kind: 'background-work-status'
	readonly projectId: string
	readonly sessionId: string
	readonly status: BackgroundWorkStatus
}

/** A stale confirmation cannot state that work is still running. */
export function freshBackgroundWorkStatus(
	status: BackgroundWorkStatus | undefined,
	now = Date.now(),
): BackgroundWorkStatus {
	return status?.state === 'known' && now >= status.expiresAt
		? { state: 'unknown' }
		: (status ?? { state: 'unknown' })
}
