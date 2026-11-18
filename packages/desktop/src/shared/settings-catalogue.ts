/**
 * Every setting the Desktop app owns, described once.
 *
 * The engine describes its own settings (`cli/src/config/settings-descriptors.ts`); this file does the
 * same for the ones the app keeps itself: the preferences in `desktop-settings.json`, the
 * appearance choices the page mirrors for first paint, and the panels (projects, voice, versions)
 * that have no single value. Three things read it and none keeps a second copy:
 *
 * - the validator for a saved or requested change (`settings-protocol.ts`),
 * - the label, help line, default and apply time a row shows (`settings-page.tsx`),
 * - the search list (`settings-model.ts`), which is this file plus the engine's descriptors.
 *
 * Add an entry here and it is validated, drawn, searchable and defaulted with no second edit.
 */
import type { DesktopSettings } from './settings-protocol.js'
import { SETTINGS_SECTIONS, type SettingsSection } from './settings-sections.js'
import { SHELL_CHOICES, SHELL_CHOICE_LABELS } from './terminal-tabs.js'

/** The seconds a turn must run before a "finished" notice is worth showing. */
export const FINISHED_NOTICE_AFTER_SECONDS = 30

/** When a change reaches the work. The same five words the engine uses. */
export type CatalogueAppliesWhen =
	| 'now'
	| 'next-turn'
	| 'next-conversation'
	| 'next-start'
	| 'next-launch'

export const CATALOGUE_APPLIES_TEXT: Readonly<Record<CatalogueAppliesWhen, string>> = {
	now: 'Applies at once.',
	'next-turn': 'Applies from your next message.',
	'next-conversation': 'Applies to new conversations. Open ones keep their current value.',
	'next-start': 'Applies the next time Namzu starts.',
	'next-launch': 'Applies the next time the app opens.',
}

export interface CatalogueOption {
	value: string
	label: string
	help?: string
}

export type CatalogueControl =
	| { kind: 'toggle' }
	| { kind: 'select'; options: readonly CatalogueOption[] }
	/** A page of its own or a list: there is no single value to validate. */
	| { kind: 'panel' }

export type CatalogueOwner =
	/** `desktop-settings.json`, written by the main process. */
	| 'desktop'
	/** The renderer's own storage, mirrored so the first paint is right. */
	| 'renderer-mirror'
	/** A view over state another part of the app owns (projects, versions, voice). */
	| 'view'

export interface CatalogueEntry {
	/** The element id suffix of the row: the page scrolls to `setting-<id>`. */
	id: string
	/** The `DesktopSettings` key it saves to. Absent for a panel and a renderer-owned row. */
	key?: keyof DesktopSettings
	owner: CatalogueOwner
	section: SettingsSection
	label: string
	description: string
	control: CatalogueControl
	/** The value with nothing saved: a switch's on or off, or the chosen option. */
	default?: boolean | string
	appliesWhen: CatalogueAppliesWhen
	/** Replaces the sentence for `appliesWhen` when the plain one would say too much. */
	appliesNote?: string
	/** Search words beyond the label and description. */
	keywords?: readonly string[]
	/** Kept and validated, but with no row of its own, so search does not offer it. */
	hidden?: boolean
}

const toggle: CatalogueControl = { kind: 'toggle' }
const panel: CatalogueControl = { kind: 'panel' }

export const SETTINGS_CATALOGUE: readonly CatalogueEntry[] = [
	// General
	{
		id: 'startup',
		key: 'startup',
		owner: 'desktop',
		section: 'general',
		label: 'When Namzu starts',
		description: 'Continue where you left off, or start on the home screen.',
		control: {
			kind: 'select',
			options: [
				{
					value: 'continue',
					label: 'Continue where I left off',
					help: 'Your windows, tabs and drafts come back.',
				},
				{
					value: 'home',
					label: 'Start on the home screen',
					help: 'Your tabs are kept but not opened.',
				},
			],
		},
		default: 'continue',
		appliesWhen: 'next-launch',
		keywords: ['startup', 'launch', 'open', 'restore', 'tabs', 'home', 'restart', 'on start'],
	},
	{
		id: 'attention-signals',
		key: 'attentionSignals',
		owner: 'desktop',
		section: 'general',
		label: 'Show when a conversation needs you',
		description:
			'While Namzu is in the background and a conversation is waiting for an answer, show a count on its icon and flash the taskbar or dock once. It clears when you come back.',
		control: toggle,
		default: true,
		appliesWhen: 'now',
		keywords: [
			'badge',
			'flash',
			'taskbar',
			'dock',
			'attention',
			'approval',
			'notify',
			'icon',
			'tray',
		],
	},
	{
		id: 'notify-needs-you',
		key: 'notifyNeedsYou',
		owner: 'desktop',
		section: 'general',
		label: 'Notify me when a conversation needs my answer',
		description:
			"A system notification when an approval or a question is waiting and Namzu is in the background. It shows the project's name and nothing from the conversation.",
		control: toggle,
		default: true,
		appliesWhen: 'now',
		keywords: ['notification', 'notify', 'banner', 'alert', 'approval', 'question', 'background'],
	},
	{
		id: 'notify-failed',
		key: 'notifyFailed',
		owner: 'desktop',
		section: 'general',
		label: 'Notify me when a conversation stops with an error',
		description:
			'A system notification when a reply stops with an error and Namzu is in the background.',
		control: toggle,
		default: true,
		appliesWhen: 'now',
		keywords: ['notification', 'notify', 'banner', 'alert', 'error', 'failed', 'background'],
	},
	{
		id: 'notify-finished',
		key: 'notifyFinished',
		owner: 'desktop',
		section: 'general',
		label: 'Notify me when a long reply finishes',
		description: `A system notification when a reply that took ${FINISHED_NOTICE_AFTER_SECONDS} seconds or more is done and Namzu is in the background. A reply you watched end needs none.`,
		control: toggle,
		default: true,
		appliesWhen: 'now',
		keywords: [
			'notification',
			'notify',
			'banner',
			'alert',
			'finished',
			'done',
			'complete',
			'background',
		],
	},
	{
		id: 'notify-sound',
		key: 'notifySound',
		owner: 'desktop',
		section: 'general',
		label: 'Play a sound with notifications',
		description:
			"Off by default. Your system's do-not-disturb setting still applies. The terminal app has its own sound switch under Terminal.",
		control: toggle,
		default: false,
		appliesWhen: 'now',
		keywords: ['notification', 'sound', 'chime', 'audio', 'silent'],
	},
	{
		id: 'terminal-shell',
		key: 'terminalShell',
		owner: 'desktop',
		section: 'general',
		label: 'Default terminal shell',
		description:
			'Automatic uses PowerShell 7 when it is installed and otherwise Command Prompt, which is set to UTF-8. Windows PowerShell can drop some typed Turkish capitals.',
		control: {
			kind: 'select',
			options: SHELL_CHOICES.map((value) => ({ value, label: SHELL_CHOICE_LABELS[value] })),
		},
		default: 'auto',
		appliesWhen: 'now',
		appliesNote: 'Applies to new terminal tabs. Open ones keep their shell.',
		keywords: ['terminal', 'shell', 'powershell', 'cmd', 'command prompt', 'wsl', 'console'],
	},
	{
		id: 'terminal-restore',
		key: 'restoreTerminals',
		owner: 'desktop',
		section: 'general',
		label: 'Bring terminal tabs back',
		description:
			'After a restart, terminal tabs return as ended terminals with their last screen. Their programs do not keep running while Namzu is closed.',
		control: toggle,
		default: true,
		appliesWhen: 'next-launch',
		keywords: ['terminal', 'restore', 'restart', 'tabs'],
	},
	{
		id: 'hardware-acceleration',
		key: 'hardwareAcceleration',
		owner: 'desktop',
		section: 'general',
		label: 'Use the graphics card',
		description:
			'Turn this off if Namzu’s windows flicker, go blank or stop working soon after they open.',
		control: toggle,
		default: true,
		appliesWhen: 'next-launch',
		keywords: ['gpu', 'graphics', 'acceleration', 'flicker', 'blank', 'crash', 'rendering'],
	},
	{
		id: 'voice-consent',
		key: 'voiceInputAccepted',
		owner: 'desktop',
		section: 'speech',
		label: 'Voice input permission',
		description: 'You agreed once that Namzu’s own windows may open the microphone.',
		control: toggle,
		default: false,
		appliesWhen: 'now',
		hidden: true,
	},

	// Models
	{
		id: 'models',
		owner: 'view',
		section: 'models',
		label: 'Models and API keys',
		description:
			'Connect a provider: paste an API key, or use a Claude or ChatGPT sign-in Namzu finds. Check or remove a key.',
		control: panel,
		appliesWhen: 'next-conversation',
		keywords: [
			'provider',
			'api key',
			'key',
			'anthropic',
			'claude',
			'openai',
			'chatgpt',
			'codex',
			'gemini',
			'google',
			'sign in',
			'connect',
			'login',
			'zen',
			'free',
		],
	},

	// Tools
	{
		id: 'mcpServers',
		owner: 'view',
		section: 'tools',
		label: 'Tool servers',
		description:
			'The servers that give Namzu more tools in the open project: where each is set up and whether it is running.',
		control: panel,
		appliesWhen: 'next-conversation',
		keywords: [
			'connected servers',
			'connected',
			'servers',
			'mcp',
			'connectors',
			'approve',
			'mcp.json',
		],
	},
	{
		id: 'runHooks',
		owner: 'view',
		section: 'tools',
		label: 'Run hooks',
		description:
			'Switch off the commands your settings, plugins, skills and agent files start by themselves at set moments.',
		control: panel,
		appliesWhen: 'next-conversation',
		keywords: ['hooks', 'disable', 'turn off', 'automatic', 'commands', 'disableHooks'],
	},
	{
		id: 'hooks',
		owner: 'view',
		section: 'tools',
		label: 'Hooks',
		description:
			'What runs by itself in the open project: each hook, when it runs, where it comes from and whether it is on.',
		control: panel,
		appliesWhen: 'next-conversation',
		keywords: ['hooks', 'automatic', 'commands', 'plugin', 'skill', 'agent', 'pre_tool_use'],
	},

	// Projects
	{
		id: 'projects',
		owner: 'view',
		section: 'projects',
		label: 'Your projects',
		description:
			'The folders Namzu knows. Remove one from Namzu without deleting any files. Locate points a moved project at its new folder and asks you to trust that folder.',
		control: panel,
		appliesWhen: 'now',
		keywords: ['remove', 'folder', 'trusted', 'forget', 'locate', 'move', 'trust'],
	},
	{
		id: 'retrust',
		key: 'retrustOnConfigChange',
		owner: 'desktop',
		section: 'projects',
		label: 'Ask again when a project’s automatic settings change',
		description:
			'Before a trusted project loads hooks, servers or plugins that changed since you trusted it, Namzu asks again.',
		control: toggle,
		default: true,
		appliesWhen: 'next-turn',
		appliesNote:
			'Applies the next time a project opens, or at your next message in one that is open.',
		keywords: ['trust', 'hooks', 'mcp', 'config', 'security'],
	},

	// Appearance
	{
		id: 'theme',
		owner: 'renderer-mirror',
		section: 'appearance',
		label: 'Theme',
		description: 'System follows your device’s light or dark setting.',
		control: {
			kind: 'select',
			options: [
				{ value: 'light', label: 'Light' },
				{ value: 'dark', label: 'Dark' },
				{ value: 'system', label: 'System', help: 'Follows your device’s light or dark setting.' },
			],
		},
		default: 'system',
		appliesWhen: 'now',
		keywords: ['dark', 'light', 'system', 'color', 'colour', 'mode'],
	},
	{
		id: 'interface-font',
		owner: 'renderer-mirror',
		section: 'appearance',
		label: 'Interface font',
		description: 'The typeface for text and code in Namzu. The terminal keeps its own font.',
		control: {
			kind: 'select',
			options: [
				{ value: 'app', label: 'Namzu’s own', help: 'Geist, with Geist Mono for code.' },
				{
					value: 'system',
					label: 'Your device’s',
					help: 'The fonts your system uses for text and code.',
				},
			],
		},
		default: 'app',
		appliesWhen: 'now',
		keywords: [
			'font',
			'typeface',
			'type',
			'geist',
			'system',
			'text',
			'mono',
			'code',
			'ui font',
			'chat font',
			'text size',
			'size',
		],
	},
	{
		id: 'conversation-tabs',
		key: 'showConversationTabs',
		owner: 'desktop',
		section: 'appearance',
		label: 'Show conversation tabs',
		description:
			'A strip of tabs above the conversation, one for each open conversation. Off, the sidebar lists your conversations and the bar above shows the one you are in. Also in the View menu.',
		control: toggle,
		default: false,
		appliesWhen: 'now',
		keywords: ['tabs', 'strip', 'bar', 'conversations', 'window', 'layout'],
	},

	{
		id: 'last-settings-section',
		key: 'lastSettingsSection',
		owner: 'desktop',
		section: 'general',
		label: 'Last section of Settings',
		description: 'Settings opens on the section you looked at last.',
		control: {
			kind: 'select',
			options: SETTINGS_SECTIONS.map((value) => ({
				value,
				label: value.charAt(0).toUpperCase() + value.slice(1),
			})),
		},
		default: 'general',
		appliesWhen: 'now',
		hidden: true,
	},

	// Updates
	{
		id: 'version',
		owner: 'view',
		section: 'updates',
		label: 'Namzu Desktop version',
		description: 'The version you have, when Namzu last checked, and a button to check now.',
		control: panel,
		appliesWhen: 'now',
		keywords: ['version', 'upgrade', 'download', 'restart', 'latest', 'check for updates'],
	},
	{
		id: 'auto-download',
		key: 'autoDownloadUpdates',
		owner: 'desktop',
		section: 'updates',
		label: 'Download updates automatically',
		description:
			'When off, a new version is only offered with a badge, and nothing is downloaded until you ask.',
		control: toggle,
		default: true,
		appliesWhen: 'now',
		appliesNote: 'Applies from the next check for updates.',
		keywords: ['update', 'background', 'badge'],
	},
	{
		id: 'engine-delivery',
		owner: 'view',
		section: 'updates',
		label: 'Namzu engine',
		description: 'Which engine is running, where it came from and what the last check found.',
		control: panel,
		appliesWhen: 'now',
		keywords: ['engine', 'kernel', 'command line', 'version', 'feed'],
	},
	{
		id: 'keep-engine',
		key: 'keepEngineUpToDate',
		owner: 'desktop',
		section: 'updates',
		label: 'Keep the engine up to date',
		description:
			'Namzu fetches a newer engine in the background and starts it the next time a project opens. Off, only the engine this app was installed with runs.',
		control: toggle,
		default: true,
		appliesWhen: 'next-start',
		appliesNote: 'A newer engine starts the next time a project opens.',
		keywords: ['engine', 'kernel', 'update', 'background', 'command line'],
	},

	// Speech
	{
		id: 'voice',
		owner: 'view',
		section: 'speech',
		label: 'Voice',
		description: 'Turkish speech that runs on this device: download, remove and options.',
		control: panel,
		appliesWhen: 'now',
		keywords: ['speech', 'tts', 'read aloud', 'install', 'remove', 'turkish', 'language'],
	},
	{
		id: 'voice-input',
		owner: 'view',
		section: 'speech',
		label: 'Voice input',
		description: 'Talk to Namzu in Turkish: download, remove and microphone permission.',
		control: panel,
		appliesWhen: 'now',
		keywords: ['microphone', 'mic', 'speech to text', 'dictation', 'talk', 'listen', 'turkish'],
	},

	// About
	{
		id: 'about',
		owner: 'view',
		section: 'about',
		label: 'About Namzu',
		description: 'Versions of the app and its command line.',
		control: panel,
		appliesWhen: 'now',
		keywords: ['version', 'cli', 'sdk', 'build'],
	},
	{
		id: 'folders',
		owner: 'view',
		section: 'about',
		label: 'Data folders',
		description: 'Where Namzu keeps its files, and a way to open them.',
		control: panel,
		appliesWhen: 'now',
		keywords: ['explorer', 'finder', 'logs', 'diagnostics', 'storage', 'open'],
	},
]

/** The entries that save to `desktop-settings.json`. */
export const DESKTOP_KEYED_ENTRIES: readonly (CatalogueEntry & { key: keyof DesktopSettings })[] =
	SETTINGS_CATALOGUE.filter(
		(entry): entry is CatalogueEntry & { key: keyof DesktopSettings } => entry.key !== undefined,
	)

export function catalogueEntry(id: string): CatalogueEntry {
	const entry = SETTINGS_CATALOGUE.find((item) => item.id === id)
	if (!entry) throw new Error(`No setting is described as ${id}.`)
	return entry
}

/** The sentence a row says about when its change applies. */
export function appliesText(entry: CatalogueEntry): string {
	return entry.appliesNote ?? CATALOGUE_APPLIES_TEXT[entry.appliesWhen]
}

/** Whether `value` is one this entry's control can hold. */
export function catalogueAccepts(entry: CatalogueEntry, value: unknown): boolean {
	if (entry.control.kind === 'toggle') return typeof value === 'boolean'
	if (entry.control.kind === 'select')
		return entry.control.options.some((option) => option.value === value)
	return false
}
