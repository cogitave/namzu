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
import {
	CODE_FONT_SIZE_DEFAULT,
	CODE_FONT_SIZE_MAX,
	CODE_FONT_SIZE_MIN,
	CODE_THEMES,
} from './code-themes.js'
import type { DesktopSettings } from './settings-protocol.js'
import { SETTINGS_SECTIONS, type SettingsSection } from './settings-sections.js'
import { DICTATION_CHOICES, isShortcutSetting } from './shortcuts.js'
import { SHELL_CHOICES, SHELL_CHOICE_LABELS } from './terminal-tabs.js'

/** The response font's value when it follows the interface font. */
export const RESPONSE_FONT_MATCH = 'match'

/** What an installed font's name is stored under, so it can never be read as `match`, `app` or `system`. */
export const FONT_FAMILY_PREFIX = 'family:'

/** The font name inside a stored `family:<name>` value, if it holds a safe one. */
export function storedFamily(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.startsWith(FONT_FAMILY_PREFIX)) return undefined
	const name = value.slice(FONT_FAMILY_PREFIX.length)
	return isSafeFontName(name) ? name : undefined
}

/**
 * What a font name may hold. Letters, digits, spaces and a few marks: nothing that could close a
 * quoted CSS string or start another declaration. `public/theme-boot.js` keeps the same test.
 */
export const FONT_NAME_PATTERN = /^[\p{L}\p{N} ._()+&-]+$/u

/** Whether `value` is a name a font-family declaration can carry safely. */
export function isSafeFontName(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 80 && FONT_NAME_PATTERN.test(value)
}

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
	/** A short piece of text such as a font name. Letters, digits, spaces and `. _ ( ) + & -` only. */
	| { kind: 'text'; maxLength: number; placeholder?: string }
	/** A whole number from `min` to `max`, drawn as a list of the sizes. */
	| { kind: 'number'; min: number; max: number; unit: string }
	/** A key combination pressed into a box, stored as `Ctrl+Alt+Space`; empty is off. */
	| { kind: 'shortcut'; placeholder?: string }
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
	default?: boolean | string | number
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
		section: 'terminal',
		label: 'Default terminal shell',
		description:
			'Windows only. Automatic uses PowerShell 7 when it is installed and otherwise Command Prompt, which is set to UTF-8. Windows PowerShell can drop some typed Turkish capitals.',
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
		section: 'terminal',
		label: 'Bring terminal tabs back',
		description:
			'After a restart, terminal tabs return as ended terminals with their last screen. Their programs do not keep running while Namzu is closed.',
		control: toggle,
		default: true,
		appliesWhen: 'next-launch',
		keywords: ['terminal', 'restore', 'restart', 'tabs'],
	},
	{
		id: 'terminal-code-link',
		owner: 'view',
		section: 'terminal',
		label: 'Code font and colours',
		description:
			'The terminal draws in the code font and size. They are set under Appearance, with the colours of code.',
		control: panel,
		appliesWhen: 'now',
		keywords: ['terminal', 'font', 'font size', 'colours', 'colors', 'code', 'appearance', 'theme'],
	},

	{
		id: 'hardware-acceleration',
		key: 'hardwareAcceleration',
		owner: 'desktop',
		section: 'desktop',
		label: 'Use the graphics card',
		description:
			'Turn this off if Namzu’s windows flicker, go blank or stop working soon after they open.',
		control: toggle,
		default: true,
		appliesWhen: 'next-launch',
		keywords: ['gpu', 'graphics', 'acceleration', 'flicker', 'blank', 'crash', 'rendering'],
	},
	{
		id: 'run-on-startup',
		key: 'runOnStartup',
		owner: 'desktop',
		section: 'desktop',
		label: 'Run on startup',
		description:
			'Open Namzu by itself when you sign in to this computer. Available on Windows and macOS.',
		control: toggle,
		default: false,
		appliesWhen: 'now',
		appliesNote: 'Applies at once. The row shows what your system says.',
		keywords: ['login', 'sign in', 'boot', 'autostart', 'launch', 'startup items', 'open at login'],
	},
	{
		id: 'system-tray',
		key: 'systemTray',
		owner: 'desktop',
		section: 'desktop',
		label: 'System tray',
		description:
			'Show a Namzu icon beside the clock. Closing the window then leaves Namzu running, so conversations keep working. Choose Quit from the icon to close it. Off, closing the last window quits Namzu.',
		control: toggle,
		default: true,
		appliesWhen: 'now',
		keywords: [
			'tray',
			'menu bar',
			'notification area',
			'background',
			'keep running',
			'close',
			'quit',
		],
	},
	{
		id: 'keep-awake',
		key: 'keepAwakeAppOpen',
		owner: 'desktop',
		section: 'desktop',
		label: 'Keep computer awake',
		description:
			'Stop the computer from going to sleep on its own while Namzu is open. The screen can still turn off, and closing a laptop lid still puts it to sleep.',
		control: toggle,
		default: false,
		appliesWhen: 'now',
		keywords: ['sleep', 'suspend', 'idle', 'power', 'awake', 'scheduled', 'caffeine'],
	},
	{
		id: 'pause-on-metered',
		key: 'pauseOnMetered',
		owner: 'desktop',
		section: 'desktop',
		label: 'Pause downloads on low data',
		description:
			'While this connection is metered, wait with the downloads Namzu starts by itself, such as a new version of the app or its engine. Downloads you start yourself still go. Available on Windows.',
		control: toggle,
		default: true,
		appliesWhen: 'now',
		keywords: ['metered', 'data', 'cellular', 'hotspot', 'bandwidth', 'download', 'low data'],
	},
	{
		id: 'quick-entry-shortcut',
		key: 'quickEntryShortcut',
		owner: 'desktop',
		section: 'desktop',
		label: 'Quick Entry shortcut',
		description:
			'Press it anywhere to open a small box. Type a line and press Enter to start a new conversation with it. Escape closes the box.',
		control: { kind: 'shortcut', placeholder: 'Ctrl+Alt+Space' },
		default: 'Ctrl+Alt+Space',
		appliesWhen: 'now',
		keywords: ['hotkey', 'global', 'quick', 'launcher', 'new conversation', 'shortcut', 'keys'],
	},
	{
		id: 'dictation-shortcut',
		key: 'dictationShortcut',
		owner: 'desktop',
		section: 'desktop',
		label: 'Dictation shortcut',
		description: 'In the message box, start or stop voice input with these keys.',
		control: {
			kind: 'select',
			options: DICTATION_CHOICES.map(({ value, label }) => ({ value, label })),
		},
		default: 'ctrl-d',
		appliesWhen: 'now',
		keywords: ['hotkey', 'voice', 'microphone', 'speak', 'dictate', 'shortcut', 'keys'],
	},
	{
		id: 'voice-shortcut',
		key: 'voiceShortcut',
		owner: 'desktop',
		section: 'desktop',
		label: 'Voice shortcut',
		description:
			'Press it anywhere to bring Namzu forward and start voice input in the message box. Off until you set it.',
		control: { kind: 'shortcut', placeholder: 'Off' },
		default: '',
		appliesWhen: 'now',
		keywords: ['hotkey', 'global', 'voice', 'microphone', 'speak', 'shortcut', 'keys'],
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

	// Agent
	{
		id: 'keep-awake-working',
		key: 'keepAwakeWhileWorking',
		owner: 'desktop',
		section: 'agent',
		label: 'Keep computer awake while working',
		description:
			'Stop the computer from going to sleep on its own while a conversation is working. It ends when none is.',
		control: toggle,
		default: false,
		appliesWhen: 'now',
		keywords: ['sleep', 'suspend', 'idle', 'power', 'awake', 'running', 'turn'],
	},
	{
		id: 'keep-awake-battery',
		key: 'keepAwakeOnBattery',
		owner: 'desktop',
		section: 'agent',
		label: 'Keep awake on battery power',
		description:
			'Also keep the computer awake while it runs on battery. Off, Namzu lets it sleep whenever it is unplugged.',
		control: toggle,
		default: false,
		appliesWhen: 'now',
		keywords: ['sleep', 'battery', 'unplugged', 'laptop', 'power'],
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
			'The servers that give Namzu more tools: where each is set up and whether it is running. Add, change or remove the ones in your own settings here.',
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
				{ value: 'system', label: 'System', help: 'Follows your device’s light or dark setting.' },
				{ value: 'light', label: 'Light' },
				{ value: 'dark', label: 'Dark' },
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
		description:
			'The typeface of the interface: Namzu’s own, your device’s, or a font installed on this computer. Code and the terminal use the Code font below.',
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
			'installed',
		],
	},
	{
		id: 'response-font',
		key: 'responseFont',
		owner: 'desktop',
		section: 'appearance',
		label: 'Response font',
		description:
			'The typeface of the replies in a conversation. Match interface follows the interface font. Code keeps the code font.',
		control: { kind: 'text', maxLength: 90, placeholder: 'Match interface' },
		default: RESPONSE_FONT_MATCH,
		appliesWhen: 'now',
		keywords: ['font', 'typeface', 'reply', 'replies', 'answer', 'chat font', 'serif', 'reading'],
	},
	{
		id: 'transcript-text-size',
		key: 'transcriptTextSize',
		owner: 'desktop',
		section: 'appearance',
		label: 'Transcript text size',
		description: 'How large the words of a conversation are, and the space between its lines.',
		control: {
			kind: 'select',
			options: [
				{ value: 'small', label: 'Small', help: '14 px text on a 20 px line.' },
				{ value: 'medium', label: 'Medium', help: '15 px text on a 22 px line.' },
				{ value: 'large', label: 'Large', help: '17 px text on a 26 px line.' },
			],
		},
		default: 'medium',
		appliesWhen: 'now',
		keywords: ['font size', 'text size', 'zoom', 'bigger', 'smaller', 'reading', 'line height'],
	},
	{
		id: 'transcript-width',
		key: 'transcriptWidth',
		owner: 'desktop',
		section: 'appearance',
		label: 'Transcript width',
		description: 'How wide the conversation and the box you type in are.',
		control: {
			kind: 'select',
			options: [
				{ value: 'narrow', label: 'Narrow', help: 'The width Namzu has always had.' },
				{ value: 'medium', label: 'Medium', help: '128 px wider.' },
				{ value: 'wide', label: 'Wide', help: '256 px wider.' },
			],
		},
		default: 'narrow',
		appliesWhen: 'now',
		keywords: ['column', 'wide', 'narrow', 'layout', 'width', 'measure'],
	},
	{
		id: 'motion',
		key: 'motion',
		owner: 'desktop',
		section: 'appearance',
		label: 'Motion',
		description:
			'System follows your device’s reduce-motion setting. Reduce stops the streaming and panel animations. Full keeps them even when your device asks for less.',
		control: {
			kind: 'select',
			options: [
				{ value: 'system', label: 'System' },
				{ value: 'reduce', label: 'Reduce' },
				{ value: 'full', label: 'Full' },
			],
		},
		default: 'system',
		appliesWhen: 'now',
		keywords: [
			'animation',
			'animations',
			'reduce motion',
			'reduced motion',
			'accessibility',
			'transition',
		],
	},
	{
		id: 'code-theme-light',
		key: 'lightCodeTheme',
		owner: 'desktop',
		section: 'appearance',
		label: 'Light code colours',
		description:
			'The colours of code in replies, diffs and file views while Namzu is light. The card below shows a sample.',
		control: {
			kind: 'select',
			options: CODE_THEMES.map(({ value, label, help }) => ({ value, label, help })),
		},
		default: 'default',
		appliesWhen: 'now',
		keywords: ['code', 'syntax', 'highlight', 'colour', 'color', 'theme', 'diff', 'light'],
	},
	{
		id: 'code-theme-dark',
		key: 'darkCodeTheme',
		owner: 'desktop',
		section: 'appearance',
		label: 'Dark code colours',
		description:
			'The colours of code in replies, diffs and file views while Namzu is dark. The card below shows a sample.',
		control: {
			kind: 'select',
			options: CODE_THEMES.map(({ value, label, help }) => ({ value, label, help })),
		},
		default: 'default',
		appliesWhen: 'now',
		keywords: ['code', 'syntax', 'highlight', 'colour', 'color', 'theme', 'diff', 'dark'],
	},
	{
		id: 'code-font',
		key: 'codeFont',
		owner: 'desktop',
		section: 'appearance',
		label: 'Code font',
		description:
			'A monospace font, such as one installed on this computer. Used by code blocks, diffs, file views and the terminal in Namzu. Empty keeps Namzu’s own.',
		control: { kind: 'text', maxLength: 80, placeholder: 'Namzu’s own' },
		default: '',
		appliesWhen: 'now',
		keywords: ['font', 'monospace', 'mono', 'typeface', 'terminal', 'diff', 'code', 'ligature'],
	},
	{
		id: 'code-font-size',
		key: 'codeFontSize',
		owner: 'desktop',
		section: 'appearance',
		label: 'Code font size',
		description: 'The size of text in code blocks, diffs, file views and the terminal.',
		control: { kind: 'number', min: CODE_FONT_SIZE_MIN, max: CODE_FONT_SIZE_MAX, unit: 'px' },
		default: CODE_FONT_SIZE_DEFAULT,
		appliesWhen: 'now',
		keywords: ['font size', 'text size', 'code', 'terminal', 'bigger', 'smaller', 'zoom'],
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
		id: 'auto-dismiss-popups',
		key: 'autoDismissPopups',
		owner: 'desktop',
		section: 'appearance',
		label: 'Close popups by themselves',
		description:
			'The short notices at the bottom of a conversation leave after a few seconds. Off, each one stays until you close it.',
		control: toggle,
		default: true,
		appliesWhen: 'now',
		keywords: [
			'toast',
			'toasts',
			'notice',
			'notification',
			'popup',
			'dismiss',
			'timeout',
			'banner',
		],
	},
	{
		id: 'virtualize-conversations',
		key: 'virtualizeConversations',
		owner: 'desktop',
		section: 'appearance',
		label: 'Skip drawing what is off screen',
		description:
			'Long conversations and the conversation list leave the parts you cannot see undrawn until you scroll to them. Turn it off to draw everything, which can be slower in a long conversation.',
		control: toggle,
		default: true,
		appliesWhen: 'now',
		keywords: [
			'virtualize',
			'virtualise',
			'performance',
			'long conversation',
			'scroll',
			'lag',
			'slow',
			'render',
		],
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
	if (entry.control.kind === 'number')
		return (
			typeof value === 'number' &&
			Number.isInteger(value) &&
			value >= entry.control.min &&
			value <= entry.control.max
		)
	if (entry.control.kind === 'shortcut') return isShortcutSetting(value)
	if (entry.control.kind === 'text') {
		if (typeof value !== 'string' || value.length > entry.control.maxLength) return false
		if (entry.key === 'responseFont')
			return (
				value === RESPONSE_FONT_MATCH ||
				value === 'app' ||
				value === 'system' ||
				storedFamily(value) !== undefined
			)
		return value === '' || isSafeFontName(value)
	}
	return false
}
