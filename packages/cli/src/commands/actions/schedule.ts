import type { ActionFlag, ActionHelp } from '../action-help.js'

const SERVICE_FLAG: ActionFlag = {
	flag: '--service <name>',
	description: 'Act on that scheduler service’s home instead of the current one.',
}
const JSON_FLAG: ActionFlag = { flag: '--json', description: 'Print JSON instead of text.' }

const JOB_OPTIONS: readonly ActionFlag[] = [
	{ flag: '--when <spec>', description: '"every 30m", a cron line, "at 09:00" or "in 2h".' },
	{
		flag: '--permissions <preset|file.json>',
		description: 'What the job may do: read-only, edit-in-folder or a JSON permission set.',
	},
	{ flag: '--kind <kind>', description: 'agent, script or script+agent (default agent).' },
	{ flag: '--prompt <text>', description: 'What the model is asked each run.' },
	{ flag: '--prompt-file <file>', description: 'Read the prompt from a file.' },
	{ flag: '--script <text>', description: 'A shell script to run.' },
	{ flag: '--script-file <file>', description: 'Read the script from a file.' },
	{ flag: '--shell <bash|sh>', description: 'The shell for the script.' },
	{ flag: '--script-timeout <time>', description: 'Stop the script after this long, e.g. 2m.' },
	{
		flag: '--gate <command>',
		description: 'Run first; wake the model only when it prints something.',
	},
	{ flag: '--gate-file <file>', description: 'Read the gate command from a file.' },
	{ flag: '--gate-shell <bash|sh>', description: 'The shell for the gate.' },
	{ flag: '--gate-timeout <time>', description: 'Stop the gate after this long, e.g. 30s.' },
	{ flag: '--workspace <none|project>', description: 'none runs the job with no project folder.' },
	{ flag: '--effort <level>', description: 'The reasoning effort the job uses.' },
	{ flag: '--script-report <json-v1|none>', description: 'How a pure script job reports back.' },
	{ flag: '--delivery none', description: 'Detach an edited job from its source conversation.' },
	{ flag: '--home <dir>', description: 'Use another namzu data folder.' },
	{ flag: '--folder <dir>', description: 'The folder the job runs in (default: this one).' },
	{ flag: '--unmatched <park|deny|allow>', description: 'What happens to a call no rule covers.' },
	{ flag: '--execution <host|sandbox>', description: 'Where the job runs.' },
	{ flag: '--tz <zone>', description: 'The time zone for cron lines and clock times.' },
	{ flag: '--model <provider>/<model>', description: 'The model the job uses.' },
	{ flag: '--token-budget <n>', description: 'Stop a run after this many tokens.' },
	{ flag: '--max-iterations <n>', description: 'Stop a run after this many rounds.' },
	{ flag: '--timeout <time>', description: 'Stop a run after this long, e.g. 30m.' },
	{
		flag: '--wait-for-provider <time>',
		description: 'How long to wait for the provider to answer.',
	},
	{ flag: '--approval-ttl <time>', description: 'How long a parked call waits for you, e.g. 7d.' },
	{ flag: '--keep-sessions <n>', description: 'How many run conversations to keep.' },
	{
		flag: '--pause-after-failures <n>',
		description: 'Pause the job after this many failures in a row.',
	},
	{ flag: '--add-dir <dir>', description: 'Another folder the job may use; repeat for more.' },
	{ flag: '--notify-summary', description: 'Put a summary in the notification.' },
	{ flag: '--notify-finished <true|false>', description: 'Notify when a run finishes.' },
	{ flag: '--paused', description: 'Create the job paused.' },
	{
		flag: '--yes',
		description: 'Without a terminal, create it unconfirmed until someone confirms.',
	},
	{ flag: '--allow-unattended-host', description: 'Allow a host run with no one present.' },
	{ flag: '--browser <profile>', description: 'A browser profile the run may drive.' },
	{
		flag: '--browser-site <site>=<read|ask|act>',
		description: 'What the run may do on a site; repeat.',
	},
	{ flag: '--browser-headed', description: 'Show the browser window.' },
]

export const SCHEDULE_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['add'],
		operands: '<name>',
		summary: 'Create a scheduled job that runs in a folder while namzu is closed.',
		flags: [...JOB_OPTIONS, SERVICE_FLAG],
		example:
			'namzu schedule add nightly --when "every 1d" --permissions read-only --prompt "Summarise today’s changes"',
	},
	{
		path: ['edit'],
		operands: '<job>',
		summary: 'Change a job; it is confirmed again.',
		flags: [
			...JOB_OPTIONS,
			{ flag: '--no-browser', description: 'Take the whole browser grant off.' },
			{ flag: '--no-gate', description: 'Drop the gate.' },
			SERVICE_FLAG,
		],
		example: 'namzu schedule edit nightly --when "every 12h"',
	},
	{
		path: ['confirm'],
		operands: '<job>',
		summary: 'Confirm a job on this terminal so it can run.',
		flags: [{ flag: '--paused', description: 'Confirm it but leave it paused.' }, SERVICE_FLAG],
		example: 'namzu schedule confirm nightly',
	},
	{
		path: ['list'],
		summary: 'List jobs with their next run and last result.',
		flags: [JSON_FLAG, SERVICE_FLAG],
		example: 'namzu schedule list --json',
	},
	{
		path: ['show'],
		operands: '<job>',
		summary: 'Show one job in full, with its recent history.',
		flags: [JSON_FLAG, SERVICE_FLAG],
		example: 'namzu schedule show nightly',
	},
	{
		path: ['history'],
		operands: '<job>',
		summary: 'Show the runs of a job.',
		flags: [
			{ flag: '--limit <n>', description: 'How many runs to show (default 20).' },
			JSON_FLAG,
			SERVICE_FLAG,
		],
		example: 'namzu schedule history nightly --limit 5',
	},
	{
		path: ['pause'],
		operands: '<job>',
		summary: 'Pause a job; paused occurrences are skipped, not caught up.',
		flags: [SERVICE_FLAG],
		example: 'namzu schedule pause nightly',
	},
	{
		path: ['resume'],
		operands: '<job>',
		summary: 'Resume a paused job.',
		flags: [SERVICE_FLAG],
		example: 'namzu schedule resume nightly',
	},
	{
		path: ['remove'],
		operands: '<job>',
		summary: 'Remove a job.',
		flags: [
			{ flag: '--yes', description: 'Do not ask first.' },
			{ flag: '--force', description: 'Remove it even while a run is going.' },
			SERVICE_FLAG,
		],
		example: 'namzu schedule remove nightly --yes',
	},
	{
		path: ['run'],
		operands: '<job>',
		summary: 'Run a job once now; its schedule is untouched.',
		flags: [SERVICE_FLAG],
		example: 'namzu schedule run nightly',
	},
	{
		path: ['prune'],
		summary: 'List, or delete, old run records.',
		flags: [
			{ flag: '--job <name>', description: 'Only this job’s runs.' },
			{ flag: '--older-than <age>', description: 'Only runs older than this, e.g. 30d.' },
			{ flag: '--delete', description: 'Delete them instead of listing.' },
			{ flag: '--yes', description: 'Do not ask first.' },
			SERVICE_FLAG,
		],
		example: 'namzu schedule prune --older-than 30d --delete --yes',
	},
	{
		path: ['service', 'install'],
		operands: '[name]',
		summary:
			'Install the scheduler service so jobs run while namzu is closed. A name keeps its home in the Namzu folder (services/<name>).',
		flags: [
			{
				flag: '--platform <name>',
				description: 'auto, systemd-user, launchd, windows-task or wsl-windows-task.',
			},
			{ flag: '--home <dir>', description: 'Serve this folder instead of the one the name gives.' },
			{ flag: '--at-boot', description: 'Start it at boot, not only at sign-in.' },
			{ flag: '--dry-run', description: 'Print what would be installed and install nothing.' },
		],
		example: 'namzu schedule service install autodev --dry-run',
	},
	{
		path: ['service', 'move'],
		operands: '<name>',
		summary: 'Bring an installed service’s home into the Namzu folder (services/<name>).',
		flags: [
			{ flag: '--dry-run', description: 'Print what would move and change nothing.' },
			{ flag: '--wait <time>', description: 'Wait this long for running jobs, e.g. 10m.' },
		],
		example: 'namzu schedule service move autodev --dry-run',
	},
	{
		path: ['service', 'list'],
		summary: 'List installed scheduler services: name, home, platform and state.',
		flags: [JSON_FLAG],
		example: 'namzu schedule service list',
	},
	{
		path: ['service', 'uninstall'],
		operands: '[name]',
		summary: 'Uninstall a scheduler service.',
		flags: [
			{ flag: '--keep-data', description: 'Keep the jobs and history (the default).' },
			{ flag: '--purge-data', description: 'Delete the jobs and history too.' },
			{ flag: '--wait <time>', description: 'Wait this long for running jobs, e.g. 10m.' },
			{ flag: '--interrupt-runs', description: 'Stop running jobs instead of waiting.' },
		],
		example: 'namzu schedule service uninstall --keep-data',
	},
	{
		path: ['service', 'status'],
		operands: '[name]',
		summary: 'Say whether the service is healthy. Exit 0 healthy, 69 not running, 2 not installed.',
		flags: [JSON_FLAG],
		example: 'namzu schedule service status --json',
	},
	{
		path: ['service', 'start'],
		operands: '[name]',
		summary: 'Start the service through the service manager.',
		example: 'namzu schedule service start',
	},
	{
		path: ['service', 'stop'],
		operands: '[name]',
		summary: 'Stop the service through the service manager.',
		example: 'namzu schedule service stop',
	},
	{
		path: ['service', 'logs'],
		operands: '[name]',
		summary: 'Show the service log, or the log of one run.',
		flags: [
			{ flag: '--follow', description: 'Keep printing new lines.' },
			{ flag: '--job <name>', description: 'Only this job’s lines.' },
			{ flag: '--since <age>', description: 'Only lines newer than this, e.g. 1h.' },
			{ flag: '--run <id>', description: 'One run’s log; needs --job.' },
		],
		example: 'namzu schedule service logs --since 1h',
	},
	{
		path: ['service', 'daemon'],
		summary: 'Run the scheduler in this process until it is stopped.',
		flags: [
			{ flag: '--foreground', description: 'Stay in the foreground.' },
			{ flag: '--once-or-exit', description: 'Run what is due, then exit.' },
		],
		example: 'namzu schedule service daemon',
	},
]
