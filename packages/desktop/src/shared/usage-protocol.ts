/**
 * What the Namzu host says about how full a conversation is, read before anything
 * trusts it. The desktop half of `packages/cli/src/commands/desktop-usage-feed.ts`:
 * the notification is `namzu/session/usage`, and every field but `sessionId` may be
 * absent, which means the engine did not say.
 */
export const USAGE_NOTIFICATION = 'namzu/session/usage'

export interface UsageNotice {
	sessionId: string
	contextTokens?: number
	contextWindowTokens?: number
	contextMeasuredBy?: 'provider' | 'estimate'
	/** Cost so far in US dollars; present only when every token was priced. */
	cost?: number
	compaction?: 'started' | 'finished' | 'failed'
	tokensBefore?: number
	tokensAfter?: number
}

/** The largest figure taken at face value; anything beyond is a damaged frame, not a conversation. */
const MAX_COUNT = 1e12

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_COUNT
		? value
		: undefined
}

/** Admit only the known fields; a field that does not read is treated as not said. */
export function readUsageNotice(value: unknown): UsageNotice | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
	const raw = value as Record<string, unknown>
	if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0 || raw.sessionId.length > 200)
		return undefined
	const contextTokens = count(raw.contextTokens)
	const window = count(raw.contextWindowTokens)
	const cost = count(raw.cost)
	const tokensBefore = count(raw.tokensBefore)
	const tokensAfter = count(raw.tokensAfter)
	return {
		sessionId: raw.sessionId,
		...(contextTokens === undefined ? {} : { contextTokens }),
		...(window === undefined || window === 0 ? {} : { contextWindowTokens: window }),
		...(raw.contextMeasuredBy === 'provider' || raw.contextMeasuredBy === 'estimate'
			? { contextMeasuredBy: raw.contextMeasuredBy }
			: {}),
		...(cost === undefined ? {} : { cost }),
		...(raw.compaction === 'started' || raw.compaction === 'finished' || raw.compaction === 'failed'
			? { compaction: raw.compaction }
			: {}),
		...(tokensBefore === undefined ? {} : { tokensBefore }),
		...(tokensAfter === undefined ? {} : { tokensAfter }),
	}
}
