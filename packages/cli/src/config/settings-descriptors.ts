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

export interface SettingOption {
	readonly value: string
	readonly label: string
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
	/** What applies when the key is absent, in words. */
	readonly defaultText?: string
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
const pick = (...values: string[]): SettingControl => ({
	kind: 'select',
	options: values.map((value) => ({ value, label: value })),
})
const checks = (...values: string[]): SettingControl => ({
	kind: 'checks',
	options: values.map((value) => ({ value, label: value })),
})
const json = (example: string): SettingControl => ({ kind: 'json', example })
const fileOnly: SettingControl = { kind: 'file-only' }

function d(
	path: string,
	section: SettingSection,
	label: string,
	description: string,
	control: SettingControl,
	more: Pick<
		SettingDescriptor,
		'defaultText' | 'confirm' | 'confirmWhen' | 'confirmValue' | 'keywords'
	> = {},
): SettingDescriptor {
	return { path, section, label, description, control, ...more }
}

export const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = [
	// General
	d(
		'format',
		'terminal',
		'Output format',
		'How the command line prints its results.',
		pick('text', 'json', 'yaml'),
		{ defaultText: 'text' },
	),
	d('quiet', 'terminal', 'Quiet output', 'Print only what was asked for.', on, {
		defaultText: 'off',
	}),
	d(
		'hypermode',
		'general',
		'Hypermode',
		'Let Namzu run longer, larger jobs without stopping to check in.',
		on,
		{
			defaultText: 'off',
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
		pick('auto'),
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
		pick('auto', 'off'),
		{
			defaultText: 'auto',
			confirm: 'The request will be sent to a different model after a refusal.',
		},
	),
	d(
		'modelCatalogueRefresh',
		'models',
		'Refresh the model list',
		'Look for new models and prices when Namzu starts.',
		on,
		{ defaultText: 'on' },
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
		pick('prompt', 'accept-edits', 'plan', 'bypass', 'auto', 'strict'),
		{
			defaultText: 'prompt',
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
			confirm: 'Auto mode, where a model approves actions, will be available again.',
			confirmWhen: 'off',
		},
	),
	d(
		'permissions.outsideRoot',
		'projects',
		'Paths outside the working folder',
		'Ask before reading or changing a file outside the working folder and the extra folders, or refuse without asking.',
		pick('ask', 'refuse'),
		{
			defaultText: 'ask',
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
		'Keep what Namzu runs inside an isolated space.',
		on,
		{
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
			defaultText: 'on',
			confirm: 'Namzu will be able to ask to run commands outside the sandbox.',
			confirmWhen: 'on',
		},
	),
	d(
		'sandbox.allowUnattendedEscape',
		'projects',
		'Allow leaving it without asking',
		'Let work nobody is watching run outside the sandbox.',
		on,
		{
			defaultText: 'off',
			confirm: 'Unattended work could run commands outside the sandbox with nobody to stop it.',
			confirmWhen: 'on',
		},
	),
	d(
		'sandbox.requireIsolation',
		'projects',
		'Required isolation',
		'Namzu refuses to start when the sandbox cannot isolate all of these.',
		checks('filesystem', 'network', 'process'),
	),
	d(
		'sandbox.workspace',
		'projects',
		'Sandbox workspace',
		'Work in the project folder, or in a throwaway copy.',
		pick('working-directory', 'ephemeral'),
		{ defaultText: 'working-directory' },
	),
	d(
		'sandbox.teardownTimeoutMs',
		'projects',
		'Sandbox cleanup time limit',
		'How long to wait while a sandbox shuts down. 0 waits as long as it takes.',
		num(0, undefined, 'ms'),
		{ defaultText: '30000' },
	),

	// Updates
	d(
		'updates.auto',
		'terminal',
		'Install command line updates automatically',
		'Namzu updates itself in the background.',
		on,
		{
			confirm: 'Namzu will install new versions of its command line on its own.',
			confirmWhen: 'on',
		},
	),
	d(
		'updates.channel',
		'updates',
		'Update channel',
		'latest gets new versions first, stable waits longer.',
		pick('latest', 'stable'),
		{ defaultText: 'latest' },
	),
	d(
		'updates.check',
		'terminal',
		'Check for command line updates',
		'Look for a new version when Namzu starts.',
		on,
	),

	// Agent
	d(
		'limits.maxResponseTokens',
		'agent',
		'Longest answer',
		'The most a model may write in one answer.',
		num(1, undefined, 'tokens'),
		{ defaultText: '8192' },
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
			defaultText: 'on',
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
		{ defaultText: '8 (0 for no limit)' },
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
		{ defaultText: '0' },
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
		{ defaultText: '1000' },
	),
	d(
		'workflow.sizeGuideline',
		'agent',
		'Workflow size',
		'How large a workflow Namzu aims for.',
		pick('unrestricted', 'small', 'medium', 'large'),
		{ defaultText: 'medium' },
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
		pick('structured', 'salience'),
		{ defaultText: 'salience' },
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
		{ defaultText: 'on' },
	),
	d(
		'compaction.recallEvidence',
		'agent',
		'Recall dropped details',
		'Bring back details that shortening removed when they matter.',
		on,
		{ defaultText: 'on' },
	),
	d(
		'compaction.resolveEvidenceQueries',
		'agent',
		'Ask a model what to recall',
		'A paid call that finds the details worth recalling.',
		on,
		{ defaultText: 'on' },
	),
	d(
		'compaction.retainedToolPreviewChars',
		'agent',
		'Kept tool output',
		'Characters of each tool result kept after shortening. 0 keeps up to 40000.',
		num(0, undefined, 'characters'),
		{ defaultText: '4000' },
	),
	d(
		'compaction.deduplicateObservations',
		'agent',
		'Drop repeated results',
		'Keep one copy of the same tool result.',
		on,
		{ defaultText: 'on' },
	),
	d(
		'compaction.consolidate',
		'agent',
		'Merge notes when shortening',
		'Merge related notes into one.',
		on,
	),
	d(
		'compaction.idleCompaction',
		'agent',
		'Shorten while idle',
		'Shorten a large conversation while you are away.',
		on,
		{ defaultText: 'off' },
	),
	d(
		'compaction.idleCompactionMinTokens',
		'agent',
		'Idle shortening starts at',
		'The smallest conversation worth shortening while idle. At least 100000.',
		num(100000, undefined, 'tokens'),
		{ defaultText: '200000' },
	),
	d(
		'compaction.promptCacheTtl',
		'agent',
		'Cache lifetime',
		'1h keeps a conversation cheap to resume but costs more to write.',
		pick('5m', '1h'),
		{ defaultText: '5m' },
	),
	d('memory.recall', 'agent', 'Recall memory', 'Bring saved memory into a conversation.', on, {
		defaultText: 'on',
	}),
	d(
		'memory.identifierGrounding',
		'agent',
		'Check names against memory',
		'Verify file and function names before using them.',
		on,
		{ defaultText: 'off' },
	),
	d(
		'memory.select',
		'agent',
		'Choose memory with a model',
		'A model picks which memories to bring in.',
		pick('on', 'off'),
		{
			defaultText: 'on',
			confirm: 'Memory titles are sent to a model to choose from.',
		},
	),
	d(
		'memory.curation',
		'agent',
		'Tidy memory with a model',
		'A model merges and retires memories.',
		pick('on', 'off'),
		{
			defaultText: 'on',
			confirm: 'Memory content is sent to a model to tidy it.',
		},
	),
	d(
		'memory.retireAfterDays',
		'agent',
		'Retire unused memory after',
		'Days before an unused memory retires. 0 keeps it forever.',
		num(0, undefined, 'days'),
		{ defaultText: '21' },
	),
	d(
		'learningObservations',
		'agent',
		'Learn from your work',
		'Note what you do so Namzu can suggest habits and skills.',
		on,
		{ defaultText: 'on' },
	),
	d(
		'learningGenerator.enabled',
		'agent',
		'Write suggestions from what it learned',
		'Let a model turn observations into suggestions.',
		on,
	),
	d(
		'learningGenerator.cycleTokens',
		'agent',
		'Tokens per learning cycle',
		'The most one learning pass may use.',
		num(1000, undefined, 'tokens'),
		{ defaultText: '120000' },
	),
	d(
		'learningGenerator.dailyTokens',
		'agent',
		'Tokens per day for learning',
		'The most learning may use in a day.',
		num(1000, undefined, 'tokens'),
		{ defaultText: '300000' },
	),
	d('skills.builtin', 'agent', 'Built-in skills', 'Offer the skills that ship with Namzu.', on, {
		defaultText: 'on',
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
		'After a long task, offer to keep it as a skill.',
		on,
		{ defaultText: 'on' },
	),
	d(
		'skills.suggestMinToolCalls',
		'agent',
		'Suggest after this many steps',
		'How long a task must be before a skill is suggested.',
		num(1),
		{ defaultText: '6' },
	),
	d(
		'schedule.maxConcurrentRuns',
		'agent',
		'Scheduled runs at once',
		'How many scheduled tasks may run side by side.',
		num(1),
		{ defaultText: '2' },
	),
	d(
		'schedule.notifications',
		'agent',
		'Notify when a scheduled run ends',
		'Tell you when a scheduled task finishes.',
		on,
		{ defaultText: 'on' },
	),

	// Tools
	d(
		'web.search',
		'tools',
		'Web search',
		'off, cached results only, or live.',
		pick('off', 'cached', 'live'),
		{
			defaultText: 'live',
			confirm: 'Namzu will search the web and send queries out.',
		},
	),
	d(
		'web.backend',
		'tools',
		'Web search service',
		'Which service answers web searches.',
		pick('auto', 'exa', 'native'),
		{
			defaultText: 'auto',
			confirm: 'The native option has no local review of what is searched.',
		},
	),
	d('web.fetch', 'tools', 'Fetch web pages', 'Let Namzu read the web pages it is pointed to.', on, {
		defaultText: 'on',
		confirm: 'Namzu will download pages from the internet.',
		confirmWhen: 'on',
	}),
	d('browser.enabled', 'terminal', 'Browser', 'Let the terminal app use a browser.', on, {
		defaultText: 'on',
	}),
	d(
		'browser.defaultProfile',
		'tools',
		'Browser profile',
		'The browser profile Namzu uses. Sign-ins live in it.',
		{ kind: 'text', placeholder: 'default' },
		{
			defaultText: 'default',
			confirm: 'That profile holds the sign-ins Namzu would use.',
		},
	),
	d(
		'browser.engine',
		'tools',
		'Browser engine',
		'Which browser Namzu drives.',
		pick('auto', 'windows', 'local'),
		{ defaultText: 'auto' },
	),
	d(
		'browser.headless',
		'tools',
		'Show the browser window',
		'auto decides, always hides it, never shows it.',
		pick('auto', 'always', 'never'),
		{ defaultText: 'auto' },
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
		{ defaultText: 'off' },
	),
	d(
		'codeAnalysis.enabled',
		'terminal',
		'Code analysis',
		'Understand code structure in the terminal app.',
		on,
		{ defaultText: 'on' },
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
	d('plugins.enabled', 'tools', 'Plugins', 'Allow plugins to run code.', on, {
		defaultText: 'off',
		confirm: 'Plugins run code on this computer.',
		confirmWhen: 'on',
	}),
	d(
		'plugins.autoDiscovery',
		'tools',
		'Find plugins automatically',
		'Look for plugins in the usual folders.',
		on,
	),
	d(
		'plugins.hookTimeoutMs',
		'tools',
		'Plugin hook time limit',
		'How long a plugin hook may run.',
		num(1, undefined, 'ms'),
	),
	d(
		'plugins.allowedScopes',
		'tools',
		'Where plugins may come from',
		'project, user, or both.',
		checks('project', 'user'),
		{
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
		pick('auto', 'dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi'),
		{ defaultText: 'dark' },
	),
	d('tui.reducedMotion', 'terminal', 'Reduce motion', 'Less movement in the terminal app.', on),
	d(
		'tui.showExpandedTodos',
		'terminal',
		'Expand task lists',
		'Show every task, not a summary.',
		on,
	),
	d('tui.fullscreen', 'terminal', 'Full screen', 'Use the whole terminal window.', on),
	d('tui.mouse', 'terminal', 'Mouse', 'full, scroll only, or off.', pick('full', 'scroll', 'off'), {
		defaultText: 'full',
	}),
	d('tui.copyOnSelect', 'terminal', 'Copy on select', 'Copy text when you select it.', on, {
		defaultText: 'on',
	}),
	d(
		'tui.recap',
		'terminal',
		'Recap on return',
		'A short recap when you come back to a conversation.',
		on,
		{ defaultText: 'on' },
	),
	d('tui.spinnerTips', 'terminal', 'Tips while working', 'Show a tip next to the spinner.', on, {
		defaultText: 'on',
	}),
	d('tui.notifications', 'terminal', 'Notifications', 'Which events notify you.', json('true'), {
		defaultText: 'off',
	}),
	d(
		'tui.notificationMethod',
		'terminal',
		'Notification method',
		'How the terminal tells you.',
		pick('osc9', 'bel', 'kitty', 'ghostty'),
		{ defaultText: 'osc9' },
	),
	d('tui.sound', 'terminal', 'Sound', 'Play a sound with notifications.', on, {
		defaultText: 'on',
	}),
	d(
		'tui.workspacesPrefix',
		'terminal',
		'Workspaces key',
		'The key that starts a workspace shortcut, like ctrl+b.',
		{ kind: 'text', placeholder: 'ctrl+b' },
		{ defaultText: 'ctrl+b' },
	),
	d(
		'composerTriggers.enabled',
		'terminal',
		'Composer triggers',
		'Words in the message box that start things.',
		on,
		{ defaultText: 'on' },
	),
	d(
		'composerTriggers.suggest',
		'terminal',
		'Suggest triggers',
		'Offer a trigger when one fits.',
		on,
		{ defaultText: 'on' },
	),
	d(
		'composerTriggers.languages',
		'terminal',
		'Trigger languages',
		'Languages the triggers listen for.',
		checks('en', 'tr'),
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
		key: 'permissionSettings',
		reason: 'Worked out by the loader from `permissions`; set the keys inside `permissions`.',
	},
]

/** Sub-keys left out on purpose. */
export const SETTING_SUBKEY_EXCLUSIONS: readonly SettingExclusion[] = [
	{ key: 'tui.spacesPrefix', reason: 'A deprecated alias of tui.workspacesPrefix; read only.' },
]
