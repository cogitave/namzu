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

/** A value a setting holds when nothing is saved. A list is the list of ticked option values. */
export type SettingDefault = boolean | number | string | readonly string[]

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
	| { readonly kind: 'checks'; readonly options: readonly SettingOption[] }
	| {
			readonly kind: 'number'
			readonly min?: number
			readonly max?: number
			readonly unit?: string
	  }
	| { readonly kind: 'text'; readonly placeholder?: string }
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
	 * Which new value asks. `on` and `off` apply to a toggle, `zero` to a number where 0 removes a
	 * cap. Absent means every change asks. Clearing a setting always asks, because the default it
	 * returns to is not known to the one asking.
	 */
	readonly confirmWhen?: 'on' | 'off' | 'zero'
	/**
	 * For a select, the one new value that asks; choosing any other value applies at once. Clearing
	 * still asks. Absent means every change to a select asks.
	 */
	readonly confirmValue?: string
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
const json = (example: string): SettingControl => ({ kind: 'json', example })
const fileOnly: SettingControl = { kind: 'file-only' }

/**
 * When a key's saved value is read. Found from the code that reads it: the terminal app, the
 * schedule daemon, the update check and telemetry read once at launch; the engine reads the rest
 * when a conversation is created. Keys whose reader was not traced to a session default to
 * `next-start`, the later and therefore safe claim.
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
	]
	if (startOnly.some((prefix) => path.startsWith(prefix))) return 'next-start'
	const next = new Set([
		'format',
		'quiet',
		'hypermode',
		'profiles',
		'model',
		'routing',
		'smallModel',
		'refusalFallback',
		'modelCatalogueRefresh',
		'decision',
		'permissions.autoMode',
		'limits.waitForProviderMs',
		'compaction.promptCacheTtl',
		'compaction.clearStaleResultsAfterIdle',
		'memory.retireAfterDays',
		'learningObservations',
		'codeAnalysis.enabled',
		'browser.enabled',
		'statusLine',
		'mcpServers',
		'goal.confirmedBy',
		'skills.suggest',
		'skills.suggestMinToolCalls',
	])
	return next.has(path) ? 'next-start' : 'next-conversation'
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

export const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = [
	// General
	d(
		'format',
		'terminal',
		'Output format',
		'How the command line prints its results.',
		pick(
			['text', 'Plain text', 'Readable lines for a person.'],
			['json', 'JSON', 'One structured document, for a script to read.'],
			['yaml', 'YAML', 'Structured text a person can still read.'],
		),
		{ default: 'text' },
	),
	d(
		'quiet',
		'terminal',
		'Quiet output',
		'Print only what was asked for. For the terminal app.',
		on,
		{
			default: false,
		},
	),
	d(
		'hypermode',
		'general',
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
		'profiles',
		'general',
		'Profiles',
		'Named bundles of settings you switch between. Edit them in the config file.',
		fileOnly,
	),

	// Models
	d(
		'model',
		'models',
		'Choose the model automatically',
		'Pick a model for each task. Needs routing below.',
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
		json('{ "default": { "provider": "anthropic", "model": "..." }, "strategy": "yesno" }'),
		{
			confirm: 'Routing sends task text to a model that decides which model answers.',
		},
	),
	d(
		'smallModel',
		'models',
		'Small model',
		'The model for quick side jobs such as titles. Provider/model, or just the model.',
		{ kind: 'text', placeholder: 'provider/model' },
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
		'A second model that helps with notifications, memory, skills and picks. Set it up from the terminal; it keeps no secret in this file.',
		fileOnly,
	),
	d(
		'permissions.autoMode',
		'models',
		'Auto mode reviewer',
		'The model and rules that approve actions in auto mode.',
		json('{ "model": "provider/model" }'),
		{
			confirm: 'This decides which actions are approved without asking you.',
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
		'Folders besides the project that Namzu may read and change.',
		json('[ "/path/to/folder" ]'),
		{
			confirm: 'Namzu will be able to reach these folders in every project.',
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
		'updates.auto',
		'terminal',
		'Install command line updates automatically',
		'Namzu updates itself in the background.',
		on,
		{
			default: true,
			defaultNote: 'Off in automated runs such as CI.',
			confirm: 'Namzu will install new versions of its command line on its own.',
			confirmWhen: 'on',
		},
	),
	d(
		'updates.channel',
		'updates',
		'Update channel',
		'latest gets new versions first, stable waits longer.',
		pick(
			['latest', 'Newest', 'New versions arrive as soon as they are released.'],
			['stable', 'Stable', 'New versions arrive later, after they have had more use.'],
		),
		{ default: 'latest' },
	),
	d(
		'updates.check',
		'terminal',
		'Check for command line updates',
		'Look for a new version when Namzu starts.',
		on,
		{ default: true },
	),

	// Agent
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
		{ default: 8, defaultNote: '0 means no limit.' },
	),
	d('limits.maxIterations', 'agent', 'Most steps per task', '0 means no limit.', num(0), {
		defaultText: 'no limit',
		confirm: 'With no limit, a task can keep taking steps until it ends on its own.',
		confirmWhen: 'zero',
	}),
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
		'Longest task time',
		'0 means no limit.',
		num(0, undefined, 'ms'),
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
		'terminal',
		'Wait for a busy provider',
		'How long a one-shot run waits when a provider is busy.',
		num(0, undefined, 'ms'),
		{ default: 0 },
	),
	d(
		'workflow.maxConcurrency',
		'agent',
		'Helpers working at once',
		'How many helper agents may run side by side.',
		num(2, 16),
		{ defaultText: 'your processor count minus 2, at most 16' },
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
		'Checks applied to what a tool returns before a model reads it.',
		json('[ "correspondence", "injection" ]'),
		{
			confirm: 'Removing a screen lets tool output reach the model unchecked.',
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
		'Shorten the conversation when it reaches this many tokens.',
		num(1, undefined, 'tokens'),
	),
	d(
		'compaction.contextWindowTokens',
		'agent',
		'Assumed model window',
		'Override the model window size Namzu assumes. Advanced.',
		num(1, undefined, 'tokens'),
	),
	d(
		'compaction.modelSummary',
		'agent',
		'Summarise with a model',
		'Use a model to write the summary when shortening.',
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
		'Merge related notes into one.',
		on,
		{ default: false },
	),
	d(
		'compaction.idleCompaction',
		'agent',
		'Shorten while idle',
		'Shorten a large conversation while you are away.',
		on,
		{ default: false },
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
		'The smallest conversation worth shortening while idle. At least 100000.',
		num(100000, undefined, 'tokens'),
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
		num(1000, undefined, 'tokens'),
		{ default: 120000 },
	),
	d(
		'learningGenerator.dailyTokens',
		'agent',
		'Tokens per day for learning',
		'The most learning may use in a day.',
		num(1000, undefined, 'tokens'),
		{ default: 300000 },
	),
	d('skills.builtin', 'agent', 'Built-in skills', 'Offer the skills that ship with Namzu.', on, {
		default: true,
	}),
	d(
		'skills.disabled',
		'agent',
		'Turned-off skills',
		'Skills Namzu will not use, by name.',
		json('[ "skill-name" ]'),
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
		num(1),
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
		'off, cached results only, or live.',
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
		},
	),
	d('web.fetch', 'tools', 'Fetch web pages', 'Let Namzu read the web pages it is pointed to.', on, {
		default: true,
		confirm: 'Namzu will download pages from the internet.',
		confirmWhen: 'on',
	}),
	d('browser.enabled', 'terminal', 'Browser', 'Let the terminal app use a browser.', on, {
		default: true,
	}),
	d(
		'browser.defaultProfile',
		'tools',
		'Browser profile',
		'The browser profile Namzu uses. Sign-ins live in it.',
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
		'auto decides, always hides it, never shows it.',
		pick(
			['auto', 'Let Namzu decide', 'Hidden unless a page needs you to see it.'],
			['never', 'Always show it', 'The browser window stays visible.'],
			['always', 'Always hide it', 'The browser runs without a window.'],
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
		'address stops on any /login-style address; page stops only for known sign-in sites and lets other pages load.',
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
		'terminal',
		'Code analysis',
		'Understand code structure in the terminal app.',
		on,
		{ default: true },
	),
	d(
		'mcpServers',
		'tools',
		'Connected servers',
		'Tool servers Namzu starts or reaches. They hold commands and secrets, so edit them in the config file or the terminal.',
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
	d('plugins.enabled', 'tools', 'Plugins', 'Allow plugins to run code.', on, {
		default: false,
		confirm: 'Plugins run code on this computer.',
		confirmWhen: 'on',
	}),
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
		'How long a plugin hook may run before it is cut off.',
		num(1, undefined, 'ms'),
		{ default: 600000 },
	),
	d(
		'plugins.allowedScopes',
		'tools',
		'Where plugins may come from',
		'project, user, or both.',
		checks(['project', 'This project'], ['user', 'Your own folder']),
		{
			default: ['project', 'user'],
			confirm: 'Plugins from a project run code that came with that project.',
		},
	),
	d(
		'plugins.launchDirs',
		'tools',
		'Plugin folders',
		'Extra folders to load plugins from.',
		json('[ "/path/to/plugins" ]'),
		{
			confirm: 'Plugins in these folders run code on this computer.',
		},
	),

	// Telemetry
	d(
		'telemetry.sessionExport.destination',
		'telemetry',
		'Save conversations to a file',
		'Write each conversation to this file.',
		{ kind: 'text', placeholder: '/path/to/file' },
		{
			confirm: 'Your conversations will be copied to this file.',
		},
	),
	d(
		'telemetry.sessionExport.eventTypes',
		'telemetry',
		'What to save',
		'Only these kinds of events. Empty means all.',
		json('[ "message" ]'),
	),
	d(
		'telemetry.sessionExport.redactors',
		'telemetry',
		'Hide secrets when saving',
		'secrets removes keys and tokens. An empty list saves everything as is.',
		json('[ "secrets" ]'),
		{
			confirm: 'With nothing hidden, secrets in a conversation are saved as they are.',
		},
	),
	d(
		'telemetry.otlp.endpoint',
		'telemetry',
		'Send traces to',
		'An OpenTelemetry address. Do not put a password in it; the address is shown here as written.',
		{ kind: 'text', placeholder: 'https://' },
		{
			confirm: 'Traces of your work will be sent to this address.',
		},
	),
	d(
		'telemetry.otlp.headers',
		'telemetry',
		'Trace sign-in headers',
		'Headers sent with traces. They hold a token, so edit them in the config file.',
		fileOnly,
	),

	// Terminal app
	d(
		'tui.theme',
		'terminal',
		'Terminal theme',
		'Colours in the terminal app.',
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
	d('tui.reducedMotion', 'terminal', 'Reduce motion', 'Less movement in the terminal app.', on, {
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
		'full, scroll only, or off.',
		pick(
			['full', 'Clicks and scrolling', 'The mouse clicks, selects and scrolls.'],
			['scroll', 'Scrolling only', 'The mouse scrolls and nothing else.'],
			['off', 'Off', 'The terminal handles the mouse itself.'],
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
	d('tui.notifications', 'terminal', 'Notifications', 'Which events notify you.', json('true'), {
		default: false,
	}),
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
		'Sound in the terminal app',
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
		'The key that starts a workspace shortcut, like ctrl+b.',
		{ kind: 'text', placeholder: 'ctrl+b' },
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
		'Per trigger: arm, suggest or off.',
		json('{ "hypermode": "suggest" }'),
	),
	d(
		'statusLine',
		'terminal',
		'Status line',
		'A command whose output fills the terminal status line. It runs a command, so edit it in the config file.',
		fileOnly,
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
]
