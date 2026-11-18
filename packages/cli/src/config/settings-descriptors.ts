/**
 * Every setting Namzu Desktop shows, described once, next to the config loader.
 *
 * Desktop does not copy this list. The engine hands it over (`namzu/config/describe`)
 * and Desktop draws controls from it, so a key added here appears in Settings with
 * no Desktop change. A test fails when a top-level config key is neither described
 * here nor excluded with a reason.
 *
 * Writes go to the user file only. A project file is the repository's, so Desktop
 * never writes one.
 */

import { SESSION_EXPORT_EVENT_TYPES } from '../integrations/telemetry/session-export-events.js'
import { PREFIX_KEYS } from '../workspaces/prefix.js'
import { COMPOSER_TRIGGER_DEFAULTS, COMPOSER_TRIGGER_IDS } from './composer-triggers.js'
import type { ComposerTriggerId } from './schema.js'
import { TOOL_RESULT_SCREEN_NAMES, type ToolResultScreenName } from './tool-result-screens.js'

export type SettingSection =
	| 'general'
	| 'models'
	| 'projects'
	| 'appearance'
	| 'updates'
	| 'agent'
	| 'tools'
	| 'telemetry'
	| 'terminal'

/**
 * A heading inside a section, for rows that share one kind of effect. Closed on purpose: a screen
 * draws the heading from `SETTING_GROUP_LABELS`, so the words live here once and no page invents
 * its own. A row with no group sits above the grouped ones, under the section's own title.
 *
 * The words are the ones the Settings page shows. `command-line` is shared by two sections: it
 * marks what changes only the command line, what you type in a shell (its output, its profiles,
 * how it updates itself); the Desktop app and its conversations do not read those.
 */
export type SettingGroup =
	| 'choosing-models'
	| 'while-working'
	| 'limits'
	| 'helpers-workflows'
	| 'long-conversations'
	| 'memory'
	| 'learning-skills'
	| 'scheduled-tasks'
	| 'servers-hooks'
	| 'web'
	| 'browser'
	| 'code-plugins'
	| 'permissions'
	| 'folders'
	| 'conversations'
	| 'worktrees'
	| 'sandbox'
	| 'terminal-look'
	| 'terminal-mouse'
	| 'terminal-notifications'
	| 'terminal-message-box'
	| 'saved-conversations'
	| 'traces'
	| 'command-line'

/** The heading each group is drawn under, and the order groups follow inside a section. */
export const SETTING_GROUP_LABELS: Readonly<Record<SettingGroup, string>> = {
	'choosing-models': 'Choosing models',
	'while-working': 'While Namzu works',
	limits: 'Limits',
	'helpers-workflows': 'Helpers and workflows',
	'long-conversations': 'Long conversations',
	memory: 'Memory',
	'learning-skills': 'Learning and skills',
	'scheduled-tasks': 'Scheduled tasks',
	'servers-hooks': 'Tool servers and hooks',
	web: 'Web',
	browser: 'Browser',
	'code-plugins': 'Code and plugins',
	permissions: 'Permissions',
	folders: 'Folders',
	conversations: 'Conversations',
	worktrees: 'Worktrees',
	sandbox: 'Sandbox',
	'terminal-look': 'Terminal app: look',
	'terminal-mouse': 'Terminal app: mouse and scrolling',
	'terminal-notifications': 'Terminal app: notifications',
	'terminal-message-box': 'Terminal app: message box',
	'saved-conversations': 'Saved conversations',
	traces: 'Traces',
	'command-line': 'Command line',
}

export const SETTING_GROUP_ORDER: readonly SettingGroup[] = [
	'choosing-models',
	'while-working',
	'limits',
	'helpers-workflows',
	'long-conversations',
	'memory',
	'learning-skills',
	'scheduled-tasks',
	'servers-hooks',
	'web',
	'browser',
	'code-plugins',
	'permissions',
	'folders',
	'conversations',
	'worktrees',
	'sandbox',
	'terminal-look',
	'terminal-mouse',
	'terminal-notifications',
	'terminal-message-box',
	'saved-conversations',
	'traces',
	'command-line',
]

/**
 * When a saved change reaches what the person is doing.
 *
 * - `now`: the next thing that reads it, with no wait.
 * - `next-turn`: the next message sent in an open conversation.
 * - `next-conversation`: a conversation started after the change; an open one keeps what it began with.
 * - `next-start`: the next time the terminal app or the engine starts.
 * - `next-launch`: the next time the Desktop app is opened.
 */
export type AppliesWhen = 'now' | 'next-turn' | 'next-conversation' | 'next-start' | 'next-launch'

/** The sentence a screen shows for each apply time. */
export const APPLIES_WHEN_TEXT: Readonly<Record<AppliesWhen, string>> = {
	now: 'Applies at once.',
	'next-turn': 'Applies from your next message.',
	'next-conversation': 'Applies to new conversations. Open ones keep what they have.',
	'next-start': 'Applies the next time Namzu starts.',
	'next-launch': 'Applies the next time the app opens.',
}

/**
 * The apply sentence for one row. A row only the terminal app reads says so, because "Namzu" alone
 * could mean the Desktop app, which does not wait for these.
 */
export function appliesTextFor(entry: Pick<SettingDescriptor, 'path' | 'appliesWhen'>): string {
	if (
		entry.appliesWhen === 'next-start' &&
		(entry.path.startsWith('tui.') ||
			entry.path.startsWith('composerTriggers.') ||
			entry.path === 'statusLine' ||
			entry.path === 'fast' ||
			entry.path === 'promptSuggestions')
	)
		return 'Applies the next time the terminal app starts.'
	return APPLIES_WHEN_TEXT[entry.appliesWhen]
}

/**
 * A value a setting holds when nothing is saved. A list is the list of ticked option values; a map
 * (a `levels` control) is the level each entry holds.
 */
export type SettingDefault =
	| boolean
	| number
	| string
	| readonly string[]
	| Readonly<Record<string, string>>

export interface SettingOption {
	/** The value written to the file. Never changes once shipped. */
	readonly value: string
	/** What a person reads. */
	readonly label: string
	/** One line saying what choosing it does. */
	readonly help?: string
}

export type SettingControl =
	| { readonly kind: 'toggle' }
	| { readonly kind: 'select'; readonly options: readonly SettingOption[] }
	| {
			readonly kind: 'checks'
			readonly options: readonly SettingOption[]
			/** Said for a list that holds every option (a missing key meaning all, for example). */
			readonly allLabel?: string
			/** Said beside a list with nothing ticked, when that is a choice with a consequence. */
			readonly emptyNote?: string
	  }
	/**
	 * A switch with event checks beside it, saved as `true` (the events in `whenOn`), `false`, or the
	 * list of ticked events. Unticking the last event writes `false`.
	 */
	| {
			readonly kind: 'toggle-checks'
			readonly options: readonly SettingOption[]
			readonly whenOn: readonly string[]
	  }
	/** A switch saved as one of two fixed lists: `on` when it is on, `off` when it is off. */
	| {
			readonly kind: 'toggle-list'
			readonly on: readonly string[]
			readonly off: readonly string[]
	  }
	/** One key of a closed list, chosen from a picker; the key is written as its `value`. */
	| { readonly kind: 'key'; readonly options: readonly SettingOption[] }
	/**
	 * A map from a fixed set of entries to one level each. An entry set to its default is left out of
	 * the file, and the key goes when the map is empty. The map of defaults is the descriptor's
	 * `default`.
	 */
	| {
			readonly kind: 'levels'
			readonly entries: readonly SettingOption[]
			readonly levels: readonly SettingOption[]
	  }
	/**
	 * The screens a tool result passes, each a name or `{ name, <field> }`. `passthrough` names the
	 * screen that takes a list of tools to let through, and the field that holds it.
	 */
	| {
			readonly kind: 'screens'
			readonly options: readonly SettingOption[]
			readonly passthrough: {
				readonly screen: string
				readonly field: string
				readonly label: string
				readonly placeholder?: string
			}
	  }
	/**
	 * A list of words typed one per entry, saved as a list of strings. `picker` names a way to choose
	 * an entry other than typing it; a screen that does not know it keeps the typed entry. `source`
	 * names the engine's own list the entries are offered from (the installed skills, each with a
	 * switch); a screen or a terminal that does not know it keeps the typed entries.
	 */
	| {
			readonly kind: 'list'
			readonly itemLabel: string
			readonly placeholder?: string
			readonly picker?: 'folder'
			readonly source?: 'skills'
	  }
	| {
			readonly kind: 'number'
			readonly min?: number
			readonly max?: number
			readonly unit?: string
	  }
	/** One line of text. `picker` names a way to choose it other than typing; a screen that does not know it keeps the box. */
	| {
			readonly kind: 'text'
			readonly placeholder?: string
			readonly picker?: 'folder'
			/** Prose a person writes: a box that wraps and keeps line breaks, under the row. */
			readonly multiline?: true
	  }
	/**
	 * A model named as `provider/model`, or just the model of the provider a conversation runs on.
	 * A screen offers the models it knows and still takes a name it does not list.
	 */
	| { readonly kind: 'model'; readonly placeholder?: string }
	/**
	 * The routing table, as a form: a default model, a fast and a large one, how a task is sized
	 * and how long that may take. Saved as the table the loader reads; thresholds kept as written.
	 */
	| { readonly kind: 'routing'; readonly example: string }
	/**
	 * The auto mode reviewer: a model and four lists of sentences (`lists`: the field is the option's
	 * `value`). A list left out keeps the built-in rules, a list that is given replaces them, and the
	 * entry `$defaults` stands for the built-ins at that place.
	 */
	| {
			readonly kind: 'auto-mode'
			readonly lists: readonly SettingOption[]
			readonly example: string
	  }
	/**
	 * The tool rules inside `permissions`: each a tool, an optional pattern of its input and an
	 * answer from `effects`. Only the rules are read and written; the mode keys that share the
	 * table (`defaultMode`, `disableBypassMode`, `disableAutoMode`, `outsideRoot`, `autoMode`) stay
	 * as they are. The saved value is the rule table (`{ tool: effect | { pattern: effect } }`).
	 */
	| {
			readonly kind: 'permission-rules'
			readonly effects: readonly SettingOption[]
			readonly example: string
	  }
	/**
	 * Cases that must come out as an answer, saved as a list of `{ tool, input, expect }`. A tool
	 * in `commandTools` takes its input as the one field `commandField`, so a screen offers a
	 * command box for it; any other tool's input is an object written as JSON.
	 */
	| {
			readonly kind: 'permission-checks'
			readonly effects: readonly SettingOption[]
			readonly commandTools: readonly string[]
			readonly commandField: string
			readonly example: string
	  }
	/**
	 * `browser.sites`: a site as the engine matches it and a level from `levels`, and the line `*`
	 * for every other site, which reads as `defaultLevel` when it is not written. Saved as the map.
	 */
	| {
			readonly kind: 'sites'
			readonly levels: readonly SettingOption[]
			readonly defaultLevel: string
			readonly example: string
	  }
	/** A list or table, edited as JSON and checked by the same reader the engine loads with. */
	| { readonly kind: 'json'; readonly example: string }
	/** Holds secrets or runs commands: Desktop shows whether it is set, never its value. */
	| { readonly kind: 'file-only' }

export interface SettingDescriptor {
	/** Dotted path inside the user config, for example `limits.maxIterations`. */
	readonly path: string
	readonly label: string
	readonly description: string
	readonly section: SettingSection
	/** The heading it sits under inside its section. Absent means directly under the section. */
	readonly group?: SettingGroup
	readonly control: SettingControl
	/**
	 * What the setting holds when its key is absent, as a typed value: a switch's on or off, a
	 * number, the chosen option, or the ticked options of a list. Screens draw the default from this,
	 * never from prose. Absent when the default cannot be written as one value (see `defaultText`).
	 */
	readonly default?: SettingDefault
	/** Said beside a typed default when it needs a caveat, for example that it differs in CI. */
	readonly defaultNote?: string
	/**
	 * Cases where the default is not `default`. The first rule whose key is set (`non-empty`) or
	 * equals `is` decides.
	 */
	readonly defaultWhen?: readonly {
		readonly path: string
		readonly is: 'non-empty' | string
		readonly value: SettingDefault
	}[]
	/** The default in words, for the rare setting with no typed default. */
	readonly defaultText?: string
	/** When a saved change reaches the work. */
	readonly appliesWhen: AppliesWhen
	/** A sentence shown in the confirmation dialog. Present means the change is confirmed first. */
	readonly confirm?: string
	/**
	 * Which new value asks. `on` and `off` apply to a toggle (for a `toggle-list`, `off` is its `off`
	 * list), `zero` to a number where 0 removes a cap, `drops-default` to a list of choices that
	 * leaves out an entry the default holds, and `widens` to a list of things Namzu may reach, where
	 * only a new list with an entry the list in force lacks asks (removing one never does), and
	 * `loosens` to the auto mode reviewer, which asks when its model changes or a list lets more
	 * run without a person (see `autoModeLoosened`), and to the permission rules, the self-checks and
	 * the browser sites, which ask when a change lets more run without a person (see `loosenedBy`). Absent means every change asks. Clearing a setting asks
	 * unless a select names its risky values and its default is none of them.
	 */
	readonly confirmWhen?: 'on' | 'off' | 'zero' | 'drops-default' | 'widens' | 'loosens'
	/**
	 * For a select, the one new value that asks; choosing any other value applies at once. Clearing
	 * asks only when the setting's default is that value. Absent means every change to a select asks.
	 */
	readonly confirmValue?: string
	/**
	 * For a select where more than one value is the risky direction, every value that asks.
	 * Choosing any other value applies at once. Clearing asks only when the default is one of them.
	 */
	readonly confirmValues?: readonly string[]
	/**
	 * Another setting this one does nothing without. Screens warn while that setting is not `is`
	 * (its saved value, or its default when unsaved); the control stays usable.
	 */
	readonly requires?: {
		readonly path: string
		readonly is: string
		readonly note: string
	}
	/** Search words beyond the label. */
	readonly keywords?: readonly string[]
}

export interface SettingExclusion {
	readonly key: string
	readonly reason: string
}

const on = { kind: 'toggle' } as const
const num = (min?: number, max?: number, unit?: string): SettingControl => ({
	kind: 'number',
	...(min !== undefined ? { min } : {}),
	...(max !== undefined ? { max } : {}),
	...(unit ? { unit } : {}),
})
/** A choice list: each entry is `[saved value, label, one line of help]`. */
const pick = (...entries: (readonly [string, string, string])[]): SettingControl => ({
	kind: 'select',
	options: entries.map(([value, label, help]) => ({ value, label, help })),
})
const checks = (...entries: (readonly [string, string])[]): SettingControl => ({
	kind: 'checks',
	options: entries.map(([value, label]) => ({ value, label })),
})
const eventChecks = (
	whenOn: readonly string[],
	...entries: (readonly [string, string, string])[]
): SettingControl => ({
	kind: 'toggle-checks',
	whenOn,
	options: entries.map(([value, label, help]) => ({ value, label, help })),
})
const TRIGGER_WORDS: Readonly<Record<ComposerTriggerId, { label: string; help: string }>> = {
	hypermode: {
		label: 'Hypermode',
		help: 'The word hypermode lets the model use workflows for one reply.',
	},
	workflow: {
		label: 'Workflow',
		help: 'The word workflow opts one reply into the workflow tool.',
	},
	'save-skill': {
		label: 'Save as skill',
		help: 'Phrases like "save this as a skill" run /skills save after the reply.',
	},
	schedule: {
		label: 'Schedule',
		help: 'Phrases like "run it every day" propose a scheduled job.',
	},
	'max-effort': {
		label: 'Maximum effort',
		help: 'The word ultrathink sets the highest effort for one reply.',
	},
}

const SCREEN_WORDS: Readonly<Record<ToolResultScreenName, { label: string; help: string }>> = {
	correspondence: {
		label: 'Repeats the request',
		help: 'Refuses a result framed as untrusted that only repeats the request it answers.',
	},
	injection: {
		label: 'Hidden instructions',
		help: 'Refuses a result that tries to give the model orders.',
	},
}

/** `text_delta` as a person reads it: `Text delta`. */
function eventLabel(type: string): string {
	const words = type.replace(/_/g, ' ')
	return words.charAt(0).toUpperCase() + words.slice(1)
}

/** `ctrl+b` as `Ctrl+B`, `ctrl+space` as `Ctrl+Space`. */
function keyLabel(key: string): string {
	return key
		.split('+')
		.map((part) =>
			part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
		)
		.join('+')
}

const PERMISSION_EFFECTS: readonly SettingOption[] = [
	{ value: 'allow', label: 'Allow', help: 'Runs without asking.' },
	{ value: 'ask', label: 'Ask', help: 'Asks you each time.' },
	{ value: 'deny', label: 'Deny', help: 'Never runs.' },
]

const fileOnly: SettingControl = { kind: 'file-only' }

/**
 * When a key's saved value is read. Found from the code that reads it: the terminal app, the
 * schedule daemon, the update check, telemetry, the plugin loader, the model choice and the list of
 * permission modes a host offers read once at launch. The host re-reads the user and project files
 * whenever it starts a conversation (`ensureSession` in `commands/acp.ts`), and builds the session
 * options, the permission rules, the browser rules and the per-turn options from that fresh read,
 * so those keys reach the next conversation and never one that is already open. Every key not
 * traced to one of those readers defaults to `next-start`, the later and therefore safe claim.
 */
export function appliesWhenFor(path: string): AppliesWhen {
	const startOnly = [
		'tui.',
		'updates.',
		'telemetry.',
		'schedule.',
		'plugins.',
		'composerTriggers.',
		'learningGenerator.',
		// The modes a host offers and Auto's availability are read once when the host starts.
		'permissions.autoMode',
		'permissions.disableAutoMode',
		'permissions.disableBypassMode',
	]
	if (startOnly.some((prefix) => path.startsWith(prefix))) return 'next-start'
	const conversationPrefixes = [
		'limits.',
		'workflow.',
		'handBack.',
		'worktrees.',
		'sandbox.',
		'compaction.',
		'memory.',
		'skills.',
		'web.',
		'browser.',
		'permissions.',
		'codeAnalysis.',
	]
	const conversationKeys = new Set([
		'hypermode',
		'closingSummary',
		'outputStyle',
		'attribution',
		'effort',
		'respectGitignore',
		'refusalFallback',
		'smallModel',
		'decision',
		'learningObservations',
		'toolResultScreens',
		'additionalDirectories',
		'permissions',
		'permissionChecks',
		'mcpServers',
		'hooks',
		'disableHooks',
	])
	return conversationKeys.has(path) ||
		conversationPrefixes.some((prefix) => path.startsWith(prefix))
		? 'next-conversation'
		: 'next-start'
}

function d(
	path: string,
	section: SettingSection,
	label: string,
	description: string,
	control: SettingControl,
	more: Omit<
		SettingDescriptor,
		'path' | 'section' | 'label' | 'description' | 'control' | 'appliesWhen'
	> & { appliesWhen?: AppliesWhen } = {},
): SettingDescriptor {
	const { appliesWhen, ...rest } = more
	return {
		path,
		section,
		label,
		description,
		control,
		appliesWhen: appliesWhen ?? appliesWhenFor(path),
		...rest,
	}
}

const DECLARED: readonly SettingDescriptor[] = [
	// Models
	d(
		'model',
		'models',
		'Choose model automatically',
		"Let Namzu pick a model for each task. Needs a default model under 'Models for automatic choice'. The start of each task is sent to the model that chooses.",
		pick([
			'auto',
			'Automatic',
			'Namzu picks the model for each task. Needs a default model under Models for automatic choice.',
		]),
		{
			group: 'choosing-models',
			keywords: ['Choose the model automatically', 'model', 'auto', 'automatic'],
			confirm:
				'Namzu will send the start of each task to a model that chooses which model answers.',
		},
	),
	d(
		'routing',
		'models',
		'Models for automatic choice',
		'Set the default model, which models are fast and which are large, and how Namzu chooses between them. Task text is sent to the model that chooses.',
		{
			kind: 'routing',
			example:
				'{"default":{"provider":"anthropic","model":"claude-sonnet-4-5"},"tiers":{"fast":{"provider":"anthropic","model":"claude-haiku-4-5"}},"strategy":"yesno","timeoutMs":1500}',
		},
		{
			group: 'choosing-models',
			keywords: ['Automatic routing', 'routing', 'default model', 'fast model', 'large model'],
			defaultText: 'not set: Automatic cannot be chosen until a default model is saved',
			confirm: 'The start of each task is sent to a model that decides which model answers.',
		},
	),
	d(
		'smallModel',
		'models',
		'Model for quick tasks',
		'The model for quick side jobs such as naming conversations. Use provider/model, or just the model. Text from your conversations is sent to it.',
		{ kind: 'model', placeholder: 'provider/model' },
		{
			group: 'choosing-models',
			keywords: ['Small model', 'titles', 'side requests'],
			defaultText: 'the cheapest model with a known price',
			confirm: 'Text from your conversations is sent to this model for side jobs.',
		},
	),
	d(
		'refusalFallback',
		'models',
		'When a model refuses',
		'Try another model when the first one declines to answer, or show the refusal and stop.',
		pick(
			['auto', 'Try another model', 'If a model declines, the request goes to a different one.'],
			['off', 'Show the refusal', 'The refusal is shown and nothing else is tried.'],
		),
		{
			group: 'choosing-models',
			keywords: ['refusal', 'declines', 'fallback'],
			default: 'auto',
			confirm: 'The request will be sent to a different model after a refusal.',
			confirmValue: 'auto',
		},
	),
	d(
		'effort',
		'models',
		'Default reasoning effort',
		'How much a model thinks before it answers in new conversations. A level the model does not offer is ignored. Higher levels use more of your limit.',
		pick(
			['none', 'None', 'No extra thinking.'],
			['minimal', 'Minimal', 'The least thinking a model offers.'],
			['low', 'Low', 'Quick answers with light thinking.'],
			['medium', 'Medium', 'Balanced thinking.'],
			['high', 'High', 'Careful thinking.'],
			['xhigh', 'Extra high', 'Very careful thinking.'],
			['max', 'Max', 'Maximum thinking.'],
			['ultra', 'Ultra', 'The highest level, where a model has one.'],
		),
		{
			group: 'choosing-models',
			keywords: ['effort', 'thinking', 'reasoning', 'reasoning effort', 'effort level'],
			defaultText: "the model's own default",
		},
	),
	d(
		'fast',
		'models',
		'Fast mode',
		'Start the terminal app with faster replies on models that offer it. Billed at twice the standard rate.',
		on,
		{
			group: 'choosing-models',
			keywords: ['fast', 'speed', 'faster replies', 'priority'],
			default: false,
			confirm: 'Replies on models that offer fast mode will be billed at twice the standard rate.',
			confirmWhen: 'on',
		},
	),
	d(
		'modelCatalogueRefresh',
		'models',
		'Check for new models',
		'Look for new models and prices when Namzu starts.',
		on,
		{
			group: 'choosing-models',
			keywords: ['Refresh the model list', 'catalogue', 'prices', 'model list'],
			default: true,
		},
	),
	d(
		'decision',
		'models',
		'Model for background decisions',
		'A second model that helps with notifications, memory, skills and picks. Add a decision section to your config file (see the decision points page in the docs); the file names the variable that holds the key, never the key.',
		fileOnly,
		{ group: 'choosing-models', keywords: ['Decision model', 'second model', 'decision points'] },
	),
	d(
		'permissions.autoMode',
		'models',
		'Auto mode model and rules',
		'Which model approves actions in auto mode, and the rules it follows. A list you leave alone keeps the built-in rules.',
		{
			kind: 'auto-mode',
			lists: [
				{
					value: 'allow',
					label: 'Always allowed',
					help: 'Ordinary work the auto mode model never blocks.',
				},
				{
					value: 'softDeny',
					label: 'Blocked unless you said so',
					help: 'Blocked unless your own messages name the action and its risky detail.',
				},
				{
					value: 'hardDeny',
					label: 'Always blocked',
					help: 'Blocked whatever you said.',
				},
				{
					value: 'environment',
					label: 'Trusted here',
					help: 'Places and services the auto mode model treats as yours.',
				},
			],
			example:
				'{"model":"anthropic/claude-haiku-4-5","hardDeny":["$defaults","Deleting a production database"]}',
		},
		{
			group: 'choosing-models',
			keywords: ['Auto mode reviewer', 'auto mode', 'classifier', 'approve'],
			defaultText: "the conversation's own model, with the built-in rules",
			confirm: 'This decides which actions are approved without asking you.',
			confirmWhen: 'loosens',
		},
	),

	// Projects: what may run
	d(
		'permissions.defaultMode',
		'projects',
		'Default permission mode',
		'How Namzu asks before it acts, until you choose otherwise in a conversation.',
		pick(
			[
				'prompt',
				'Ask before risky actions',
				'Reads run freely; edits, commands and other changes ask first.',
			],
			[
				'accept-edits',
				'Allow file edits',
				'Edits and writes run without asking; everything else still asks.',
			],
			['plan', 'Plan only', 'Namzu may look and plan, and is refused any change.'],
			[
				'bypass',
				'Never ask',
				'Every action runs without asking. Use it only where nothing can be harmed.',
			],
			['auto', 'A model decides', 'A reviewing model approves or refuses each action for you.'],
			[
				'strict',
				'Only what a rule allows',
				'An action runs only when a permission rule allows it; the rest is refused.',
			],
		),
		{
			group: 'permissions',
			keywords: ['default mode', 'permissions', 'ask before risky actions', 'auto', 'plan'],
			default: 'prompt',
			confirm: 'Some modes let Namzu act without asking. Only choose one you are comfortable with.',
			confirmValues: ['accept-edits', 'bypass', 'auto'],
		},
	),
	d(
		'permissions.disableBypassMode',
		'projects',
		'Disable bypass permissions mode',
		'Remove the mode that skips every question.',
		on,
		{
			group: 'permissions',
			keywords: ['Forbid bypass mode', 'bypass', 'dangerously skip'],
			default: false,
			confirm: 'Bypass mode, which skips every question, will be available again.',
			confirmWhen: 'off',
		},
	),
	d(
		'permissions.disableAutoMode',
		'projects',
		'Disable auto mode',
		'Remove the mode that lets a model approve actions.',
		on,
		{
			group: 'permissions',
			keywords: ['Forbid auto mode', 'auto mode'],
			default: false,
			confirm: 'Auto mode, where a model approves actions, will be available again.',
			confirmWhen: 'off',
		},
	),
	d(
		'permissions.outsideRoot',
		'projects',
		'Files outside the project',
		'Ask before reading or changing a file outside the project folder and your extra folders, or refuse without asking.',
		pick(
			[
				'ask',
				'Ask me',
				'A file outside the working folder is shown to you before Namzu reads or changes it.',
			],
			['refuse', 'Refuse', 'Namzu is refused a file outside the working folder and does not ask.'],
		),
		{
			group: 'permissions',
			default: 'ask',
			confirm: 'Namzu will be able to ask about files outside the working folder again.',
			confirmValue: 'ask',
			keywords: [
				'Paths outside the working folder',
				'outside root',
				'outside the working folder',
				'outside',
				'folder',
				'directory',
				'boundary',
				'refuse',
			],
		},
	),
	d(
		'permissions',
		'projects',
		'Permission rules',
		'Allow, ask or deny a tool, or a pattern of its input.',
		{
			kind: 'permission-rules',
			effects: PERMISSION_EFFECTS,
			example: '{"bash":{"git status *":"allow","*":"ask"},"read":"allow"}',
		},
		{
			group: 'permissions',
			defaultText: 'no rules: every tool asks, or not, as the permission mode says',
			confirm: 'Rules can let tools run without asking you.',
			confirmWhen: 'loosens',
			keywords: ['rules', 'allow', 'deny', 'ask', 'tool', 'pattern'],
		},
	),
	d(
		'permissionChecks',
		'projects',
		'Permission tests',
		'Actions that must come out as allow, ask or deny, checked when Namzu starts.',
		{
			kind: 'permission-checks',
			effects: PERMISSION_EFFECTS,
			commandTools: ['bash'],
			commandField: 'command',
			example: '[{"tool":"bash","input":{"command":"rm -rf /"},"expect":"deny"}]',
		},
		{
			group: 'permissions',
			keywords: ['Permission self-checks', 'permission checks', 'self checks'],
			defaultText: 'no checks',
			confirm: 'Removing a check means a rule that lets the wrong thing through goes unnoticed.',
			confirmWhen: 'loosens',
		},
	),
	d(
		'additionalDirectories',
		'projects',
		'Extra folders',
		'Folders besides the project that Namzu may read and change. Desktop marks a folder that does not exist.',
		{ kind: 'list', itemLabel: 'folder', placeholder: '/path/to/folder', picker: 'folder' },
		{
			group: 'folders',
			keywords: ['additional directories', 'directories', 'add dir'],
			default: [],
			confirm: 'Namzu will be able to reach this folder in every project.',
			confirmWhen: 'widens',
		},
	),
	d(
		'respectGitignore',
		'projects',
		'Respect .gitignore',
		'Keep files that .gitignore ignores out of file pickers and file search.',
		on,
		{
			group: 'folders',
			keywords: ['gitignore', 'ignored files', 'file picker', 'file search', 'mentions'],
			default: true,
			confirm: 'Ignored files, such as local keys and installed packages, will show in file lists.',
			confirmWhen: 'off',
		},
	),
	d(
		'attribution',
		'projects',
		'Commit and pull request text',
		'Text Namzu ends the commit messages and pull request descriptions it writes with. Leave it empty to add nothing.',
		{ kind: 'text', placeholder: 'Nothing added', multiline: true },
		{
			group: 'worktrees',
			keywords: [
				'attribution',
				'co-author',
				'trailer',
				'signature',
				'commit message',
				'pull request',
			],
		},
	),
	d(
		'worktrees.branchPrefix',
		'projects',
		'Branch prefix',
		'Added to the start of every branch name Namzu makes for a new worktree.',
		{ kind: 'text', placeholder: 'namzu' },
		{
			group: 'worktrees',
			keywords: ['branch name', 'prefix', 'worktree branch'],
			default: 'namzu',
		},
	),
	d(
		'worktrees.location',
		'projects',
		'Worktree location',
		'Where Namzu stores Git worktrees for isolated coding conversations on this computer.',
		{ kind: 'text', placeholder: 'Inside the project', picker: 'folder' },
		{
			group: 'worktrees',
			keywords: ['worktrees folder', 'where worktrees go', 'worktree directory'],
			defaultText: "inside the project's Namzu folder",
		},
	),
	d(
		'worktrees.sparseFolders',
		'projects',
		'Worktree folders',
		'When set, a new worktree holds only these folders, such as src/app, and the files at the top of the project.',
		{ kind: 'list', itemLabel: 'folder', placeholder: 'src/app' },
		{
			group: 'worktrees',
			keywords: ['sparse checkout', 'sparse folders', 'worktree sparse', 'only these folders'],
			default: [],
		},
	),
	d(
		'statusMarks',
		'appearance',
		'Label conversations by status',
		'Shows in the sidebar when a conversation needs you, is working or has a new reply.',
		on,
		{
			appliesWhen: 'now',
			group: 'conversations',
			keywords: ['status', 'label sessions', 'sidebar marks', 'blocked', 'unread', 'badge'],
			default: true,
		},
	),
	d(
		'archiveInactive',
		'projects',
		'Archive inactive conversations',
		'Moves a conversation to the archive after it has had no activity for this long.',
		pick(
			['never', 'Never', 'Conversations stay where they are.'],
			['1d', 'After 1 day', 'Archived once idle for a day.'],
			['7d', 'After 7 days', 'Archived once idle for a week.'],
			['30d', 'After 30 days', 'Archived once idle for thirty days.'],
		),
		{
			appliesWhen: 'now',
			group: 'conversations',
			keywords: ['archive inactive sessions', 'archive', 'idle', 'auto archive'],
			default: 'never',
		},
	),
	d(
		'sandbox.enabled',
		'projects',
		'Run in a sandbox',
		'Keep what Namzu runs inside an isolated space. Namzu turns it on by itself when isolation is required or the workspace is a throwaway copy.',
		on,
		{
			group: 'sandbox',
			keywords: ['sandbox', 'isolation'],
			default: false,
			defaultWhen: [
				{ path: 'sandbox.requireIsolation', is: 'non-empty', value: true },
				{ path: 'sandbox.workspace', is: 'ephemeral', value: true },
			],
			defaultNote: 'On when isolation is required or the workspace is a throwaway copy.',
			confirm: 'Without a sandbox, commands run directly on this computer.',
			confirmWhen: 'off',
		},
	),
	d(
		'sandbox.allowEscape',
		'projects',
		'Let Namzu ask to leave the sandbox',
		'Namzu may ask to run one command outside the sandbox.',
		on,
		{
			group: 'sandbox',
			keywords: ['Allow leaving the sandbox', 'allow escape', 'escape'],
			default: true,
			confirm: 'Namzu will be able to ask to run commands outside the sandbox.',
			confirmWhen: 'on',
		},
	),
	d(
		'sandbox.allowUnattendedEscape',
		'projects',
		'Leave the sandbox without asking when unattended',
		'Let work nobody is watching, such as a scheduled or headless run, leave the sandbox without a prompt. Work you are watching is not affected.',
		on,
		{
			group: 'sandbox',
			keywords: ['Allow leaving it without asking', 'unattended escape'],
			default: false,
			confirm: 'Unattended work could run commands outside the sandbox with nobody to stop it.',
			confirmWhen: 'on',
		},
	),
	d(
		'sandbox.requireIsolation',
		'projects',
		'Stop if isolation is missing',
		'If the sandbox cannot isolate every one of these, the run stops instead of going on without it.',
		checks(['filesystem', 'Files'], ['network', 'Network'], ['process', 'Processes']),
		{
			group: 'sandbox',
			keywords: ['Required isolation', 'require isolation', 'files', 'network', 'processes'],
			default: [],
		},
	),
	d(
		'sandbox.workspace',
		'projects',
		'Sandbox workspace',
		'Work in the project folder, or in a throwaway copy.',
		pick(
			['working-directory', 'The project folder', 'Commands work on your real files.'],
			[
				'ephemeral',
				'A throwaway copy',
				'Commands work in an empty temporary folder that is deleted afterwards.',
			],
		),
		{ group: 'sandbox', keywords: ['workspace', 'throwaway copy'], default: 'working-directory' },
	),
	d(
		'sandbox.teardownTimeoutMs',
		'projects',
		'Sandbox cleanup time limit',
		'How long to wait for a sandbox to be cleaned up after a reply. When time runs out, cleanup is told to stop and the reply ends without waiting. 0 waits as long as it takes.',
		num(0, undefined, 'ms'),
		{ group: 'sandbox', keywords: ['teardown timeout'], default: 30000 },
	),

	// Updates
	d(
		'updates.channel',
		'updates',
		'Release channel',
		'Which releases the command line updates to: Newest gets new versions first, Stable waits longer. The Desktop app has its own releases.',
		pick(
			['latest', 'Newest', 'New versions arrive as soon as they are released.'],
			['stable', 'Stable', 'New versions arrive later, after they have had more use.'],
		),
		{
			keywords: ['updates channel', 'channel', 'latest', 'stable'],
			default: 'latest',
			group: 'command-line',
		},
	),
	d(
		'updates.auto',
		'updates',
		'Install command line updates automatically',
		'The command line updates itself in the background. The Desktop app updates on its own. Off in automated runs such as CI.',
		on,
		{
			default: true,
			defaultNote: 'Off in automated runs such as CI.',
			confirm: 'Namzu will install new versions of its command line on its own.',
			confirmWhen: 'on',
			group: 'command-line',
			keywords: [
				'auto update',
				'updates auto',
				'automatic',
				'automatic updates',
				'background',
				'upgrade',
			],
		},
	),
	d(
		'updates.check',
		'updates',
		'Check for command line updates',
		'Look for a new version of the command line when it starts.',
		on,
		{
			default: true,
			group: 'command-line',
			keywords: [
				'Look for new versions',
				'updates check',
				'automatic',
				'check for updates',
				'upgrade',
			],
		},
	),

	// Agent
	d(
		'hypermode',
		'agent',
		'Hypermode',
		'Let Namzu run longer, larger jobs without stopping to check in with you. A job can take more time and tokens.',
		on,
		{
			group: 'while-working',
			keywords: [],
			default: false,
			confirm: 'Namzu will run longer jobs without stopping to check in with you.',
			confirmWhen: 'on',
		},
	),
	d(
		'closingSummary',
		'agent',
		'Summary and next steps',
		'End finished work with a short note of what changed, what was checked and what is left.',
		on,
		{
			group: 'while-working',
			keywords: ['closing note', 'summary', 'next steps', 'what is left', 'wrap up'],
			default: true,
		},
	),
	d(
		'outputStyle',
		'agent',
		'Output style',
		'Say how replies should read, in your own words. Namzu follows it in new conversations, and it never overrides its working rules.',
		{
			kind: 'text',
			placeholder: 'For example: short, plain sentences with no lists',
			multiline: true,
		},
		{
			group: 'while-working',
			keywords: ['style', 'tone', 'reply style', 'verbosity', 'concise', 'formatting'],
		},
	),
	d(
		'promptSuggestions',
		'agent',
		'Prompt suggestions',
		'Suggest a next message after Namzu replies, in the terminal app; Tab uses it. Adds one small request to your usage per reply.',
		on,
		{
			group: 'while-working',
			keywords: ['suggestion', 'next prompt', 'next message', 'autocomplete', 'ghost text'],
			default: true,
		},
	),
	d(
		'limits.maxResponseTokens',
		'agent',
		'Longest answer',
		'The most a model may write in one answer, in tokens.',
		num(1, undefined, 'tokens'),
		{ group: 'limits', keywords: [], default: 8192 },
	),
	d(
		'limits.maxReasoningTokens',
		'agent',
		'Thinking budget',
		'The most a model may think before answering, in tokens. 0 removes the cap.',
		num(0, undefined, 'tokens'),
		{
			group: 'limits',
			keywords: ['reasoning tokens'],
			defaultText: '24000 at medium effort and above',
		},
	),
	d(
		'limits.doneGate',
		'agent',
		'Check before finishing',
		'When a turn changed files, Namzu is asked once to check its work before it ends. Terminal app only.',
		on,
		{
			group: 'while-working',
			keywords: ['done gate', 'self check', 'check its own work'],
			default: false,
		},
	),
	d(
		'limits.maxHookRefusals',
		'agent',
		'Most hook refusals in a row',
		'How many times in a row a hook may refuse to let a reply end before Namzu ends it anyway. 0 means no limit.',
		num(0),
		{ group: 'limits', keywords: ['Hook refusals before a turn ends', 'stop hook'], default: 8 },
	),
	d(
		'limits.maxIterations',
		'agent',
		'Most steps per reply',
		'The most steps one reply may take before it stops. A step is one round of the model answering or running tools. 0 means no limit.',
		num(0),
		{
			group: 'limits',
			keywords: ['Most steps per turn', 'iterations', 'max iterations', 'turn'],
			defaultText: 'no limit',
			confirm: 'With no limit, a turn can keep taking steps until it ends on its own.',
			confirmWhen: 'zero',
		},
	),
	d(
		'limits.tokenBudget',
		'agent',
		'Most tokens per task',
		'The most tokens one task may use. 0 means no limit.',
		num(0, undefined, 'tokens'),
		{
			group: 'limits',
			keywords: ['token budget'],
			defaultText: 'no limit',
			confirm: 'With no limit, a task can use as many tokens as it needs.',
			confirmWhen: 'zero',
		},
	),
	d(
		'limits.timeoutMs',
		'agent',
		'Longest reply time',
		'How long one reply may run before it is stopped. Type minutes and seconds, for example 5m or 90s. 0 means no limit.',
		num(0, 2147483647, 'ms'),
		{ group: 'limits', keywords: ['Longest turn time', 'timeout'], defaultText: 'no limit' },
	),
	d(
		'limits.costLimitUsd',
		'agent',
		'Spending limit per task',
		'The most one task may spend, in US dollars. 0 means no limit.',
		num(0, undefined, 'USD'),
		{
			group: 'limits',
			keywords: ['Most spend per task', 'cost limit', 'budget', 'usd'],
			defaultText: 'no limit',
			confirm: 'With no limit, a task can spend as much as it takes.',
			confirmWhen: 'zero',
		},
	),
	d(
		'limits.waitForProviderMs',
		'agent',
		'Wait for a busy provider',
		'How long a one-shot command-line run or a scheduled run keeps waiting while a provider is busy or limiting requests, before it stops. Type minutes and seconds, for example 10m.',
		num(1, undefined, 'ms'),
		{
			group: 'limits',
			keywords: ['rate limit', 'busy', '429', 'overloaded'],
			defaultText: 'a one-shot run does not wait; a scheduled run waits 10 minutes',
		},
	),
	d(
		'workflow.enabled',
		'agent',
		'Dynamic workflows',
		'In the terminal app and one-shot runs, let Namzu run several helper agents at once on complex tasks. Uses your limit faster.',
		on,
		{
			group: 'helpers-workflows',
			keywords: ['workflow', 'workflows', 'workflow tool', 'helper agents', 'multi-agent'],
			default: true,
		},
	),
	d(
		'workflow.maxConcurrency',
		'agent',
		'Helpers working at once',
		'How many helper agents may run side by side.',
		num(1, 16),
		{
			group: 'helpers-workflows',
			keywords: ['concurrency', 'parallel agents'],
			defaultText: 'processors minus 2, at most 16',
		},
	),
	d(
		'workflow.maxAgents',
		'agent',
		'Most helpers per workflow',
		'The most helper agents one workflow may start.',
		num(1, 1000),
		{ group: 'helpers-workflows', keywords: ['max agents'], default: 1000 },
	),
	d(
		'workflow.sizeGuideline',
		'agent',
		'Preferred workflow size',
		'How large a workflow Namzu aims for.',
		pick(
			['unrestricted', 'No advice', 'Namzu is not told how large a workflow to aim for.'],
			['small', 'Small', 'Namzu is advised to keep a workflow under 5 helpers.'],
			['medium', 'Medium', 'Namzu is advised to keep a workflow under 10 helpers.'],
			['large', 'Large', 'Namzu is advised to keep a workflow under 50 helpers.'],
		),
		{
			group: 'helpers-workflows',
			keywords: ['Workflow size', 'size guideline'],
			default: 'medium',
		},
	),
	d(
		'goal.confirmedBy',
		'agent',
		'When a goal counts as done',
		'What has to be true before a goal is treated as finished. The default may change to "After the record is checked" in a later major release.',
		pick(
			['model', 'When the model says so', 'A goal ends when the model says it is done.'],
			[
				'record',
				'After the record is checked',
				'Namzu reads the record of the work first; the goal ends as confirmed, stated and not checked, or not confirmed.',
			],
		),
		{
			group: 'helpers-workflows',
			keywords: ['What ends a goal', 'goal confirmed by', 'confirmedBy'],
			default: 'model',
			defaultNote: 'Intended to become record in a later major release.',
		},
	),
	d(
		'handBack.enabled',
		'agent',
		'Let Namzu hand a task back',
		'Namzu may stop and hand the task back to you when it cannot be done as specified, instead of forcing a result. Adds one tool and a short paragraph to the prompt.',
		on,
		{
			group: 'helpers-workflows',
			keywords: ['Let the model hand a task back', 'hand back', 'handback'],
			default: false,
		},
	),
	d(
		'toolResultScreens',
		'agent',
		'Screen tool results',
		'Check what a tool returns for repeated requests and for hidden instructions before the model reads it, and refuse a result that fails. Only a result framed as untrusted is checked for repeating the request. Clearing every box turns screening off.',
		{
			kind: 'screens',
			options: TOOL_RESULT_SCREEN_NAMES.map((value) => ({ value, ...SCREEN_WORDS[value] })),
			passthrough: {
				screen: 'correspondence',
				field: 'passthroughTools',
				label: 'Tools that may repeat the request',
				placeholder: 'tool name',
			},
		},
		{
			group: 'while-working',
			keywords: ['Screens on tool results', 'prompt injection', 'injection'],
			default: ['correspondence'],
			defaultNote: 'Only a result framed as untrusted is checked.',
			confirm: 'Removing a screen lets tool output reach the model unchecked.',
			confirmWhen: 'drops-default',
		},
	),
	d(
		'compaction.strategy',
		'agent',
		'How to shorten long conversations',
		"The method used to fit a long conversation in the model's window.",
		pick(
			[
				'structured',
				'Keep the newest',
				'Keeps the most recent messages and shortens once the window is nearly full.',
			],
			[
				'salience',
				'Keep what matters',
				'Scores every message and keeps the conversation near half the window.',
			],
		),
		{
			group: 'long-conversations',
			keywords: ['How long chats are shortened', 'compaction', 'compact', 'strategy'],
			default: 'salience',
		},
	),
	d(
		'compaction.softTargetHeadroom',
		'agent',
		'Room left after shortening',
		'How much further below half the window one round of shortening goes, as a fraction of the window. A larger value shortens less often; 0 shortens only to half the window.',
		num(0, 1, 'of the window'),
		{ group: 'long-conversations', keywords: ['soft target headroom', 'advanced'], default: 0.05 },
	),
	d(
		'compaction.autoCompactWindowTokens',
		'agent',
		'Shorten at this size',
		'Shorten the conversation when it reaches this many tokens. Type a number or a short form such as 200k or 1m. Sizes under 100k or over 1m are treated as those limits.',
		num(100000, 1000000, 'tokens'),
		{
			group: 'long-conversations',
			keywords: ['auto compact', 'NAMZU_AUTO_COMPACT_WINDOW'],
			defaultText: "the model's own window",
		},
	),
	d(
		'compaction.contextWindowTokens',
		'agent',
		'Model window size',
		'Override the window size Namzu assumes for the model.',
		num(1, undefined, 'tokens'),
		{
			group: 'long-conversations',
			keywords: ['Assumed model window', 'context window', 'context window tokens', 'advanced'],
			defaultText: 'the window Namzu knows for the model, or 128000 for one it does not know',
		},
	),
	d(
		'compaction.modelSummary',
		'agent',
		'Summarize with a model',
		'Use the quick-tasks model to write the summary when shortening. With no model set for quick tasks, or with this off, the summary is built from the conversation without a model.',
		on,
		{
			group: 'long-conversations',
			keywords: ['Summarise with a model', 'model summary'],
			default: true,
		},
	),
	d(
		'compaction.recallEvidence',
		'agent',
		'Recall dropped details',
		'Bring back details that shortening removed when they matter.',
		on,
		{ group: 'long-conversations', keywords: ['recall evidence', 'evidence'], default: true },
	),
	d(
		'compaction.resolveEvidenceQueries',
		'agent',
		'Ask a model what to recall',
		'Pays for an extra model call to find the details worth bringing back.',
		on,
		{
			group: 'long-conversations',
			keywords: ['resolve evidence queries', 'paid call'],
			default: true,
		},
	),
	d(
		'compaction.retainedToolPreviewChars',
		'agent',
		'Kept tool output length',
		'How much of a tool result that was too large is kept in the conversation, in characters. It applies to new results only. 0 keeps up to 40000.',
		num(0, undefined, 'characters'),
		{
			group: 'long-conversations',
			keywords: ['Kept tool output', 'tool preview', 'retained tool preview chars'],
			default: 4000,
		},
	),
	d(
		'compaction.deduplicateObservations',
		'agent',
		'Drop repeated results',
		'Keep one copy of the same tool result.',
		on,
		{
			group: 'long-conversations',
			keywords: ['deduplicate observations', 'duplicates'],
			default: true,
		},
	),
	d(
		'compaction.consolidate',
		'agent',
		'Merge notes when shortening',
		"Merge related notes into one when shortening. Turning it on turns off 'Tidy memory with a model'.",
		on,
		{ group: 'long-conversations', keywords: ['consolidate', 'merge notes'], default: false },
	),
	d(
		'compaction.idleCompaction',
		'agent',
		'Shorten while you are away',
		'Shorten a large conversation while you are away. It does nothing while the cache lifetime below is 5 minutes.',
		on,
		{
			group: 'long-conversations',
			keywords: ['Shorten while idle', 'idle compaction'],
			default: false,
			requires: {
				path: 'compaction.promptCacheTtl',
				is: '1h',
				note: 'Needs the cache lifetime set to 1 hour; with 5 minutes it does nothing.',
			},
		},
	),
	d(
		'compaction.clearStaleResultsAfterIdle',
		'agent',
		'Trim old results after a break',
		"When you return after the provider's cache has expired, old, large tool results are replaced with a short note before the first request.",
		on,
		{
			group: 'long-conversations',
			keywords: ['Shed old results after a long break', 'stale results', 'clear stale results'],
			default: true,
		},
	),
	d(
		'compaction.idleCompactionMinTokens',
		'agent',
		'Smallest conversation to shorten while away',
		'The smallest conversation worth shortening while you are away. Anything under 100000 is raised to 100000.',
		num(1, undefined, 'tokens'),
		{
			group: 'long-conversations',
			keywords: ['Idle shortening starts at', 'idle compact min tokens'],
			default: 200000,
		},
	),
	d(
		'compaction.promptCacheTtl',
		'agent',
		'Cache lifetime',
		"How long the provider keeps a conversation's start ready. 1 hour keeps a conversation cheap to resume but costs more to write.",
		pick(
			['5m', '5 minutes', 'The provider keeps a conversation warm for 5 minutes. No extra cost.'],
			[
				'1h',
				'1 hour',
				'Warm for an hour, so coming back is cheaper, but writing the cache costs more.',
			],
		),
		{ group: 'long-conversations', keywords: ['prompt cache', 'ttl', 'cache ttl'], default: '5m' },
	),
	d('memory.recall', 'agent', 'Use saved memory', 'Bring saved memory into a conversation.', on, {
		group: 'memory',
		keywords: ['Recall memory', 'memory recall'],
		default: true,
	}),
	d(
		'memory.identifierGrounding',
		'agent',
		'Check numbers against memory',
		'When memory is recalled, match identifiers that contain digits, such as ticket or commit numbers, against what was recorded. File and function names are not checked against your files.',
		on,
		{
			group: 'memory',
			keywords: ['identifier grounding', 'ids', 'ticket numbers', 'Check ids against memory'],
			default: false,
		},
	),
	d(
		'memory.select',
		'agent',
		'Let a model choose memories',
		'A model picks which memories to bring in. It uses the model for quick tasks and sees your message and memory titles; with none set, Namzu matches words instead.',
		pick(
			['on', 'On', 'A model picks which memories to bring in.'],
			['off', 'Off', 'Memories are chosen without a model.'],
		),
		{
			group: 'memory',
			keywords: ['Choose memory with a model', 'memory select'],
			default: 'on',
			confirm: 'Memory titles are sent to a model to choose from.',
			confirmValue: 'on',
		},
	),
	d(
		'memory.curation',
		'agent',
		'Tidy memory with a model',
		'A model merges and retires memories. It uses the model for quick tasks and sees the new claims and the titles of related memories; with none set, memories are saved as they are.',
		pick(
			['on', 'On', 'A model merges and retires memories.'],
			['off', 'Off', 'Memories are left as they are.'],
		),
		{
			group: 'memory',
			keywords: ['memory curation', 'curate'],
			default: 'on',
			confirm: 'Memory content is sent to a model to tidy it.',
			confirmValue: 'on',
		},
	),
	d(
		'memory.retireAfterDays',
		'agent',
		'Retire unused memory after',
		'Days before a memory recorded during a reply retires if it goes unused. Other memories stay. 0 keeps them forever.',
		num(0, undefined, 'days'),
		{ group: 'memory', keywords: ['retire after days', 'expire memory'], default: 21 },
	),
	d(
		'learningObservations',
		'agent',
		'Learn from your work',
		'Note what you do so Namzu can suggest habits and skills.',
		on,
		{
			group: 'learning-skills',
			keywords: ['learning observations', 'observations'],
			default: true,
		},
	),
	d(
		'learningGenerator.enabled',
		'agent',
		'Suggest habits and skills',
		'Let a model turn what Namzu noticed into suggestions. It uses tokens, up to the limits below.',
		on,
		{
			group: 'learning-skills',
			keywords: ['Write suggestions from what it learned', 'learning generator'],
			default: true,
		},
	),
	d(
		'learningGenerator.cycleTokens',
		'agent',
		'Learning limit per pass',
		'The most tokens one learning pass may use.',
		num(1000, 10000000, 'tokens'),
		{
			group: 'learning-skills',
			keywords: ['Tokens per learning cycle', 'cycle tokens'],
			default: 120000,
		},
	),
	d(
		'learningGenerator.dailyTokens',
		'agent',
		'Learning limit per day',
		'The most tokens learning may use in a day.',
		num(1000, 10000000, 'tokens'),
		{
			group: 'learning-skills',
			keywords: ['Tokens per day for learning', 'daily tokens'],
			default: 300000,
		},
	),
	d('skills.builtin', 'agent', 'Built-in skills', 'Offer the skills that ship with Namzu.', on, {
		group: 'learning-skills',
		keywords: ['builtin skills'],
		default: true,
	}),
	d(
		'skills.disabled',
		'agent',
		'Turned-off skills',
		'Skills Namzu will not use, by name. Desktop lists the installed skills with a switch each; a name here that no installed skill has stays listed, with Remove.',
		{ kind: 'list', itemLabel: 'skill name', placeholder: 'skill-name', source: 'skills' },
		{ group: 'learning-skills', keywords: ['disabled skills'], default: [] },
	),
	d(
		'skills.suggest',
		'agent',
		'Suggest saving a skill',
		'After a long task, offer to keep it as a skill. Terminal app only.',
		on,
		{ group: 'learning-skills', keywords: ['skill suggestions'], default: true },
	),
	d(
		'skills.suggestMinToolCalls',
		'agent',
		'Suggest after this many steps',
		'How many successful steps a task needs before a skill is suggested. Terminal app only.',
		num(1),
		{ group: 'learning-skills', keywords: ['suggest min tool calls', 'tool calls'], default: 6 },
	),
	d(
		'schedule.maxConcurrentRuns',
		'agent',
		'Scheduled tasks at once',
		'How many scheduled tasks may run side by side.',
		num(1, 16),
		{
			group: 'scheduled-tasks',
			keywords: ['Scheduled runs at once', 'max concurrent runs'],
			default: 2,
		},
	),
	d(
		'schedule.notifications',
		'agent',
		'Notify when a scheduled task finishes',
		'Tell you when a scheduled task finishes.',
		on,
		{
			group: 'scheduled-tasks',
			keywords: ['Notify when a scheduled run ends', 'schedule notifications'],
			default: true,
		},
	),

	// Tools
	d(
		'web.search',
		'tools',
		'Web search',
		'Let Namzu search the web: off, saved results only, or live results. Live results send what Namzu searches for out to the web.',
		pick(
			['off', 'Off', 'Namzu cannot search the web.'],
			[
				'cached',
				'Saved results only',
				'Searches are answered from saved results, not the live web.',
			],
			['live', 'Live', 'Searches go out to the web.'],
		),
		{
			group: 'web',
			keywords: ['search the web', 'cached', 'live'],
			default: 'live',
			confirm: 'Namzu will search the web and send queries out.',
			confirmValue: 'live',
		},
	),
	d(
		'web.backend',
		'tools',
		'Web search service',
		'Which service answers web searches.',
		pick(
			['auto', 'Automatic', 'Namzu picks the service that fits the model.'],
			['exa', 'Exa', 'Searches go through Exa, with Namzu reviewing what is searched.'],
			[
				'native',
				'The model provider',
				'The provider searches for the model, with no local review of what is searched.',
			],
		),
		{
			group: 'web',
			keywords: ['exa', 'backend'],
			default: 'auto',
			confirm: 'The native option has no local review of what is searched.',
			confirmValue: 'native',
		},
	),
	d('web.fetch', 'tools', 'Read web pages', 'Let Namzu read the web pages it is pointed to.', on, {
		group: 'web',
		keywords: ['Fetch web pages', 'web fetch'],
		default: true,
		confirm: 'Namzu will download pages from the internet.',
		confirmWhen: 'on',
	}),
	d(
		'browser.enabled',
		'tools',
		'Browser tools',
		'Let Namzu use a browser for web tasks, in the terminal app and in Desktop conversations that use this computer. Off removes the browser tools.',
		on,
		{ group: 'browser', keywords: ['Browser', 'enabled'], default: true },
	),
	d(
		'browser.defaultProfile',
		'tools',
		'Browser profile',
		'The browser profile Namzu uses. Sign-ins live in it. Use lowercase letters and digits with single dashes between them, up to 64 characters.',
		{ kind: 'text', placeholder: 'default' },
		{
			group: 'browser',
			keywords: ['default profile'],
			default: 'default',
			confirm: 'That profile holds the sign-ins Namzu would use.',
		},
	),
	d(
		'browser.engine',
		'tools',
		'Browser Namzu uses',
		'Which browser Namzu drives: automatic, a browser on Windows, or one Namzu starts itself.',
		pick(
			['auto', 'Automatic', 'Follows this computer.'],
			['windows', 'Windows browser', 'From WSL, drive the browser on Windows.'],
			['local', 'A browser Namzu starts', 'Namzu launches its own browser.'],
		),
		{ group: 'browser', keywords: ['Browser engine', 'Preferred browser'], default: 'auto' },
	),
	d(
		'browser.headless',
		'tools',
		'Show the browser window',
		'Whether the browser Namzu drives has a window you can see.',
		pick(
			[
				'auto',
				'Let Namzu decide',
				'Shown when you are in a live session on a computer with a screen; hidden otherwise.',
			],
			[
				'never',
				'Show it',
				'The window is always shown. With no screen on this computer the browser cannot start.',
			],
			['always', 'Hide it', 'The browser runs without a window.'],
		),
		{ group: 'browser', keywords: ['headless', 'hide browser'], default: 'auto' },
	),
	d(
		'browser.sites',
		'tools',
		'Site permissions',
		'Choose for each site whether Namzu blocks it, only reads it, asks first, or may act on it. * is every other site.',
		{
			kind: 'sites',
			levels: [
				{ value: 'deny', label: 'Deny', help: 'Namzu does not open the site.' },
				{ value: 'read', label: 'Read', help: 'Namzu may look at the site, not click or type.' },
				{ value: 'ask', label: 'Ask', help: 'Namzu asks before it opens or changes the site.' },
				{ value: 'act', label: 'Act', help: 'Namzu may open the site and click and type on it.' },
			],
			defaultLevel: 'ask',
			example: '{"https://example.com":"read","*":"ask"}',
		},
		{
			group: 'browser',
			keywords: ['Browser sites', 'allowed sites', 'deny', 'read', 'ask', 'act'],
			defaultText: 'every site asks',
			confirm: 'Allowing act lets Namzu click and type on that site.',
			confirmWhen: 'loosens',
		},
	),
	d(
		'browser.keepOpen',
		'tools',
		'Keep the browser open',
		'Leave the browser running between tasks.',
		on,
		{ group: 'browser', keywords: ['keep open'], default: false },
	),
	d(
		'browser.signInDetection',
		'tools',
		'Detect sign-in pages',
		'How Namzu notices a sign-in page. By page stops only for known sign-in sites, CAPTCHAs, bot blocks and HTTP sign-in prompts and lets other pages load, telling Namzu it cannot type a password; By web address stops on any login-style address.',
		pick(
			[
				'page',
				'By page',
				'Stops only on known sign-in sites; other pages load and Namzu is told it cannot type a password.',
			],
			[
				'address',
				'By web address',
				'Stops on any address that looks like a sign-in, such as /login.',
			],
		),
		{
			group: 'browser',
			keywords: ['Sign-in pages', 'login', 'signin detection'],
			default: 'page',
		},
	),
	d(
		'progressNudge.mode',
		'agent',
		'Quiet-stretch nudge',
		'After a long stretch of work with nothing said, ask the model for one sentence on what it is doing. Auto: on the terminal and in Desktop only; On: also `namzu exec`; Off: never.',
		pick(
			['auto', 'Auto', 'On in the terminal app and in Desktop, off in `namzu exec`.'],
			['on', 'On', 'Also in `namzu exec`.'],
			['off', 'Off', 'Never.'],
		),
		{ group: 'while-working', keywords: ['progress nudge', 'quiet stretch'], default: 'auto' },
	),
	d(
		'progressNudge.afterSeconds',
		'agent',
		'Quiet-stretch seconds',
		'Seconds of work since the person last saw text before the nudge. Time spent waiting on the person does not count.',
		num(1, undefined, 'seconds'),
		{ group: 'while-working', keywords: ['progress nudge'], default: 90 },
	),
	d(
		'progressNudge.afterCalls',
		'agent',
		'Quiet-stretch tool calls',
		'Tool calls in that stretch before the nudge.',
		num(1),
		{ group: 'while-working', keywords: ['progress nudge'], default: 6 },
	),
	d(
		'codeAnalysis.enabled',
		'tools',
		'Code analysis',
		'Let Namzu read the structure of your code (definitions and references), in the terminal app and in Desktop conversations. Off removes the code analysis tool.',
		on,
		{ group: 'code-plugins', keywords: ['lsp', 'definitions', 'references'], default: true },
	),
	d(
		'mcpServers',
		'tools',
		'Tool servers',
		'Tool servers Namzu starts or reaches. Desktop adds, edits and removes the ones in your config file; variables and headers hold secrets, so edit them in the file. In the terminal use namzu mcp.',
		fileOnly,
		{ group: 'servers-hooks', keywords: ['Connected servers', 'mcp'] },
	),
	d(
		'hooks',
		'tools',
		'Hooks',
		'Commands that run on events such as before a tool runs. Edit them in the config file.',
		fileOnly,
		{ group: 'servers-hooks', keywords: [] },
	),
	d(
		'disableHooks',
		'tools',
		'Turn off hooks',
		"Do not run hooks from your config, project and local files. Hooks from an administrator's file and plugins' JavaScript hooks still run.",
		on,
		{ group: 'servers-hooks', default: false, keywords: ['disable hooks', 'run hooks', 'hooks'] },
	),
	d(
		'plugins.enabled',
		'tools',
		'Plugins',
		'Allow plugins to run code. A folder of plugins can also be loaded for one run with --plugin-dir on the command line; that is not saved here.',
		on,
		{
			group: 'code-plugins',
			keywords: [],
			default: false,
			confirm: 'Plugins run code on this computer.',
			confirmWhen: 'on',
		},
	),
	d(
		'plugins.autoDiscovery',
		'tools',
		'Find plugins automatically',
		'Look for plugins in the usual folders.',
		on,
		{ group: 'code-plugins', keywords: ['auto discovery'], default: true },
	),
	d(
		'plugins.hookTimeoutMs',
		'tools',
		'Plugin hook time limit',
		'How long a plugin hook may run before it is cut off. Type minutes and seconds, for example 10m.',
		num(1, 2147483647, 'ms'),
		{ group: 'code-plugins', keywords: ['hook timeout'], default: 600000 },
	),
	d(
		'plugins.allowedScopes',
		'tools',
		'Where plugins may come from',
		'This project, your own folder, or both.',
		checks(['project', 'This project'], ['user', 'Your own folder']),
		{
			group: 'code-plugins',
			keywords: ['allowed scopes', 'scope'],
			default: ['project', 'user'],
			confirm: 'Plugins from a project run code that came with that project.',
		},
	),

	// Telemetry
	d(
		'telemetry.sessionExport.destination',
		'telemetry',
		'Save conversations to a file',
		'Write each conversation to this file. Clearing it stops the saving and also forgets the two choices below.',
		{ kind: 'text', placeholder: '/path/to/file' },
		{
			group: 'saved-conversations',
			keywords: ['session export', 'destination', 'telemetry'],
			confirm: 'Your conversations will be copied to this file.',
		},
	),
	d(
		'telemetry.sessionExport.eventTypes',
		'telemetry',
		'What to save',
		'Only these kinds of events are written to the file. Without this setting every kind is written; an empty choice writes none.',
		{
			kind: 'checks',
			options: SESSION_EXPORT_EVENT_TYPES.map((value) => ({
				value,
				label: eventLabel(value),
			})),
			allLabel: 'All events',
			emptyNote: 'Nothing will be saved.',
		},
		{
			group: 'saved-conversations',
			keywords: ['event types', 'events'],
			default: SESSION_EXPORT_EVENT_TYPES,
		},
	),
	d(
		'telemetry.sessionExport.redactors',
		'telemetry',
		'Hide secrets when saving',
		'Removes keys and tokens from the saved conversations. Off saves everything as it is.',
		{ kind: 'toggle-list', on: ['secrets'], off: [] },
		{
			group: 'saved-conversations',
			keywords: ['redactors', 'redact', 'secrets'],
			default: ['secrets'],
			confirm: 'With nothing hidden, secrets in a conversation are saved as they are.',
			confirmWhen: 'off',
		},
	),
	d(
		'telemetry.otlp.endpoint',
		'telemetry',
		'Send traces to',
		'The address of a trace collector, such as https://collector.example.com:4318. Setting it turns trace export on; clearing it turns it off. Do not put a password in it; the address is shown here as written.',
		{ kind: 'text', placeholder: 'https://' },
		{
			group: 'traces',
			keywords: ['otlp', 'opentelemetry', 'endpoint', 'collector'],
			confirm: 'Traces of your work will be sent to this address.',
		},
	),
	d(
		'telemetry.otlp.headers',
		'telemetry',
		'Trace request headers',
		'Headers sent with traces. They hold a token, so add them under telemetry in the config file shown here; this window does not show or change them.',
		fileOnly,
		{ group: 'traces', keywords: ['Trace sign-in headers', 'otlp headers', 'token'] },
	),

	// Terminal app
	d(
		'tui.theme',
		'terminal',
		'Terminal app theme',
		"The colors of the terminal app. This window's own colors are under Appearance.",
		pick(
			['auto', 'Match the terminal', 'Dark or light, whichever the terminal uses.'],
			['dark', 'Dark', 'Colors for a dark background.'],
			['light', 'Light', 'Colors for a light background.'],
			[
				'dark-daltonized',
				'Dark, color-blind friendly',
				'Dark colors chosen to stay apart for color blindness.',
			],
			[
				'light-daltonized',
				'Light, color-blind friendly',
				'Light colors chosen to stay apart for color blindness.',
			],
			['dark-ansi', 'Dark, basic colours', 'Only the 16 colours every terminal has.'],
			['light-ansi', 'Light, basic colours', 'Only the 16 colours every terminal has.'],
		),
		{ group: 'terminal-look', keywords: ['Theme', 'colour blind', 'colorblind'], default: 'dark' },
	),
	d(
		'tui.reducedMotion',
		'terminal',
		'Reduce motion in the terminal app',
		'Less movement on screen in the terminal app.',
		on,
		{
			group: 'terminal-look',
			keywords: ['reduced motion', 'animation', 'Reduce motion'],
			default: false,
		},
	),
	d(
		'tui.showExpandedTodos',
		'terminal',
		'Expand task lists',
		'Open the task list expanded. Even then it shows four tasks and a count of the rest.',
		on,
		{ group: 'terminal-look', keywords: ['todos', 'show expanded todos'], default: false },
	),
	d(
		'tui.agentCalls',
		'terminal',
		'Show agent activity',
		"Show a waiting agent's last calls and one block for agents that finished. Off drops that detail; the agent rows still show.",
		on,
		{ group: 'terminal-look', keywords: ['Agent calls'], default: true },
	),
	d(
		'tui.fullscreen',
		'terminal',
		'Full screen',
		"Use the whole terminal window, with the mouse. Off keeps the terminal's own scrollback.",
		on,
		{ group: 'terminal-look', keywords: ['fullscreen'], default: true },
	),
	d(
		'tui.wheelAccel',
		'terminal',
		'Accelerate wheel scrolling',
		'A fast run of wheel notches scrolls faster in full screen.',
		on,
		{
			group: 'terminal-mouse',
			keywords: ['Wheel speed-up', 'wheel accel', 'scroll speed'],
			default: true,
		},
	),
	d(
		'tui.wheelRows',
		'terminal',
		'Wheel scroll distance',
		'How many rows one wheel notch scrolls in full screen.',
		num(1, 20, 'rows'),
		{ group: 'terminal-mouse', keywords: ['Rows per wheel notch', 'wheel rows'], default: 3 },
	),
	d(
		'tui.mouse',
		'terminal',
		'Mouse support',
		'Full clicks and scrolling, scrolling only, or off.',
		pick(
			['full', 'Clicks and scrolling', 'The mouse clicks, selects and scrolls.'],
			['scroll', 'Scrolling only', 'The mouse scrolls and nothing else.'],
			[
				'off',
				'Off',
				'Namzu asks for no mouse reports, so the terminal handles the mouse itself. Scroll with the keyboard.',
			],
		),
		{ group: 'terminal-mouse', keywords: ['Mouse', 'click'], default: 'full' },
	),
	d('tui.copyOnSelect', 'terminal', 'Copy on select', 'Copy text when you select it.', on, {
		group: 'terminal-mouse',
		keywords: ['clipboard'],
		default: true,
	}),
	d(
		'tui.recap',
		'terminal',
		'Recap when you return',
		'Write a short recap of a conversation while you are away, so it is there when you come back.',
		on,
		{ group: 'terminal-look', keywords: ['Recap on return', 'summary'], default: true },
	),
	d(
		'tui.syntaxHighlight',
		'terminal',
		'Color code blocks',
		'Color the syntax of code blocks.',
		on,
		{
			group: 'terminal-look',
			keywords: ['Code colour', 'syntax highlight', 'highlight'],
			default: true,
		},
	),
	d('tui.spinnerTips', 'terminal', 'Tips while working', 'Show a tip next to the spinner.', on, {
		group: 'terminal-look',
		keywords: ['spinner tips'],
		default: true,
	}),
	d(
		'tui.notifications',
		'terminal',
		'Terminal notifications',
		'Tell you through the terminal when Namzu needs you. Choose the events; with none chosen this is off.',
		eventChecks(
			['turn-settled', 'approval-required'],
			['turn-settled', 'Turn finished', 'When a reply is done or stops.'],
			['approval-required', 'Approval needed', 'When Namzu waits for your yes or no.'],
			[
				'idle-prompt',
				'Waiting for you',
				'After a minute of quiet, a notice that Namzu is still waiting for your message.',
			],
		),
		{
			group: 'terminal-notifications',
			keywords: ['Notifications', 'bell', 'alert'],
			default: false,
		},
	),
	d(
		'tui.notificationMethod',
		'terminal',
		'Notification method',
		'How the terminal tells you.',
		pick(
			[
				'osc9',
				'Desktop notification',
				'A system notice through the terminal. Most terminals support it.',
			],
			['bel', 'Bell', 'The terminal bell.'],
			['kitty', 'Kitty', 'A notice in the Kitty terminal.'],
			['ghostty', 'Ghostty', 'A notice in the Ghostty terminal.'],
		),
		{ group: 'terminal-notifications', keywords: ['kitty', 'ghostty', 'bell'], default: 'osc9' },
	),
	d(
		'tui.sound',
		'terminal',
		'Terminal notification sound',
		'Play a sound with notifications from the terminal app. The Desktop app has its own switch under General.',
		on,
		{
			group: 'terminal-notifications',
			keywords: ['Sound', 'chime', 'Notification sound'],
			default: true,
		},
	),
	d(
		'tui.workspacesPrefix',
		'terminal',
		'Workspace shortcut key',
		'The key that starts a workspace shortcut. Ctrl+C, Ctrl+D, Ctrl+Z and the keys that are Tab, Enter, Backspace or Escape are not offered.',
		{
			kind: 'key',
			options: PREFIX_KEYS.map((value) => ({ value, label: keyLabel(value) })),
		},
		{
			group: 'terminal-message-box',
			keywords: ['Workspaces key', 'workspaces prefix', 'prefix', 'tmux'],
			default: 'ctrl+b',
		},
	),
	d(
		'composerTriggers.enabled',
		'terminal',
		'Trigger words',
		'Words in the message box that start things, such as hypermode or workflow.',
		on,
		{ group: 'terminal-message-box', keywords: ['Composer triggers', 'triggers'], default: true },
	),
	d(
		'composerTriggers.suggest',
		'terminal',
		'Suggest trigger words',
		'Offer a trigger word when one fits. Triggers you have armed still show.',
		on,
		{ group: 'terminal-message-box', keywords: ['Suggest triggers'], default: true },
	),
	d(
		'composerTriggers.languages',
		'terminal',
		'Trigger word languages',
		'The languages trigger words are listened for in.',
		checks(['en', 'English'], ['tr', 'Turkish']),
		{
			group: 'terminal-message-box',
			keywords: ['Trigger languages', 'turkish', 'english'],
			default: ['en', 'tr'],
		},
	),
	d(
		'composerTriggers.builtin',
		'terminal',
		'Each trigger word',
		'Per trigger word: Arm acts on what you type, Suggest only offers it (Alt+W arms), Off ignores it.',
		{
			kind: 'levels',
			entries: COMPOSER_TRIGGER_IDS.map((value) => ({ value, ...TRIGGER_WORDS[value] })),
			levels: [
				{ value: 'arm', label: 'Arm' },
				{ value: 'suggest', label: 'Suggest' },
				{ value: 'off', label: 'Off' },
			],
		},
		{
			group: 'terminal-message-box',
			keywords: ['Each trigger', 'builtin', 'arm'],
			default: { ...COMPOSER_TRIGGER_DEFAULTS },
		},
	),
	d(
		'statusLine',
		'terminal',
		'Status line',
		'A command whose output fills the terminal status line. It runs a command, so add a statusLine section to the config file shown here; this window does not edit it.',
		fileOnly,
		{ group: 'terminal-message-box', keywords: ['statusline'] },
	),

	// Terminal: the command line
	d(
		'format',
		'terminal',
		'Output format',
		'How commands such as namzu exec print their results: plain text, JSON or YAML. Does not change the terminal app or the Desktop app.',
		pick(
			['text', 'Plain text', 'Readable lines for a person.'],
			['json', 'JSON', 'One structured document, for a script to read.'],
			['yaml', 'YAML', 'Structured text a person can still read.'],
		),
		{ keywords: ['json', 'yaml'], default: 'text', group: 'command-line' },
	),
	d(
		'quiet',
		'terminal',
		'Quiet output',
		'Commands such as namzu exec print only what you asked for, with less around it. Does not change the terminal app or the Desktop app.',
		on,
		{ keywords: ['quiet'], default: false, group: 'command-line' },
	),
	d(
		'profiles',
		'terminal',
		'Profiles',
		'Named bundles of settings you switch between with --profile name on the command line. Add a profiles section to the config file shown here; this window does not edit it.',
		fileOnly,
		{ keywords: ['profile'], group: 'command-line' },
	),
]

/**
 * Keeps each section together and puts its rows under their headings in the order of
 * `SETTING_GROUP_ORDER`. The rows are declared by topic; a screen and `namzu config list` read
 * them by heading, so the order a person sees is settled once, here. Rows of one heading stay in
 * the order they are declared in.
 */
function byHeading(entries: readonly SettingDescriptor[]): readonly SettingDescriptor[] {
	const sections = [...new Set(entries.map((entry) => entry.section))]
	const rank = (entry: SettingDescriptor) =>
		entry.group ? SETTING_GROUP_ORDER.indexOf(entry.group) : -1
	return entries
		.map((entry, at) => ({ entry, at }))
		.sort(
			(a, b) =>
				sections.indexOf(a.entry.section) - sections.indexOf(b.entry.section) ||
				rank(a.entry) - rank(b.entry) ||
				a.at - b.at,
		)
		.map(({ entry }) => entry)
}

export const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = byHeading(DECLARED)

/** Top-level keys with no control, and why. */
export const SETTING_EXCLUSIONS: readonly SettingExclusion[] = [
	{
		key: 'permissionLayers',
		reason: 'Worked out by the loader from the permission rules; it is not a setting.',
	},
	{
		key: 'hooksManagedOnly',
		reason:
			'Only the organisation-managed file can set it, and Desktop writes the user file, so a control here would do nothing.',
	},
	{
		key: 'permissionSettings',
		reason: 'Worked out by the loader from `permissions`; set the keys inside `permissions`.',
	},
]

/** Sub-keys left out on purpose. */
export const SETTING_SUBKEY_EXCLUSIONS: readonly SettingExclusion[] = [
	{ key: 'tui.spacesPrefix', reason: 'A deprecated alias of tui.workspacesPrefix; read only.' },
	{
		key: 'plugins.launchDirs',
		reason:
			'Set for one run by --plugin-dir; the loader never reads it from a file, so a saved value would do nothing.',
	},
]
