import type { SessionLog, TurnId } from '@namzu/sdk'
import type { NamzuCliConfig } from './schema.js'

/** The `limits` block of a CLI config: what one turn may spend. */
type LimitsConfig = NonNullable<NamzuCliConfig['limits']>

export type TurnGuardKey = 'tokenBudget' | 'maxIterations' | 'timeoutMs'
export type TurnGuards = { -readonly [K in TurnGuardKey]: number } & {
	/** Dollars the turn may spend; absent means no spend limit. */
	costLimitUsd?: number
	/** Per-call output allowance; absent keeps each host's existing default. */
	maxResponseTokens?: number
	/** Most reasoning, in tokens, one model call may stream before acting; 0 removes the cap, absent keeps the kernel's default. */
	maxReasoningTokens?: number
	/** `false` turns the check-your-edits reminder off; absent leaves it on. */
	doneGate?: boolean
	/** Hook refusals in a row honoured before a turn ends anyway; 0 removes the cap, absent means {@link DEFAULT_MAX_HOOK_REFUSALS}. */
	maxHookRefusals?: number
}

/** End-of-turn hook refusals the CLI honours in a row before it ends the turn anyway. The kernel has no such default. */
export const DEFAULT_MAX_HOOK_REFUSALS = 8

/** The turn-config fields a resolved set of limits stands for; see {@link turnConfigFields}. */
export interface TurnConfigFields {
	tokenBudget: number
	maxIterations: number
	timeoutMs: number
	costLimitUsd?: number
	maxResponseTokens?: number
	reasoning?: { maxTokens: number }
	completionAudit?: boolean
	/** Always set: the configured limit, or {@link DEFAULT_MAX_HOOK_REFUSALS}; 0 is no cap. */
	maxHookRefusals: number
}

/**
 * The turn-config fields a resolved set of limits stands for. Spread this, not
 * the limits themselves, into a turn: the limits carry host-only keys, and the
 * reasoning cap and the done-gate have to be translated into the kernel's
 * `reasoning` and `completionAudit` settings to reach the turn at all.
 *
 * `completionAudit` asks for the done-gate where the turn is one a person
 * follows (the interactive session and `exec`); delegated children are not
 * audited.
 */
export function turnConfigFields(
	guards: TurnGuards,
	options: { readonly completionAudit?: boolean } = {},
): TurnConfigFields {
	return {
		tokenBudget: guards.tokenBudget,
		maxIterations: guards.maxIterations,
		timeoutMs: guards.timeoutMs,
		...(guards.costLimitUsd !== undefined ? { costLimitUsd: guards.costLimitUsd } : {}),
		...(guards.maxResponseTokens !== undefined
			? { maxResponseTokens: guards.maxResponseTokens }
			: {}),
		...(guards.maxReasoningTokens !== undefined
			? { reasoning: { maxTokens: guards.maxReasoningTokens } }
			: {}),
		maxHookRefusals: guards.maxHookRefusals ?? DEFAULT_MAX_HOOK_REFUSALS,
		...(options.completionAudit === true && guards.doneGate !== false
			? { completionAudit: true }
			: {}),
	}
}

const GUARD_KEYS = ['tokenBudget', 'maxIterations', 'timeoutMs'] as const

/** CLI policy; independent of the SDK's defaults for embedding hosts. */
export function resolveTurnGuards(...layers: readonly (LimitsConfig | undefined)[]): TurnGuards {
	const resolved: TurnGuards = { tokenBudget: 0, maxIterations: 0, timeoutMs: 0 }
	let costLimitUsd: number | undefined
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
		const response = layer?.maxResponseTokens
		if (response !== undefined) {
			if (!Number.isSafeInteger(response) || response <= 0)
				throw new Error('Invalid maxResponseTokens: use a positive safe integer.')
			resolved.maxResponseTokens = response
		}
		const reasoning = layer?.maxReasoningTokens
		if (reasoning !== undefined) {
			if (!Number.isSafeInteger(reasoning) || reasoning < 0)
				throw new Error(
					'Invalid maxReasoningTokens: use a nonnegative safe integer. 0 removes the cap.',
				)
			resolved.maxReasoningTokens = reasoning
		}
		const refusals = layer?.maxHookRefusals
		if (refusals !== undefined) {
			if (!Number.isSafeInteger(refusals) || refusals < 0)
				throw new Error(
					'Invalid maxHookRefusals: use a nonnegative safe integer. 0 removes the limit.',
				)
			resolved.maxHookRefusals = refusals
		}
		if (layer?.doneGate !== undefined) resolved.doneGate = layer.doneGate
		const spend = layer?.costLimitUsd
		if (spend === undefined) continue
		if (!Number.isFinite(spend) || spend < 0)
			throw new Error(
				'Invalid costLimitUsd: use a number of dollars, 0 or more. 0 means unlimited.',
			)
		// Zero lifts a limit an earlier layer set, like the whole-number limits.
		costLimitUsd = spend > 0 ? spend : undefined
	}
	return costLimitUsd === undefined ? resolved : { ...resolved, costLimitUsd }
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
			...(config.maxResponseTokens !== undefined
				? { maxResponseTokens: config.maxResponseTokens as number }
				: {}),
			...(typeof config.costLimitUsd === 'number' ? { costLimitUsd: config.costLimitUsd } : {}),
		})
	}
	return undefined
}
