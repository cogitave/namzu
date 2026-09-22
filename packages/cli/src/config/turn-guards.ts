import type { SessionLog, TurnId } from '@namzu/sdk'
import type { NamzuCliConfig } from './schema.js'

/** The `limits` block of a CLI config: what one turn may spend. */
type LimitsConfig = NonNullable<NamzuCliConfig['limits']>

export type TurnGuardKey = 'tokenBudget' | 'maxIterations' | 'timeoutMs'
export type TurnGuards = { -readonly [K in TurnGuardKey]: number }

const GUARD_KEYS = ['tokenBudget', 'maxIterations', 'timeoutMs'] as const

/** CLI policy; independent of the SDK's defaults for embedding hosts. */
export function resolveTurnGuards(...layers: readonly (LimitsConfig | undefined)[]): TurnGuards {
	const resolved: TurnGuards = { tokenBudget: 0, maxIterations: 0, timeoutMs: 0 }
	for (const layer of layers) {
		for (const key of GUARD_KEYS) {
			const value = layer?.[key]
			if (value === undefined) continue
			if (
				!Number.isSafeInteger(value) ||
				value < 0 ||
				(key === 'timeoutMs' && value > 2_147_483_647)
			)
				throw new Error(
					`Invalid ${key}: use a nonnegative safe integer${key === 'timeoutMs' ? ' at most 2147483647' : ''}. 0 means unlimited.`,
				)
			resolved[key] = value
		}
	}
	return resolved
}

/**
 * Restore a turn's own limits, including overrides made before a provider
 * pause, from the `turn_started` record that opened it.
 *
 * The session log is the only place a turn's settings are written, so this
 * reads the log rather than a sidecar. The read is strict: a log whose chain
 * does not verify is refused rather than trusted for the limits a resumed
 * turn runs under. `undefined` means the log holds no such turn, which is
 * what an embedded host that never recorded one looks like.
 */
export async function readStoredTurnGuards(
	log: Pick<SessionLog, 'sessionId' | 'read'>,
	turnId: TurnId,
): Promise<TurnGuards | undefined> {
	for await (const { record } of log.read({ mode: 'strict' })) {
		if (record.type !== 'turn_started' || record.turnId !== turnId) continue
		if (record.sessionId !== log.sessionId)
			throw new Error('Turn record belongs to a different session than the resumed turn')
		const config: Record<string, unknown> = { ...record.config }
		if (GUARD_KEYS.some((key) => typeof config[key] !== 'number'))
			throw new Error('Turn record does not contain its original limits')
		return resolveTurnGuards({
			tokenBudget: config.tokenBudget as number,
			maxIterations: config.maxIterations as number,
			timeoutMs: config.timeoutMs as number,
		})
	}
	return undefined
}
