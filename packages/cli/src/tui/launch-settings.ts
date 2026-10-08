import type { ReasoningEffort } from '@namzu/sdk'
import { applyProviderFlags } from '../commands/exec-flags.js'
import type { Preferences } from '../integrations/providers/index.js'
import type { PermissionMode } from '../permissions/mode.js'

/**
 * What `namzu --provider … --model … --effort … --permission-mode …` asks for.
 *
 * These choose how THIS session starts and nothing else. They are never written
 * to the preferences file, so the next plain `namzu` starts where the person last
 * left it; a person who wants a change to stick still picks it in the app.
 */
export interface TuiLaunchSettings {
	readonly provider?: string
	readonly model?: string
	readonly effort?: ReasoningEffort
	readonly permissionMode?: PermissionMode
}

/** Whether any flag changes which provider or model the session starts on. */
export function choosesModel(settings: TuiLaunchSettings | undefined): boolean {
	return Boolean(settings?.provider || settings?.model)
}

/**
 * The provider chain this launch runs on, from the saved one and the flags.
 *
 * `--provider` replaces the chain with that provider alone; `--model` alone
 * re-models the saved primary (the same reading `exec` has, through the same
 * function). Null when the flags cannot name a provider: `--model` with nothing
 * saved to apply it to.
 */
export function launchPreferences(
	saved: Preferences | null,
	settings: TuiLaunchSettings,
): Preferences | null {
	const base: Preferences = saved ?? { version: 3, providers: [], subagents: { active: [] } }
	const applied = applyProviderFlags(base, {
		provider: settings.provider ?? null,
		model: settings.model ?? null,
	})
	return applied.providers.length > 0 ? applied : null
}
