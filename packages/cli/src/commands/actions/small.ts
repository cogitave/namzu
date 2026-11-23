import type { ActionHelp } from '../action-help.js'

const JSON_FLAG = { flag: '--json', description: 'Print JSON instead of text.' } as const

export const STATE_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['report'],
		summary: 'List what Namzu keeps and where, without changing anything (the default).',
		example: 'namzu state report',
	},
	{
		path: ['move', 'legacy'],
		summary: 'Move state an earlier Namzu kept in this folder’s .namzu into the Namzu home.',
		flags: [{ flag: '--dry-run', description: 'Say what would move and change nothing.' }],
		example: 'namzu state move legacy --dry-run',
	},
	{
		path: ['purge'],
		operands: '[path]',
		summary: 'Delete the state Namzu keeps in its home for one project.',
		flags: [
			{ flag: '--dry-run', description: 'List what would be deleted and delete nothing.' },
			{ flag: '--yes', description: 'Delete without asking.' },
			{ flag: '--all', description: 'Every project, not one.' },
		],
		example: 'namzu state purge --dry-run',
	},
]

export const COMPUTER_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['status'],
		summary: 'Say whether this PC is ready to run a Pal computer.',
		flags: [
			JSON_FLAG,
			{ flag: '--bundle <dir>', description: 'The folder that comes with the Pal computer.' },
		],
		example: 'namzu computer status',
	},
	{
		path: ['setup'],
		summary: 'Install what is missing for the Pal computer, after you agree.',
		flags: [
			JSON_FLAG,
			{ flag: '--plan <id>', description: 'Consent to a plan printed earlier.' },
			{ flag: '--yes', description: 'Agree without asking.' },
			{ flag: '--bundle <dir>', description: 'The folder that comes with the Pal computer.' },
			{
				flag: '--resume-command <command>',
				description: 'Run once at the next sign-in when setup needs a restart.',
			},
		],
		example: 'namzu computer setup',
	},
	{
		path: ['stop', 'idle'],
		summary: 'Shut the idle Linux machine down.',
		flags: [JSON_FLAG],
		example: 'namzu computer stop idle',
	},
]

export const CONFIG_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['list'],
		summary: 'List the settings and their values.',
		flags: [{ flag: '--section <name>', description: 'List one section only.' }, JSON_FLAG],
		example: 'namzu config list --section permissions',
	},
	{
		path: ['get'],
		operands: '<key>',
		summary: 'Show one setting.',
		flags: [JSON_FLAG],
		example: 'namzu config get permissions.defaultMode',
	},
	{
		path: ['set'],
		operands: '<key> <value>',
		summary: 'Change a setting in your user config file.',
		flags: [{ flag: '-y, --yes', description: 'Answer the question a risky change asks.' }],
		example: 'namzu config set permissions.defaultMode plan',
	},
	{
		path: ['unset'],
		operands: '<key>',
		summary: 'Put a setting back to its default.',
		flags: [{ flag: '-y, --yes', description: 'Answer the question a risky change asks.' }],
		example: 'namzu config unset permissions.defaultMode',
	},
]

export const SKILLS_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['list'],
		summary: 'List the skills available in a working directory.',
		flags: [
			{ flag: '--json', description: 'Print the skills a host UI offers as a JSON array.' },
			{ flag: '--cwd <path>', description: 'Inspect this directory instead of the current one.' },
			{ flag: '--trust', description: 'Trust this directory for this run only.' },
			{
				flag: '--audit',
				description: 'Check which skills the model can load; fail on invalid ones.',
			},
			{
				flag: '--context-window <tokens>',
				description: 'With --audit, estimate overflow for this model window.',
			},
		],
		example: 'namzu skills list --audit',
	},
]

export const PROVIDERS_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['list'],
		summary: 'List every provider, whether one was found here, its default model and its models.',
		flags: [{ flag: '--json', description: 'Print one JSON array for a host UI.' }],
		example: 'namzu providers list --json',
	},
]

export const WORKTREE_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['list'],
		summary: 'List the managed worktrees of this repository.',
		example: 'namzu worktree list',
	},
	{
		path: ['create'],
		operands: '[name]',
		summary: 'Create a worktree from this checkout’s committed HEAD.',
		example: 'namzu worktree create fix-login',
	},
	{
		path: ['fork'],
		operands: '<conversation-id> [name]',
		summary: 'Copy a settled conversation into a new worktree.',
		example: 'namzu worktree fork 3f2a9c fix-login',
	},
	{
		path: ['resume'],
		operands: '<name> [conversation-id]',
		summary: 'Open a worktree’s latest conversation, or the one you name.',
		example: 'namzu worktree resume fix-login',
	},
]

export const ARCHIVE_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['list'],
		summary: 'List archived conversations in this folder, 100 to a page.',
		flags: [{ flag: '--page <n>', description: 'Which page to show.' }],
		example: 'namzu archive list --page 2',
	},
	{
		path: ['restore'],
		operands: '<conversation-id>',
		summary: 'Make an archived conversation available to namzu resume again.',
		example: 'namzu archive restore 3f2a9c',
	},
]

export const PLUGIN_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['validate'],
		operands: '[path]',
		summary: 'Check a plugin folder and every part it carries, running nothing from it.',
		flags: [{ flag: '--json', description: 'Print one JSON report on standard output.' }],
		example: 'namzu plugin validate ./my-plugin --json',
	},
]

export const GITHUB_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['install'],
		summary: 'Write workflow files under .github/workflows that run Namzu from GitHub Actions.',
		flags: [
			{
				flag: '--workflow <mention|review>',
				description: 'Which workflow to write; repeat for both (the default).',
			},
			{
				flag: '--provider <id>',
				description: 'The provider whose key the runner uses (default anthropic).',
			},
			{ flag: '--model <id>', description: 'The model the runner uses.' },
			{ flag: '--secret <name>', description: 'The repository secret that holds the key.' },
			{ flag: '--budget <dollars>', description: 'The spend limit for one run (default 1).' },
			{ flag: '--force', description: 'Overwrite a file that already exists.' },
			{ flag: '--dry-run', description: 'Print what would be written and write nothing.' },
		],
		example: 'namzu github install --workflow review --dry-run',
	},
]
