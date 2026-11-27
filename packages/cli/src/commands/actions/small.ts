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
	{
		path: ['add'],
		operands: '<file.zip|file.skill|file.md|folder>...',
		summary:
			'Add skills from files or folders (up to 20, 30 MB each) to your skills or the project’s.',
		flags: [
			{ flag: '--scope user|project', description: 'Where it lives (default user).' },
			{ flag: '--name <skill>', description: 'Use this name instead of the file’s (one input).' },
			{
				flag: '--replace',
				description: 'Replace a skill of the same name; the old one is kept in backups.',
			},
			{ flag: '--yes', description: 'Accept the commands it can run and a replacement.' },
			{ flag: '--json', description: 'Print one JSON object.' },
		],
		example: 'namzu skills add weekly-report.zip',
	},
	{
		path: ['create'],
		operands: '<name>',
		summary: 'Write a skill from flags, with no model.',
		flags: [
			{
				flag: '--description <text>',
				description: 'When to use it (required, at most 1024 characters).',
			},
			{ flag: '--instructions <text>', description: 'The instructions.' },
			{
				flag: '--instructions-file <path|->',
				description: 'Read the instructions from a file or standard input.',
			},
			{ flag: '--scope user|project', description: 'Where it lives (default user).' },
			{ flag: '--replace', description: 'Replace a skill of the same name.' },
			{ flag: '--json', description: 'Print one JSON object.' },
		],
		example:
			'namzu skills create weekly-report --description "Weekly status report." --instructions-file -',
	},
	{
		path: ['remove'],
		operands: '<name>',
		summary: 'Remove a skill you added; a copy is kept in backups.',
		flags: [
			{ flag: '--scope user|project', description: 'Which one, when both exist.' },
			{ flag: '--yes', description: 'Do not ask first.' },
			{ flag: '--json', description: 'Print one JSON object.' },
		],
		example: 'namzu skills remove weekly-report',
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
	{
		path: ['list'],
		summary: 'List the installed plugins that apply here: id, version, scope, on or off.',
		flags: [
			{ flag: '--cwd <dir>', description: 'The folder whose project plugins are meant.' },
			{ flag: '--json', description: 'Print one JSON object on standard output.' },
		],
		example: 'namzu plugin list --json',
	},
	{
		path: ['details'],
		operands: '<id>',
		summary: 'Show one installed plugin: what it brings, its record, who turned it on, its data.',
		flags: [
			{ flag: '--cwd <dir>', description: 'The folder whose project plugins are meant.' },
			{ flag: '--json', description: 'Print one JSON object on standard output.' },
		],
		example: 'namzu plugin details ledger@team-tools',
	},
	{
		path: ['enable'],
		operands: '<id>',
		summary: 'Record a yes for an installed plugin; it takes effect in new conversations.',
		flags: [
			{
				flag: '--scope <user|project|local>',
				description: 'The record to act on and the file it is written to.',
			},
			{ flag: '--cwd <dir>', description: 'The folder whose project plugins are meant.' },
			{ flag: '--json', description: 'Print one JSON object on standard output.' },
		],
		example: 'namzu plugin enable ledger@team-tools --scope user',
	},
	{
		path: ['disable'],
		operands: '<id>',
		summary: 'Record a no for an installed plugin; it stays installed.',
		flags: [
			{
				flag: '--scope <user|project|local>',
				description: 'The record to act on and the file it is written to.',
			},
			{ flag: '--cwd <dir>', description: 'The folder whose project plugins are meant.' },
			{ flag: '--json', description: 'Print one JSON object on standard output.' },
		],
		example: 'namzu plugin disable ledger@team-tools',
	},
	{
		path: ['install'],
		operands: '<name@marketplace | folder | file.zip>',
		summary:
			'Install a plugin after showing everything in it that runs; nothing is installed without a yes.',
		flags: [
			{
				flag: '--scope <user|project|local>',
				description: 'Where the install applies (default user).',
			},
			{ flag: '--dry-run', description: 'Show what would run and install nothing.' },
			{ flag: '--yes', description: 'Accept what is shown (it is printed on standard error).' },
			{
				flag: '--accept-surface <sha256>',
				description: 'Accept only the surface whose digest was shown.',
			},
			{ flag: '--enable-loading', description: 'Also turn plugin loading on.' },
			{ flag: '--cwd <dir>', description: 'The folder whose project plugins are meant.' },
			{ flag: '--json', description: 'Print one JSON object on standard output.' },
		],
		example: 'namzu plugin install ./my-plugin --dry-run',
	},
	{
		path: ['update'],
		operands: '<id>',
		summary: 'Read an installed plugin again from its source and show what changed in what runs.',
		flags: [
			{ flag: '--dry-run', description: 'Show the changes and update nothing.' },
			{ flag: '--yes', description: 'Accept what is shown.' },
			{
				flag: '--accept-surface <sha256>',
				description: 'Accept only the surface whose digest was shown.',
			},
			{ flag: '--cwd <dir>', description: 'The folder whose project plugins are meant.' },
			{ flag: '--json', description: 'Print one JSON object on standard output.' },
		],
		example: 'namzu plugin update ledger@team-tools',
	},
	{
		path: ['uninstall'],
		operands: '<id>',
		summary: 'Remove an installed plugin; its data is kept unless --delete-data.',
		flags: [
			{
				flag: '--scope <user|project|local>',
				description: 'The scope to remove when it is installed at several.',
			},
			{ flag: '--delete-data', description: 'Also delete the plugin’s data.' },
			{ flag: '--yes', description: 'Edit a shared project file without asking.' },
			{ flag: '--cwd <dir>', description: 'The folder whose project plugins are meant.' },
			{ flag: '--json', description: 'Print one JSON object on standard output.' },
		],
		example: 'namzu plugin uninstall ledger@team-tools',
	},
	{
		path: ['prune'],
		summary: 'Remove plugin copies no install record names, and leftovers of unfinished installs.',
		flags: [
			{ flag: '--dry-run', description: 'List what would be removed and remove nothing.' },
			{ flag: '--yes', description: 'Remove without asking.' },
			{ flag: '--json', description: 'Print one JSON object on standard output.' },
		],
		example: 'namzu plugin prune --dry-run',
	},
	{
		path: ['marketplace', 'add'],
		operands: '<folder | file.json>',
		summary: 'Add a marketplace that is a folder or a .json file on this computer, in place.',
		flags: [
			{
				flag: '--scope <user|project|local>',
				description: 'The settings file that declares it (default user).',
			},
			{ flag: '--dry-run', description: 'Say what would be added and add nothing.' },
			{ flag: '--cwd <dir>', description: 'The folder whose project plugins are meant.' },
			{ flag: '--json', description: 'Print one JSON object on standard output.' },
		],
		example: 'namzu plugin marketplace add ./team-tools',
	},
	{
		path: ['marketplace', 'list'],
		summary: 'List the marketplaces that are added, and the ones this folder declares.',
		flags: [{ flag: '--json', description: 'Print one JSON object on standard output.' }],
		example: 'namzu plugin marketplace list',
	},
	{
		path: ['marketplace', 'remove'],
		operands: '<name>',
		summary: 'Remove a marketplace and uninstall its plugins; their data is kept.',
		flags: [
			{ flag: '--yes', description: 'Remove without asking.' },
			{ flag: '--json', description: 'Print one JSON object on standard output.' },
		],
		example: 'namzu plugin marketplace remove team-tools',
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
