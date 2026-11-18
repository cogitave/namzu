import {
	type ConfigSettingDescriptor,
	type ConfigSettingResult,
	type ConfigSettingsView,
	readConfigSettingChange,
} from '../shared/config-settings-protocol.js'
import { FolderAccessTokens } from './folder-access.js'

export interface ConfigSettingsDeps {
	read(): Promise<ConfigSettingsView>
	write(path: string, value: unknown): Promise<ConfigSettingsView>
	/** Asks the engine whether it would accept the change, without applying it. */
	validate(path: string, value: unknown): Promise<void>
	tokens?: FolderAccessTokens
}

/** The exact change a token is bound to. */
function changeKey(path: string, value: unknown): string {
	return JSON.stringify([path, value ?? null])
}

/**
 * Whether a change needs the person's yes. Clearing a setting puts the default back, so it asks
 * unless the descriptor names the risky values and the default is not one of them (clearing the
 * default permission mode returns to the safe one and asks nothing). Otherwise the descriptor says
 * which new value asks, so turning a sandbox on or a guard back on is not put behind a warning
 * about the opposite.
 */
function needsConfirmation(entry: ConfigSettingDescriptor, value: unknown): boolean {
	if (!entry.confirm) return false
	if (value === undefined) return clearReachesRiskyDefault(entry)
	if (entry.confirmValues !== undefined) return entry.confirmValues.includes(value as string)
	if (entry.confirmValue !== undefined) return value === entry.confirmValue
	if (!entry.confirmWhen) return true
	if (entry.confirmWhen === 'zero') return value === 0
	if (typeof value !== 'boolean') return true
	return value === (entry.confirmWhen === 'on')
}

/**
 * A clear asks unless the risky values are named and the plain default is none of them. A switch
 * that asks for one direction (`confirmWhen` on or off) is answered by its typed default: going back
 * to the side that does not ask is not put behind a warning.
 */
function clearReachesRiskyDefault(entry: ConfigSettingDescriptor): boolean {
	if (
		(entry.confirmWhen === 'on' || entry.confirmWhen === 'off') &&
		typeof entry.default === 'boolean' &&
		!entry.defaultWhen?.length
	)
		return entry.default === (entry.confirmWhen === 'on')
	const risky =
		entry.confirmValues ?? (entry.confirmValue !== undefined ? [entry.confirmValue] : undefined)
	if (risky === undefined || entry.defaultWhen?.length) return true
	if (typeof entry.default !== 'string') return true
	return risky.includes(entry.default)
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
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
		// Saving what the setting already holds changes nothing, so it never asks.
		const state = view.settings.find((s) => s.path === change.path)
		const current = state?.set ? state.value : entry.default
		const unchanged =
			change.value !== undefined && current !== undefined && sameValue(current, change.value)
		if (!unchanged && needsConfirmation(entry, change.value)) {
			const key = changeKey(change.path, change.value)
			if (token === undefined) {
				// A value the engine would refuse never costs a dialog.
				await this.deps.validate(change.path, change.value)
				return {
					status: 'confirm',
					view,
					token: this.tokens.issue(windowId, key),
					message: entry.confirm as string,
				}
			}
			if (!this.tokens.redeem(token, windowId, key)) throw new Error('The confirmation expired.')
		}
		return { status: 'saved', view: await this.deps.write(change.path, change.value) }
	}
}
