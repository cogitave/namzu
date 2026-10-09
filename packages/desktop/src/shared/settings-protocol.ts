/**
 * Desktop preferences the main process acts on. Renderer-only cosmetic ones (theme, sidebar
 * width) stay in the renderer's own storage; nothing here is a secret or a path.
 */
import { SHELL_CHOICES, type ShellChoice } from './terminal-tabs.js'

export type StartupBehavior = 'continue' | 'home'

export interface DesktopSettings {
	/** What the app shows when it starts. */
	startup: StartupBehavior
	/** Ask again before a trusted project's automatic settings are loaded after they changed. */
	retrustOnConfigChange: boolean
	/** Download an update as soon as it is found; when off, only the badge offers a download. */
	autoDownloadUpdates: boolean
	/** The shell a plain terminal tab opens. Elsewhere than Windows only `auto` applies. */
	terminalShell: ShellChoice
	/** Bring terminal tabs back after a restart, as ended sessions showing their last screen. */
	restoreTerminals: boolean
}

export const DEFAULT_DESKTOP_SETTINGS: Readonly<DesktopSettings> = {
	startup: 'continue',
	retrustOnConfigChange: true,
	autoDownloadUpdates: true,
	terminalShell: 'auto',
	restoreTerminals: true,
}

const KEYS = Object.keys(DEFAULT_DESKTOP_SETTINGS) as (keyof DesktopSettings)[]

function valid(key: keyof DesktopSettings, value: unknown): boolean {
	if (key === 'startup') return value === 'continue' || value === 'home'
	if (key === 'terminalShell')
		return typeof value === 'string' && (SHELL_CHOICES as readonly string[]).includes(value)
	return typeof value === 'boolean'
}

/** A change request from the renderer: known keys only, every value checked. */
export function desktopSettingsPatch(value: unknown): Partial<DesktopSettings> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid settings change.')
	const record = value as Record<string, unknown>
	const patch: Record<string, unknown> = {}
	for (const key of Object.keys(record)) {
		if (!(KEYS as string[]).includes(key)) throw new Error('Unknown setting.')
		if (!valid(key as keyof DesktopSettings, record[key])) throw new Error('Invalid setting value.')
		patch[key] = record[key]
	}
	return patch as Partial<DesktopSettings>
}

/**
 * The answer to a settings change. A change that lowers a safeguard is not applied on the
 * renderer's word alone: main answers `confirm` with a one-time token bound to that window and
 * that exact patch, and applies it only when the same patch comes back with the token.
 */
export type SettingsChangeResult =
	| { status: 'saved'; settings: DesktopSettings }
	| { status: 'confirm'; settings: DesktopSettings; token: string }

/** What was saved. A hand-edited or older file never blocks the app: bad entries fall back. */
export function storedDesktopSettings(value: unknown): DesktopSettings {
	const settings: DesktopSettings = { ...DEFAULT_DESKTOP_SETTINGS }
	if (!value || typeof value !== 'object' || Array.isArray(value)) return settings
	const record = value as Record<string, unknown>
	for (const key of KEYS)
		if (valid(key, record[key])) (settings as unknown as Record<string, unknown>)[key] = record[key]
	return settings
}

export const SETTINGS_SECTIONS = [
	'general',
	'models',
	'projects',
	'appearance',
	'updates',
	'speech',
	'about',
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export function isSettingsSection(value: unknown): value is SettingsSection {
	return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** The folders a person may open from About. Main resolves the kind to a path. */
export type DataFolderKind = 'app' | 'namzu' | 'diagnostics' | 'speech'

export interface DesktopInfo {
	version: string
	/** Absent when the bundled runtime cannot be read. */
	cliVersion?: string
	sdkVersion?: string
	platform: string
	folders: { kind: DataFolderKind; label: string; path: string }[]
	/** The third-party notices shipped with this build, bounded; absent when not found. */
	notices?: string
}
