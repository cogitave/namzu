import type { LLMProvider } from '@namzu/sdk'

/** How the credential behind a provider was obtained, which decides what can honestly be said about it. */
export type LimitsKind = 'sign-in' | 'key' | 'local'

export interface LimitsSource {
	readonly id: string
	readonly label: string
	readonly kind: LimitsKind
}

interface Held extends LimitsSource {
	readonly providers: Pick<LLMProvider, 'readLimits'>[]
}

/** Provider objects kept per id: a turn builds a few (replies, titles, summaries), the newest reading wins. */
const MAX_PER_PROVIDER = 8

const held = new Map<string, Held>()

/**
 * Notes a provider the process built, so the limits feed can ask it what its vendor says about the
 * account. Only a reference is kept, in memory: no credential and no reading is written anywhere.
 */
export function rememberLimitsSource(
	source: LimitsSource,
	provider: Pick<LLMProvider, 'readLimits'>,
): void {
	const known = held.get(source.id)
	const providers = [
		provider,
		...(known?.providers ?? []).filter((item) => item !== provider),
	].slice(0, MAX_PER_PROVIDER)
	held.set(source.id, { ...source, providers })
}

export function limitsSources(): readonly (LimitsSource & {
	readonly providers: readonly Pick<LLMProvider, 'readLimits'>[]
})[] {
	return [...held.values()]
}

/** For tests. */
export function forgetLimitsSources(): void {
	held.clear()
}
