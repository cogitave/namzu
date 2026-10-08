import {
	type DesktopSettings,
	type SettingsChangeResult,
	desktopSettingsPatch,
} from '../shared/settings-protocol.js'
import { FolderAccessTokens } from './folder-access.js'

/** The exact change a token is bound to: the same keys and values, whatever their order. */
function changeKey(patch: Partial<DesktopSettings>): string {
	return JSON.stringify(Object.entries(patch).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export interface SettingsConfirmationDeps {
	get(): DesktopSettings
	set(patch: Partial<DesktopSettings>): DesktopSettings
	/** Defaults to a fresh token store with the folder-access rules (5 minutes, single use). */
	tokens?: FolderAccessTokens
}

/**
 * Applies settings changes. Turning "ask again when automatic settings change" off lowers a
 * safeguard, so it is applied only with a one-time token main issued to the same window for that
 * exact change; the person confirms in an in-app dialog, never a native box. Every other change
 * applies at once.
 */
export class SettingsConfirmation {
	private readonly tokens: FolderAccessTokens
	constructor(private readonly deps: SettingsConfirmationDeps) {
		this.tokens = deps.tokens ?? new FolderAccessTokens()
	}

	change(windowId: string, rawPatch: unknown, token?: unknown): SettingsChangeResult {
		const patch = desktopSettingsPatch(rawPatch)
		if (token !== undefined && typeof token !== 'string') throw new Error('Invalid confirmation.')
		const lowers = patch.retrustOnConfigChange === false && this.deps.get().retrustOnConfigChange
		if (lowers) {
			const key = changeKey(patch)
			if (token === undefined)
				return {
					status: 'confirm',
					settings: this.deps.get(),
					token: this.tokens.issue(windowId, key),
				}
			if (!this.tokens.redeem(token, windowId, key)) throw new Error('The confirmation expired.')
		}
		return { status: 'saved', settings: this.deps.set(patch) }
	}
}
