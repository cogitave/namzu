import {
	type ConfigSettingResult,
	type ConfigSettingsView,
	readConfigSettingChange,
} from '../shared/config-settings-protocol.js'
import { FolderAccessTokens } from './folder-access.js'

export interface ConfigSettingsDeps {
	read(): Promise<ConfigSettingsView>
	write(path: string, value: unknown): Promise<ConfigSettingsView>
	tokens?: FolderAccessTokens
}

/** The exact change a token is bound to. */
function changeKey(path: string, value: unknown): string {
	return JSON.stringify([path, value ?? null])
}

/**
 * Applies a change to a setting the engine owns. A setting the engine marks as one that widens
 * what runs, sends data out or removes a check is not applied on the renderer's word alone: main
 * answers `confirm` with a one-time token bound to that window and that exact change, and applies
 * it only when the same change returns with the token. The engine's own validation runs on every
 * write; this class never writes a file.
 */
export class ConfigSettings {
	private readonly tokens: FolderAccessTokens
	constructor(private readonly deps: ConfigSettingsDeps) {
		this.tokens = deps.tokens ?? new FolderAccessTokens()
	}

	read(): Promise<ConfigSettingsView> {
		return this.deps.read()
	}

	async change(windowId: string, raw: unknown, token?: unknown): Promise<ConfigSettingResult> {
		const change = readConfigSettingChange(raw)
		if (token !== undefined && typeof token !== 'string') throw new Error('Invalid confirmation.')
		const view = await this.deps.read()
		const entry = view.descriptors.find((d) => d.path === change.path)
		if (!entry) throw new Error('That is not a setting Namzu can change here.')
		if (entry.confirm && change.value !== undefined) {
			const key = changeKey(change.path, change.value)
			if (token === undefined)
				return {
					status: 'confirm',
					view,
					token: this.tokens.issue(windowId, key),
					message: entry.confirm,
				}
			if (!this.tokens.redeem(token, windowId, key)) throw new Error('The confirmation expired.')
		}
		return { status: 'saved', view: await this.deps.write(change.path, change.value) }
	}
}
