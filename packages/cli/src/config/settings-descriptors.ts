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
 * - `terminal-app`: changes only the terminal app (colours, mouse, notices, the message box).
 * - `command-line`: changes only the command line, what you type in a shell: its output, its
 *   profiles, how it updates itself. The Desktop app and its conversations do not read these.
 */
export type SettingGroup = 'terminal-app' | 'command-line'

/** The heading each group is drawn under, and the order groups follow inside a section. */
export const SETTING_GROUP_LABELS: Readonly<Record<SettingGroup, string>> = {
	'terminal-app': 'Terminal app',
	'command-line': 'Command line',
}

export const SETTING_GROUP_ORDER: readonly SettingGroup[] = ['terminal-app', 'command-line']

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
	'next-conversation': 'Applies to new conversations. Open ones keep their current value.',
	'next-start': 'Applies the next time Namzu starts.',
	'next-launch': 'Applies the next time the app opens.',
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
	| { readonly kind: 'text'; readonly placeholder?: string }
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
	 * run without a person (see `autoModeLoosens`). Absent means every change asks. Clearing a setting asks
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

const json = (example: string): SettingControl => ({ kind: 'json', example })
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

/** Puts every descriptor of a block under one heading. */
function inGroup(group: SettingGroup, ...entries: SettingDescriptor[]): SettingDescriptor[] {
	return entries.map((entry) => ({ ...entry, group }))
}

export const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = [
	// Models
	d(
		'model',
		'models',
		'Choose the model automatically',
		'Pick a model for each task. Needs the routing default below: a configuration that chooses Automatic without one cannot be saved.',
		pick([
			'auto',
			'Automatic',
			'A routing model picks the model for each task. Needs routing below.',
		]),
		{
			confirm:
				'Namzu will send the start of each task to a model that chooses which model answers.',
		},
	),
	d(
		'routing',
		'models',
		'Automatic routing',
		'Which model is the default, which are fast and large, and how a choice is made.',
		{
			kind: 'routing',
			example:
				'{"default":{"provider":"anthropic","model":"claude-sonnet-4-5"},"tiers":{"fast":{"provider":"anthropic","model":"claude-haiku-4-5"}},"strategy":"yesno","timeoutMs":1500}',
		},
		{
			defaultText: 'not set: Automatic cannot be chosen until a default model is saved',
			confirm: 'Routing sends task text to a model that decides which model answers.',
		},
	),
	d(
		'smallModel',
		'models',
		'Small model',
		'The model for quick side jobs such as titles. Provider/model, or just the model.',
		{ kind: 'model', placeholder: 'provider/model' },
		{
			defaultText: 'the cheapest model with a known price',
			confirm: 'Text from your conversations is sent to this model for side jobs.',
		},
	),
	d(
		'refusalFallback',
		'models',
		'When a model refuses',
		'Try another model when the first one declines to answer.',
		pick(
			['auto', 'Try another model', 'If a model declines, the request goes to a different one.'],
			['off', 'Show the refusal', 'The refusal is shown and nothing else is tried.'],
		),
		{
			default: 'auto',
			confirm: 'The request will be sent to a different model after a refusal.',
			confirmValue: 'auto',
		},
	),
	d(
		'modelCatalogueRefresh',
		'models',
		'Refresh the model list',
		'Look for new models and prices when Namzu starts.',
		on,
		{ default: true },
	),
	d(
		'decision',
		'models',
		'Decision model',
		'A second model that helps with notifications, memory, skills and picks. Add a decision section to the config file shown here (see the decision points page in the docs). The file names the variable that holds the key, never the key.',
		fileOnly,
	),
	d(
		'permissions.autoMode',
		'models',
		'Auto mode reviewer',
		'The model and rules that approve actions in auto mode. A list you leave alone keeps the built-in rules.',
		{
			kind: 'auto-mode',
			lists: [
				{
					value: 'allow',
					label: 'Always allowed',
					help: 'Ordinary work the reviewer never blocks.',
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
					help: 'Places and services the reviewer treats as yours.',
				},
			],
			example:
				'{"model":"anthropic/claude-haiku-4-5","hardDeny":["$defaults","Deleting a production database"]}',
		},
		{
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
		'How Namzu asks before it acts, until you choose otherwise for a conversation.',
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
			default: 'prompt',
			confirm: 'Some modes let Namzu act without asking. Only choose one you are comfortable with.',
			confirmValues: ['accept-edits', 'bypass', 'auto'],
		},
	),
	d(
		'permissions.disableBypassMode',
		'projects',
		'Forbid bypass mode',
		'Remove the mode that skips every question.',
		on,
		{
			default: false,
			confirm: 'Bypass mode, which skips every question, will be available again.',
			confirmWhen: 'off',
		},
	),
	d(
		'permissions.disableAutoMode',
		'projects',
		'Forbid auto mode',
		'Remove the mode that lets a model approve actions.',
		on,
		{
			default: false,
			confirm: 'Auto mode, where a model approves actions, will be available again.',
			confirmWhen: 'off',
		},
	),
	d(
		'permissions.outsideRoot',
		'projects',
		'Paths outside the working folder',
		'Ask before reading or changing a file outside the working folder and the extra folders, or refuse without asking.',
		pick(
			[
				'ask',
				'Ask me',
				'A file outside the working folder is shown to you before Namzu reads or changes it.',
			],
			['refuse', 'Refuse', 'Namzu is refused a file outside the working folder and does not ask.'],
		),
		{
			default: 'ask',
			confirm: 'Namzu will be able to ask about files outside the working folder again.',
			confirmValue: 'ask',
			keywords: ['outside', 'folder', 'directory', 'boundary', 'refuse'],
		},
	),
	d(
		'permissions',
		'projects',
		'Permission rules',
		'Allow, ask or deny a tool, or a pattern of its input.',
		json('{ "bash": "ask", "read": "allow" }'),
		{
			confirm: 'Rules can let tools run without asking you.',
		},
	),
	d(
		'permissionChecks',
		'projects',
		'Permission self-checks',
		'Cases that must come out as allow, ask or deny, checked when Namzu starts.',
		json('[ { "tool": "bash", "input": "rm -rf /", "expect": "deny" } ]'),
		{
			confirm: 'Removing a check means a rule that lets the wrong thing through goes unnoticed.',
		},
	),
	d(
		'additionalDirectories',
		'projects',
		'Extra folders',
		'Folders besides the project that Namzu may read and change. Desktop marks a folder that does not exist.',
		{ kind: 'list', itemLabel: 'folder', placeholder: '/path/to/folder', picker: 'folder' },
		{
			default: [],
			confirm: 'Namzu will be able to reach this folder in every project.',
			confirmWhen: 'widens',
		},
	),
	d(
		'sandbox.enabled',
		'projects',
		'Run in a sandbox',
		'Keep what Namzu runs inside an isolated space. Namzu turns it on by itself when isolation is required or the workspace is a throwaway copy.',
		on,
		{
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
		'Allow leaving the sandbox',
		'Let Namzu ask to run one command outside it.',
		on,
		{
			default: true,
			confirm: 'Namzu will be able to ask to run commands outside the sandbox.',
			confirmWhen: 'on',
		},
	),
	d(
		'sandbox.allowUnattendedEscape',
		'projects',
		'Allow leaving it without asking',
		'Let work nobody is watching, such as a scheduled or headless run, leave the sandbox without a prompt. Work you are watching is not affected.',
		on,
		{
			default: false,
			confirm: 'Unattended work could run commands outside the sandbox with nobody to stop it.',
			confirmWhen: 'on',
		},
	),
	d(
		'sandbox.requireIsolation',
		'projects',
		'Required isolation',
		'If the sandbox cannot isolate every one of these, the run stops instead of going on without it.',
		checks(['filesystem', 'Files'], ['network', 'Network'], ['process', 'Processes']),
		{ default: [] },
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
		{ default: 'working-directory' },
	),
	d(
		'sandbox.teardownTimeoutMs',
		'projects',
		'Sandbox cleanup time limit',
		'How long to wait for a sandbox to be cleaned up after a turn. When the time runs out, cleanup is told to stop and the turn ends without waiting for it. 0 waits as long as it takes.',
		num(0, undefined, 'ms'),
		{ default: 30000 },
	),

	// Updates
	d(
		'updates.channel',
		'updates',
		'Release channel',
		'Which releases the command line (the terminal app) updates to: latest gets new versions first, stable waits longer. The Desktop app has its own releases.',
		pick(
			['latest', 'Newest', 'New versions arrive as soon as they are released.'],
			['stable', 'Stable', 'New versions arrive later, after they have had more use.'],
		),
		{ default: 'latest', group: 'command-line' },
	),
	d(
		'updates.auto',
		'updates',
		'Install new versions automatically',
		'The command line updates itself in the background. The Desktop app updates on its own.',
		on,
		{
			default: true,
			defaultNote: 'Off in automated runs such as CI.',
			confirm: 'Namzu will install new versions of its command line on its own.',
			confirmWhen: 'on',
			group: 'command-line',
			keywords: ['automatic', 'auto update', 'automatic updates', 'background', 'upgrade'],
		},
	),
	d(
		'updates.check',
		'updates',
		'Look for new versions',
		'Look for a new version of the command line when it starts.',
		on,
		{
			default: true,
			group: 'command-line',
			keywords: ['automatic', 'check for updates', 'upgrade'],
		},
	),

	// Agent
	d(
		'hypermode',
		'agent',
		'Hypermode',
		'Let Namzu run longer, larger jobs without stopping to check in.',
		on,
		{
			default: false,
			confirm: 'Namzu will run longer jobs without stopping to check in with you.',
			confirmWhen: 'on',
		},
	),
	d(
		'limits.maxResponseTokens',
		'agent',
		'Longest answer',
		'The most a model may write in one answer.',
		num(1, undefined, 'tokens'),
		{ default: 8192 },
	),
	d(
		'limits.maxReasoningTokens',
		'agent',
		'Thinking budget',
		'The most a model may think before answering. 0 removes the cap.',
		num(0, undefined, 'tokens'),
		{ defaultText: '24000 at medium effort and above' },
	),
	d(
		'limits.doneGate',
		'agent',
		'Check before finishing',
		'Namzu checks its own work once before it ends a turn.',
		on,
		{
			default: true,
			confirm: 'Namzu will end a turn without checking its own work first.',
			confirmWhen: 'off',
		},
	),
	d(
		'limits.maxHookRefusals',
		'agent',
		'Hook refusals before a turn ends',
		'How many times in a row a hook may refuse to let a turn end before Namzu ends it anyway. 0 means no limit.',
		num(0),
		{ default: 8 },
	),
	d(
		'limits.maxIterations',
		'agent',
		'Most steps per turn',
		'The most steps one reply may take before it stops. A turn is one message you send; a step is one round of the model answering or running tools.',
		num(0),
		{
			defaultText: 'no limit',
			confirm: 'With no limit, a turn can keep taking steps until it ends on its own.',
			confirmWhen: 'zero',
		},
	),
	d(
		'limits.tokenBudget',
		'agent',
		'Most tokens per task',
		'0 means no limit.',
		num(0, undefined, 'tokens'),
		{
			defaultText: 'no limit',
			confirm: 'With no limit, a task can use as many tokens as it needs.',
			confirmWhen: 'zero',
		},
	),
	d(
		'limits.timeoutMs',
		'agent',
		'Longest turn time',
		'How long one reply may run before it is stopped. Type minutes and seconds, for example 5m or 90s. 0 means no limit.',
		num(0, 2147483647, 'ms'),
		{ defaultText: 'no limit' },
	),
	d(
		'limits.costLimitUsd',
		'agent',
		'Most spend per task',
		'In US dollars. 0 means no limit.',
		num(0, undefined, 'USD'),
		{
			defaultText: 'no limit',
			confirm: 'With no limit, a task can spend as much as it takes.',
			confirmWhen: 'zero',
		},
	),
	d(
		'limits.waitForProviderMs',
		'agent',
		'Wait for a busy provider',
		'How long a one-shot run (namzu exec) or a scheduled run keeps waiting while a provider is busy or limiting requests, before it stops. Type minutes and seconds, for example 10m.',
		num(1, undefined, 'ms'),
		{ defaultText: 'a one-shot run does not wait; a scheduled run waits 10 minutes' },
	),
	d(
		'workflow.maxConcurrency',
		'agent',
		'Helpers working at once',
		'How many helper agents may run side by side.',
		num(1, 16),
		{ defaultText: 'processors minus 2, at most 16' },
	),
	d(
		'workflow.maxAgents',
		'agent',
		'Most helpers per workflow',
		'A cap on how many helper agents one workflow may start.',
		num(1, 1000),
		{ default: 1000 },
	),
	d(
		'workflow.sizeGuideline',
		'agent',
		'Workflow size',
		'How large a workflow Namzu aims for.',
		pick(
			['unrestricted', 'No advice', 'Namzu is not told how large a workflow to aim for.'],
			['small', 'Small', 'Namzu is advised to keep a workflow under 5 helpers.'],
			['medium', 'Medium', 'Namzu is advised to keep a workflow under 10 helpers.'],
			['large', 'Large', 'Namzu is advised to keep a workflow under 50 helpers.'],
		),
		{ default: 'medium' },
	),
	d(
		'goal.confirmedBy',
		'agent',
		'What ends a goal',
		'What has to be true before a goal is treated as finished.',
		pick(
			['model', 'When the model says so', 'A goal ends when the model says it is done.'],
			[
				'record',
				'After the record is checked',
				'Namzu reads the record of the work first; the goal ends as confirmed, stated and not checked, or not confirmed.',
			],
		),
		{ default: 'model', defaultNote: 'Intended to become record in a later major release.' },
	),
	d(
		'handBack.enabled',
		'agent',
		'Let the model hand a task back',
		'The model may stop and hand the task back to a person when it cannot be done as specified, instead of forcing a result. Adds one tool and a short paragraph to the prompt.',
		on,
		{ default: false },
	),
	d(
		'toolResultScreens',
		'agent',
		'Screens on tool results',
		'Checks applied to what a tool returns before a model reads it. Unticking every screen turns screening off.',
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
			default: ['correspondence'],
			defaultNote: 'Only a result framed as untrusted is checked.',
			confirm: 'Removing a screen lets tool output reach the model unchecked.',
			confirmWhen: 'drops-default',
		},
	),
	d(
		'compaction.strategy',
		'agent',
		'How long chats are shortened',
		'The method used to fit a long conversation in the model window.',
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
		{ default: 'salience' },
	),
	d(
		'compaction.softTargetHeadroom',
		'agent',
		'Room left after shortening',
		'How much further below half the window one round of shortening goes, as a fraction of the window. A larger value shortens less often; 0 shortens only to half the window. Advanced.',
		num(0, 1, 'of the window'),
		{ default: 0.05 },
	),
	d(
		'compaction.autoCompactWindowTokens',
		'agent',
		'Shorten at this size',
		'Shorten the conversation when it reaches this many tokens. Type a number or a short form such as 200k or 1m. Sizes under 100k or over 1m are treated as those limits. NAMZU_AUTO_COMPACT_WINDOW in the environment overrides it.',
		num(100000, 1000000, 'tokens'),
		{ defaultText: "the model's own window" },
	),
	d(
		'compaction.contextWindowTokens',
		'agent',
		'Assumed model window',
		'Override the model window size Namzu assumes. Advanced.',
		num(1, undefined, 'tokens'),
		{ defaultText: 'the window Namzu knows for the model, or 128000 for one it does not know' },
	),
	d(
		'compaction.modelSummary',
		'agent',
		'Summarise with a model',
		'Use the small model to write the summary when shortening. With no small model set up, or with this off, the summary is built from the conversation without a model.',
		on,
		{ default: true },
	),
	d(
		'compaction.recallEvidence',
		'agent',
		'Recall dropped details',
		'Bring back details that shortening removed when they matter.',
		on,
		{ default: true },
	),
	d(
		'compaction.resolveEvidenceQueries',
		'agent',
		'Ask a model what to recall',
		'A paid call that finds the details worth recalling.',
		on,
		{ default: true },
	),
	d(
		'compaction.retainedToolPreviewChars',
		'agent',
		'Kept tool output',
		'How much of a tool result that was too large is kept in the conversation, in characters. It applies to new results only; older ones are not changed. 0 keeps up to 40000.',
		num(0, undefined, 'characters'),
		{ default: 4000 },
	),
	d(
		'compaction.deduplicateObservations',
		'agent',
		'Drop repeated results',
		'Keep one copy of the same tool result.',
		on,
		{ default: true },
	),
	d(
		'compaction.consolidate',
		'agent',
		'Merge notes when shortening',
		'Merge related notes into one when shortening. Turning it on turns off the memory curation writer (Tidy memory with a model).',
		on,
		{ default: false },
	),
	d(
		'compaction.idleCompaction',
		'agent',
		'Shorten while idle',
		'Shorten a large conversation while you are away. It does nothing while the cache lifetime below is 5 minutes.',
		on,
		{
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
		'Shed old results after a long break',
		'When you return after the provider cache has expired, replace old, large tool results with a short note before the first request. They stay readable through the note.',
		on,
		{ default: true },
	),
	d(
		'compaction.idleCompactionMinTokens',
		'agent',
		'Idle shortening starts at',
		'The smallest conversation worth shortening while idle. Anything under 100000 is raised to 100000. NAMZU_IDLE_COMPACT_MIN_TOKENS in the environment overrides it.',
		num(1, undefined, 'tokens'),
		{ default: 200000 },
	),
	d(
		'compaction.promptCacheTtl',
		'agent',
		'Cache lifetime',
		'1h keeps a conversation cheap to resume but costs more to write.',
		pick(
			['5m', '5 minutes', 'The provider keeps a conversation warm for 5 minutes. No extra cost.'],
			[
				'1h',
				'1 hour',
				'Warm for an hour, so coming back is cheaper, but writing the cache costs more.',
			],
		),
		{ default: '5m' },
	),
	d('memory.recall', 'agent', 'Recall memory', 'Bring saved memory into a conversation.', on, {
		default: true,
	}),
	d(
		'memory.identifierGrounding',
		'agent',
		'Check ids against memory',
		'When memory is recalled, match ids that contain digits, such as ticket or commit numbers, against what was recorded. File and function names are not checked against your files.',
		on,
		{ default: false },
	),
	d(
		'memory.select',
		'agent',
		'Choose memory with a model',
		'A model picks which memories to bring in.',
		pick(
			['on', 'On', 'A model picks which memories to bring in.'],
			['off', 'Off', 'Memories are chosen without a model.'],
		),
		{
			default: 'on',
			confirm: 'Memory titles are sent to a model to choose from.',
			confirmValue: 'on',
		},
	),
	d(
		'memory.curation',
		'agent',
		'Tidy memory with a model',
		'A model merges and retires memories.',
		pick(
			['on', 'On', 'A model merges and retires memories.'],
			['off', 'Off', 'Memories are left as they are.'],
		),
		{
			default: 'on',
			confirm: 'Memory content is sent to a model to tidy it.',
			confirmValue: 'on',
		},
	),
	d(
		'memory.retireAfterDays',
		'agent',
		'Retire unused memory after',
		'Days before a memory recorded during a turn retires if it goes unused. Other memories stay. 0 keeps them forever.',
		num(0, undefined, 'days'),
		{ default: 21 },
	),
	d(
		'learningObservations',
		'agent',
		'Learn from your work',
		'Note what you do so Namzu can suggest habits and skills.',
		on,
		{ default: true },
	),
	d(
		'learningGenerator.enabled',
		'agent',
		'Write suggestions from what it learned',
		'Let a model turn observations into suggestions.',
		on,
		{ default: true },
	),
	d(
		'learningGenerator.cycleTokens',
		'agent',
		'Tokens per learning cycle',
		'The most one learning pass may use.',
		num(1000, 10000000, 'tokens'),
		{ default: 120000 },
	),
	d(
		'learningGenerator.dailyTokens',
		'agent',
		'Tokens per day for learning',
		'The most learning may use in a day.',
		num(1000, 10000000, 'tokens'),
		{ default: 300000 },
	),
	d('skills.builtin', 'agent', 'Built-in skills', 'Offer the skills that ship with Namzu.', on, {
		default: true,
	}),
	d(
		'skills.disabled',
		'agent',
		'Turned-off skills',
		'Skills Namzu will not use, by name. Desktop lists the installed skills with a switch each; a name here that no installed skill has stays listed, with Remove.',
		{ kind: 'list', itemLabel: 'skill name', placeholder: 'skill-name', source: 'skills' },
		{ default: [] },
	),
	d(
		'skills.suggest',
		'agent',
		'Suggest saving a skill',
		'After a long task, offer to keep it as a skill. For the terminal app; this window does not offer it.',
		on,
		{ default: true },
	),
	d(
		'skills.suggestMinToolCalls',
		'agent',
		'Suggest after this many steps',
		'How many successful steps a task needs before a skill is suggested. For the terminal app; this window does not offer it.',
		num(1),
		{ default: 6 },
	),
	d(
		'schedule.maxConcurrentRuns',
		'agent',
		'Scheduled runs at once',
		'How many scheduled tasks may run side by side.',
		num(1, 16),
		{ default: 2 },
	),
	d(
		'schedule.notifications',
		'agent',
		'Notify when a scheduled run ends',
		'Tell you when a scheduled task finishes.',
		on,
		{ default: true },
	),

	// Tools
	d(
		'web.search',
		'tools',
		'Web search',
		'Off, cached results only, or live.',
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
			default: 'auto',
			confirm: 'The native option has no local review of what is searched.',
			confirmValue: 'native',
		},
	),
	d('web.fetch', 'tools', 'Fetch web pages', 'Let Namzu read the web pages it is pointed to.', on, {
		default: true,
		confirm: 'Namzu will download pages from the internet.',
		confirmWhen: 'on',
	}),
	d(
		'browser.enabled',
		'tools',
		'Browser',
		'Let Namzu use a browser for web tasks, in the terminal app and in Desktop conversations that use this computer (not in Pal conversations). Off removes the browser tools. The rows below set how it runs.',
		on,
		{
			default: true,
		},
	),
	d(
		'browser.defaultProfile',
		'tools',
		'Browser profile',
		'The browser profile Namzu uses. Sign-ins live in it. Use lowercase letters and digits with single dashes between them, up to 64 characters.',
		{ kind: 'text', placeholder: 'default' },
		{
			default: 'default',
			confirm: 'That profile holds the sign-ins Namzu would use.',
		},
	),
	d(
		'browser.engine',
		'tools',
		'Browser engine',
		'Which browser Namzu drives.',
		pick(
			['auto', 'Automatic', 'Follows this computer.'],
			['windows', 'Windows browser', 'From WSL, drive the browser on Windows.'],
			['local', 'A browser Namzu starts', 'Namzu launches its own browser.'],
		),
		{ default: 'auto' },
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
		{ default: 'auto' },
	),
	d(
		'browser.sites',
		'tools',
		'Browser sites',
		'Per site: deny, read, ask or act. * is every other site.',
		json('{ "example.com": "read", "*": "ask" }'),
		{
			confirm: 'Allowing act lets Namzu click and type on that site.',
		},
	),
	d(
		'browser.keepOpen',
		'tools',
		'Keep the browser open',
		'Leave the browser running between tasks.',
		on,
		{ default: false },
	),
	d(
		'browser.signInDetection',
		'tools',
		'Sign-in pages',
		'Address stops on any /login-style address; page stops only for known sign-in sites and lets other pages load.',
		pick(
			[
				'address',
				'By web address',
				'Stops on any address that looks like a sign-in, such as /login.',
			],
			[
				'page',
				'By page',
				'Stops only on known sign-in sites; other pages load and Namzu is told it cannot type a password.',
			],
		),
		{ default: 'address' },
	),
	d(
		'codeAnalysis.enabled',
		'tools',
		'Code analysis',
		'Let Namzu read the structure of your code (definitions and references), in the terminal app and in Desktop conversations. Off removes the code analysis tool.',
		on,
		{ default: true },
	),
	d(
		'mcpServers',
		'tools',
		'Connected servers',
		'Tool servers Namzu starts or reaches. Desktop adds, edits and removes the ones in your config file; variables and headers hold secrets, so they are edited in the file. In the terminal use namzu mcp.',
		fileOnly,
	),
	d(
		'hooks',
		'tools',
		'Hooks',
		'Commands that run on events such as before a tool runs. Edit them in the config file.',
		fileOnly,
	),
	d(
		'disableHooks',
		'tools',
		'Turn off hooks',
		'Do not run hooks from your config, project and local files. Hooks from an organisation-managed file and the JavaScript hooks of plugins still run.',
		on,
		{ default: false, keywords: ['hooks'] },
	),
	d(
		'plugins.enabled',
		'tools',
		'Plugins',
		'Allow plugins to run code. A folder of plugins can also be loaded for one run with --plugin-dir on the command line; it is not saved here.',
		on,
		{
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
		{ default: true },
	),
	d(
		'plugins.hookTimeoutMs',
		'tools',
		'Plugin hook time limit',
		'How long a plugin hook may run before it is cut off. Type minutes and seconds, for example 10m.',
		num(1, 2147483647, 'ms'),
		{ default: 600000 },
	),
	d(
		'plugins.allowedScopes',
		'tools',
		'Where plugins may come from',
		'Project, user, or both.',
		checks(['project', 'This project'], ['user', 'Your own folder']),
		{
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
		{ default: SESSION_EXPORT_EVENT_TYPES },
	),
	d(
		'telemetry.sessionExport.redactors',
		'telemetry',
		'Hide secrets when saving',
		'Removes keys and tokens from the saved conversations. Off saves everything as it is.',
		{ kind: 'toggle-list', on: ['secrets'], off: [] },
		{
			default: ['secrets'],
			confirm: 'With nothing hidden, secrets in a conversation are saved as they are.',
			confirmWhen: 'off',
		},
	),
	d(
		'telemetry.otlp.endpoint',
		'telemetry',
		'Send traces to',
		'An OpenTelemetry address, such as https://collector.example.com:4318. Setting it turns trace export on; clearing it turns it off. Do not put a password in it; the address is shown here as written.',
		{ kind: 'text', placeholder: 'https://' },
		{
			confirm: 'Traces of your work will be sent to this address.',
		},
	),
	d(
		'telemetry.otlp.headers',
		'telemetry',
		'Trace sign-in headers',
		'Headers sent with traces. They hold a token, so add telemetry.otlp.headers to the config file shown here; this window does not show or change them.',
		fileOnly,
	),

	// Terminal app
	...inGroup(
		'terminal-app',
		d(
			'tui.theme',
			'terminal',
			'Theme',
			"The terminal app's colours. This window's own colours are under Appearance.",
			pick(
				['auto', 'Match the terminal', 'Dark or light, whichever the terminal uses.'],
				['dark', 'Dark', 'Colours for a dark background.'],
				['light', 'Light', 'Colours for a light background.'],
				[
					'dark-daltonized',
					'Dark, colour-blind friendly',
					'Dark colours chosen to stay apart for colour blindness.',
				],
				[
					'light-daltonized',
					'Light, colour-blind friendly',
					'Light colours chosen to stay apart for colour blindness.',
				],
				['dark-ansi', 'Dark, basic colours', 'Only the 16 colours every terminal has.'],
				['light-ansi', 'Light, basic colours', 'Only the 16 colours every terminal has.'],
			),
			{ default: 'dark' },
		),
		d('tui.reducedMotion', 'terminal', 'Reduce motion', 'Less movement on screen.', on, {
			default: false,
		}),
		d(
			'tui.showExpandedTodos',
			'terminal',
			'Expand task lists',
			'Open the task list expanded. Even then it shows four tasks and a count of the rest.',
			on,
			{ default: false },
		),
		d(
			'tui.agentCalls',
			'terminal',
			'Agent calls',
			"Show a waiting agent's last calls and one block for agents that finished. Off drops that call detail; the agent rows still show.",
			on,
			{ default: true },
		),
		d('tui.fullscreen', 'terminal', 'Full screen', 'Use the whole terminal window.', on, {
			default: false,
		}),
		d(
			'tui.wheelAccel',
			'terminal',
			'Wheel speed-up',
			'A fast run of wheel notches scrolls faster in full screen.',
			on,
			{ default: true },
		),
		d(
			'tui.wheelRows',
			'terminal',
			'Rows per wheel notch',
			'How far one wheel notch scrolls in full screen.',
			num(1, 20, 'rows'),
			{ default: 3 },
		),
		d(
			'tui.mouse',
			'terminal',
			'Mouse',
			'Full, scroll only, or off.',
			pick(
				['full', 'Clicks and scrolling', 'The mouse clicks, selects and scrolls.'],
				['scroll', 'Scrolling only', 'The mouse scrolls and nothing else.'],
				[
					'off',
					'Off',
					'Namzu asks for no mouse reports, so the terminal handles the mouse itself. Scroll with the keyboard.',
				],
			),
			{
				default: 'full',
			},
		),
		d('tui.copyOnSelect', 'terminal', 'Copy on select', 'Copy text when you select it.', on, {
			default: true,
		}),
		d(
			'tui.recap',
			'terminal',
			'Recap on return',
			'Write a short recap of a conversation while you are away, so it is there when you come back.',
			on,
			{ default: true },
		),
		d('tui.syntaxHighlight', 'terminal', 'Code colour', 'Colour the syntax of code blocks.', on, {
			default: true,
		}),
		d('tui.spinnerTips', 'terminal', 'Tips while working', 'Show a tip next to the spinner.', on, {
			default: true,
		}),
		d(
			'tui.notifications',
			'terminal',
			'Notifications',
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
			{ default: false },
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
			{ default: 'osc9' },
		),
		d(
			'tui.sound',
			'terminal',
			'Sound',
			'Play a sound with notifications from the terminal app. The Desktop app has its own switch under General.',
			on,
			{
				default: true,
			},
		),
		d(
			'tui.workspacesPrefix',
			'terminal',
			'Workspaces key',
			'The key that starts a workspace shortcut. Ctrl+C, Ctrl+D, Ctrl+Z and the keys that are Tab, Enter, Backspace or Escape are not offered.',
			{
				kind: 'key',
				options: PREFIX_KEYS.map((value) => ({ value, label: keyLabel(value) })),
			},
			{ default: 'ctrl+b' },
		),
		d(
			'composerTriggers.enabled',
			'terminal',
			'Composer triggers',
			'Words in the message box that start things.',
			on,
			{ default: true },
		),
		d(
			'composerTriggers.suggest',
			'terminal',
			'Suggest triggers',
			'Offer a trigger when one fits. Triggers you have armed still show.',
			on,
			{ default: true },
		),
		d(
			'composerTriggers.languages',
			'terminal',
			'Trigger languages',
			'Languages the triggers listen for.',
			checks(['en', 'English'], ['tr', 'Turkish']),
			{ default: ['en', 'tr'] },
		),
		d(
			'composerTriggers.builtin',
			'terminal',
			'Each trigger',
			'Per trigger: Arm acts on what you type, Suggest only offers it (Alt+W arms), Off ignores it.',
			{
				kind: 'levels',
				entries: COMPOSER_TRIGGER_IDS.map((value) => ({ value, ...TRIGGER_WORDS[value] })),
				levels: [
					{ value: 'arm', label: 'Arm' },
					{ value: 'suggest', label: 'Suggest' },
					{ value: 'off', label: 'Off' },
				],
			},
			{ default: { ...COMPOSER_TRIGGER_DEFAULTS } },
		),
		d(
			'statusLine',
			'terminal',
			'Status line',
			'A command whose output fills the terminal status line. It runs a command, so add a statusLine section to the config file shown here; this window does not edit it.',
			fileOnly,
		),
	),

	// Terminal: the command line
	d(
		'format',
		'terminal',
		'Output format',
		'How commands such as namzu exec print their results. Does not change the terminal app or the Desktop app.',
		pick(
			['text', 'Plain text', 'Readable lines for a person.'],
			['json', 'JSON', 'One structured document, for a script to read.'],
			['yaml', 'YAML', 'Structured text a person can still read.'],
		),
		{ default: 'text', group: 'command-line' },
	),
	d(
		'quiet',
		'terminal',
		'Quiet output',
		'Commands such as namzu exec print only what you asked for, with less around it. Does not change the terminal app or the Desktop app.',
		on,
		{
			default: false,
			group: 'command-line',
		},
	),
	d(
		'profiles',
		'terminal',
		'Profiles',
		'Named bundles of settings you switch between with --profile name on the command line. Add a profiles section to the config file shown here; this window does not edit it.',
		fileOnly,
		{ group: 'command-line' },
	),
]

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
