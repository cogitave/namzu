import type { ReasoningEffort } from '@namzu/sdk'
import { REASONING_EFFORT_LEVELS } from '../commands/effort-levels.js'

/** Process-local model choices. Credentials and endpoints stay with their drivers. */
export interface ModelLaunchEnvironment {
	readonly provider?: string
	readonly model?: string
	readonly effort?: ReasoningEffort
	readonly subagentModel?: string
}

export function positiveTokenCount(value: string, source: string): number {
	const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
	if (!Number.isSafeInteger(n) || n <= 0)
		throw new Error(`${source} takes a positive safe whole number of tokens.`)
	return n
}

/** Read only when opening model work; exports do not alter history/upgrade commands. */
export function readModelLaunchEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): ModelLaunchEnvironment {
	const text = (name: string): string | undefined => {
		const value = env[name]
		if (value === undefined) return undefined
		if (!value.trim()) throw new Error(`${name} must name a nonempty value.`)
		return value.trim()
	}
	const provider = text('NAMZU_PROVIDER')
	const model = text('NAMZU_MODEL')
	const subagentModel = text('NAMZU_SUBAGENT_MODEL')
	const rawEffort = text('NAMZU_EFFORT_LEVEL')
	if (rawEffort !== undefined && !REASONING_EFFORT_LEVELS.includes(rawEffort as ReasoningEffort))
		throw new Error(`NAMZU_EFFORT_LEVEL takes one of ${REASONING_EFFORT_LEVELS.join(', ')}.`)
	return {
		...(provider !== undefined ? { provider } : {}),
		...(model !== undefined ? { model } : {}),
		...(subagentModel !== undefined ? { subagentModel } : {}),
		...(rawEffort !== undefined ? { effort: rawEffort as ReasoningEffort } : {}),
	}
}

/** Explicit flags win over this process's defaults. Never save these choices. */
export function withModelLaunchEnvironment<
	T extends { provider: string | null; model: string | null; effort: ReasoningEffort | null },
>(flags: T, env: NodeJS.ProcessEnv = process.env): T {
	const defaults = readModelLaunchEnvironment(env)
	return {
		...flags,
		provider: flags.provider ?? defaults.provider ?? null,
		model: flags.model ?? defaults.model ?? null,
		effort: flags.effort ?? defaults.effort ?? null,
	}
}
