import type { CodeThemeKey } from './code-themes.js'
/**
 * Desktop preferences the main process acts on. Renderer-only cosmetic ones (theme, sidebar
 * width) stay in the renderer's own storage; nothing here is a secret or a path.
 */
import {
	DESKTOP_KEYED_ENTRIES,
	FINISHED_NOTICE_AFTER_SECONDS,
	catalogueAccepts,
} from './settings-catalogue.js'
import { SETTINGS_SECTIONS, type SettingsSection, isSettingsSection } from './settings-sections.js'
import type { ShellChoice } from './terminal-tabs.js'

export type StartupBehavior = 'continue' | 'home'
export type TranscriptTextSize = 'small' | 'medium' | 'large'
export type TranscriptWidth = 'narrow' | 'medium' | 'wide'
export type BrowserCookieScope = 'quit' | 'restarts' | 'conversation'
/** Where the agent's own browser work happens: a tab of the Browser pane, or a browser window of its own. */
export type AgentBrowserPlace = 'pane' | 'window'
export type MotionChoice = 'system' | 'reduce' | 'full'
/** `badge` is the count on the app icon only; `banner` is a system notification (and the count, while the icon count is on). */
export type NoticeLevel = 'off' | 'badge' | 'banner'
export type BannerLevel = 'off' | 'banner'
export type NoticeSound = 'system' | 'none'

export interface DesktopSettings {
	/** What the app shows when it starts. */
	startup: StartupBehavior
	/** Ask again before a trusted project's automatic settings are loaded after they changed. */
	retrustOnConfigChange: boolean
	/** Download an update as soon as it is found; when off, only the badge offers a download. */
	autoDownloadUpdates: boolean
	/**
	 * Keep the engine the app runs current by itself, in the background. When off, nothing is
	 * asked of the network for it and the app runs the engine it was installed with.
	 */
	keepEngineUpToDate: boolean
	/** The shell a plain terminal tab opens. Elsewhere than Windows only `auto` applies. */
	terminalShell: ShellChoice
	/** Restore terminal tabs after a restart, as ended terminals showing their last screen. */
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
	/** What a permission request does while no Namzu window is focused: nothing, a count on the icon, or a system notification. */
	notifyPermission: NoticeLevel
	/** The same for a question Namzu puts to the person. */
	notifyQuestion: NoticeLevel
	/** A system notification when a reply finishes, but only one that took `notifyLongReplySeconds` or longer. */
	notifyTaskComplete: BannerLevel
	/** A system notification when a reply stops with an error, however long it ran. */
	notifyError: BannerLevel
	/** Seconds a reply must take before its end is worth a notification; a shorter one never notifies. */
	notifyLongReplySeconds: number
	/** What a notification sounds like: the system's own sound, or none. */
	notificationSound: NoticeSound
	/**
	 * Show the strip of conversation tabs above the conversation. Off by default: the sidebar is
	 * the one list of conversations, and the bar above the conversation carries its title.
	 */
	showConversationTabs: boolean
	/**
	 * The typeface of replies. `match` follows the interface font; `app` and `system` name the two
	 * built-in stacks; anything else is the name of a font installed on this computer.
	 */
	responseFont: string
	/** How large the words of a conversation are. `medium` is the size Namzu has always had. */
	transcriptTextSize: TranscriptTextSize
	/** How wide the conversation and the composer are. `narrow` is the width Namzu has always had. */
	transcriptWidth: TranscriptWidth
	/** `system` follows the device's reduce-motion flag; `reduce` and `full` decide on their own. */
	motion: MotionChoice
	/** Notices leave by themselves after a few seconds. Off, each stays until it is closed. */
	autoDismissPopups: boolean
	/** Conversations and the conversation list leave what is off screen undrawn. */
	virtualizeConversations: boolean
	/** The colour set of code while the window is light (a `CODE_THEMES` value). */
	lightCodeTheme: CodeThemeKey
	/** The colour set of code while the window is dark. */
	darkCodeTheme: CodeThemeKey
	/** The font of code, diffs, file views and the Desktop terminal; empty is Namzu's own. */
	codeFont: string
	/** The size in px of code and terminal text; 13 is what Namzu has always drawn. */
	codeFontSize: number
	/** Open Namzu when the person signs in to the computer (Windows and macOS). The OS keeps the real state. */
	runOnStartup: boolean
	/** Keep a tray icon (menu bar on macOS) and keep running when the last window closes. */
	systemTray: boolean
	/** Block idle system sleep while Namzu is open. The display may still sleep. */
	keepAwakeAppOpen: boolean
	/** Block idle system sleep while at least one conversation is working. */
	keepAwakeWhileWorking: boolean
	/** Also block it while the computer runs on battery. Only read when `keepAwakeWhileWorking` is on. */
	keepAwakeOnBattery: boolean
	/** Wait with downloads Namzu starts by itself while the connection is metered. */
	pauseOnMetered: boolean
	/** Global keys that open the Quick Entry box; empty is off. Stored as `Ctrl+Alt+Space`. */
	quickEntryShortcut: string
	/** The keys that start and stop voice input in the message box: `ctrl-d`, `ctrl-shift-d` or `off`. */
	dictationShortcut: string
	/** Global keys that bring Namzu forward and start voice input; empty is off. */
	voiceShortcut: string
	/** Open a page or picture a turn writes in the built-in browser, and a document in Files, as it is written. */
	autoOpenFiles: boolean
	/**
	 * How long the built-in browser keeps sign-ins: one shared set until the app quits, a set kept
	 * on disk across restarts, or a set for each conversation. Read when a tab is made.
	 */
	browserCookies: BrowserCookieScope
	/**
	 * Where the agent's browser work runs: a tab of the built-in browser, or a browser window of its
	 * own. Read when a project's engine starts, and again at each request for a tab.
	 */
	agentBrowser: AgentBrowserPlace
	/** A link in a reply opens in the built-in browser; off, in the system's default browser. */
	openLinksInBrowser: boolean
	/** The section the Settings dialog was last on; it opens there again, also after a restart. */
	lastSettingsSection: SettingsSection
}

/** The values with nothing saved, read from the catalogue so there is one place to change them. */
export const DEFAULT_DESKTOP_SETTINGS: Readonly<DesktopSettings> = Object.fromEntries(
	DESKTOP_KEYED_ENTRIES.map((entry) => [entry.key, entry.default]),
) as unknown as DesktopSettings

/** The default for `notifyLongReplySeconds`, in ms: a turn you just watched end does not need a notification. */
export const FINISHED_NOTICE_AFTER_MS = FINISHED_NOTICE_AFTER_SECONDS * 1000
export { FINISHED_NOTICE_AFTER_SECONDS }

const KEYS = DESKTOP_KEYED_ENTRIES.map((entry) => entry.key)

function valid(key: keyof DesktopSettings, value: unknown): boolean {
	const entry = DESKTOP_KEYED_ENTRIES.find((item) => item.key === key)
	return entry !== undefined && catalogueAccepts(entry, value)
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
	const record = withLegacyNotices(value as Record<string, unknown>)
	for (const key of KEYS)
		if (valid(key, record[key])) (settings as unknown as Record<string, unknown>)[key] = record[key]
	return settings
}

/**
 * A file saved while notifications were four switches: `notifyNeedsYou`, `notifyFailed`,
 * `notifyFinished` and `notifySound`. A new key that is saved wins; one that is missing reads from
 * the old switch. On becomes Banner. Off becomes Off for a banner of its own, but a permission
 * request or question keeps the icon count the person still had, so it reads Badge only unless
 * the icon count was off too.
 */
function withLegacyNotices(record: Record<string, unknown>): Record<string, unknown> {
	const next = { ...record }
	const missing = (key: string) => next[key] === undefined
	const legacy = (key: string): boolean | undefined =>
		typeof record[key] === 'boolean' ? (record[key] as boolean) : undefined
	const needsYou = legacy('notifyNeedsYou')
	if (needsYou !== undefined) {
		const level = needsYou ? 'banner' : record.attentionSignals === false ? 'off' : 'badge'
		if (missing('notifyPermission')) next.notifyPermission = level
		if (missing('notifyQuestion')) next.notifyQuestion = level
	}
	const failed = legacy('notifyFailed')
	if (failed !== undefined && missing('notifyError')) next.notifyError = failed ? 'banner' : 'off'
	const finished = legacy('notifyFinished')
	if (finished !== undefined && missing('notifyTaskComplete'))
		next.notifyTaskComplete = finished ? 'banner' : 'off'
	const sound = legacy('notifySound')
	if (sound !== undefined && missing('notificationSound'))
		next.notificationSound = sound ? 'system' : 'none'
	return next
}

export { SETTINGS_SECTIONS, isSettingsSection, type SettingsSection }

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
