/**
 * What `--append-system-prompt`, `--allowed-tools`, `--disallowed-tools` and
 * `--fallback-model` mean for one run, in one place.
 *
 * `exec`, `exec --json` and the interactive launcher read the same four flags,
 * and a flag that one of them applies and another quietly ignores is the
 * failure the shared exec parser exists to prevent. Each of them calls this,
 * so the four are resolved the same way everywhere.
 */

import { applyFallbackFlag } from '../integrations/providers/fallback-flag.js'
import type { Preferences } from '../integrations/providers/index.js'
import type { PermissionsConfig } from '../permissions/rules.js'
import { toolFlagLayers } from '../permissions/tool-flags.js'
import { resolveAppendSystemPrompt } from './append-system.js'

export interface RunFlagInput {
	readonly appendSystemPrompt: string | null
	readonly allowedTools: readonly string[]
	readonly disallowedTools: readonly string[]
	readonly fallbackModels: readonly string[]
}

export interface RunFlagEffects {
	/** The provider chain for this run. */
	readonly prefs: Preferences
	/** Permission layers the flags add on top of the configured ones. */
	readonly permissionLayers: readonly PermissionsConfig[]
	/** Text for the uncached tail of the system prompt, if one was given. */
	readonly appendSystem: string | undefined
}

/** The effects of the four flags, or the first thing wrong with them. */
export function resolveRunFlags(
	flags: RunFlagInput,
	prefs: Preferences,
	base?: string,
): RunFlagEffects | { readonly error: string } {
	const appended = resolveAppendSystemPrompt(flags.appendSystemPrompt, base)
	if (appended && 'error' in appended) return appended
	const tools = toolFlagLayers(flags)
	const problem = tools.problems[0]
	if (problem) return { error: `${problem.flag}: ${problem.message}` }
	return {
		prefs: applyFallbackFlag(prefs, flags.fallbackModels),
		permissionLayers: tools.layers,
		appendSystem: appended?.text,
	}
}

/** A dollar amount for a sentence: cents above a cent, and as many places as a smaller amount needs. */
function dollars(amount: number): string {
	if (amount >= 0.01) return amount.toFixed(2)
	const places = amount.toFixed(10).replace(/0+$/, '')
	return places.length > 2 ? places : amount.toFixed(2)
}

/** What a run that reached its spend limit says on stderr. */
export function describeSpendStop(limitUsd: number): string {
	const amount = limitUsd > 0 ? ` of $${dollars(limitUsd)}` : ''
	return `stopped at the spend limit${amount}; raise it with --max-budget-usd to let the run go on`
}
