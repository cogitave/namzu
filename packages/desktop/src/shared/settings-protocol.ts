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
	/** Bring terminal tabs back after a restart, as ended terminals showing their last screen. */
	restoreTerminals: boolean
	/** The person agreed to voice input once: the microphone may be opened by Namzu's own windows. */
	voiceInputAccepted: boolean
	/**
	 * Draw windows with the graphics card. Turn it off when windows flicker, go blank or crash at
	 * start; it is read once, before the app is ready, so a change applies on the next start.
	 */
	hardwareAcceleration: boolean
	/**
	 * While Namzu is in the background and a conversation waits for an answer, show a count on its
	 * icon and flash the taskbar or dock once.
	 */
	attentionSignals: boolean
	/** A system notification while no Namzu window is focused and a conversation needs an answer. */
	notifyNeedsYou: boolean
	/** The same when a turn stops with an error. */
	notifyFailed: boolean
	/** The same when a turn finishes, but only a turn that ran `FINISHED_NOTICE_AFTER_MS` or longer. */
	notifyFinished: boolean
	/** Let a notification make the system's sound. Off by default. */
	notifySound: boolean
	/**
	 * Show the strip of conversation tabs above the conversation. Off by default: the sidebar is
	 * the one list of conversations, and the bar above the conversation carries its title.
	 */
	showConversationTabs: boolean
}

export const DEFAULT_DESKTOP_SETTINGS: Readonly<DesktopSettings> = {
	startup: 'continue',
	retrustOnConfigChange: true,
	autoDownloadUpdates: true,
	terminalShell: 'auto',
	restoreTerminals: true,
	voiceInputAccepted: false,
	hardwareAcceleration: true,
	attentionSignals: true,
	notifyNeedsYou: true,
	notifyFailed: true,
	notifyFinished: true,
	notifySound: false,
	showConversationTabs: false,
}

/** A turn you just watched end does not need a notification: only one that ran this long or longer does. */
export const FINISHED_NOTICE_AFTER_MS = 30_000
/** The same, in whole seconds, for the words in Settings. */
export const FINISHED_NOTICE_AFTER_SECONDS = FINISHED_NOTICE_AFTER_MS / 1000

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
	'agent',
	'tools',
	'projects',
	'appearance',
	'terminal',
	'telemetry',
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
	/** A separate Namzu command line found on this computer's PATH, when there is one. */
	installedCliVersion?: string
	sdkVersion?: string
	platform: string
	folders: { kind: DataFolderKind; label: string; path: string }[]
}
