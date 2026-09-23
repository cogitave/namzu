/**
 * `namzu schedule <verb>`: scheduled jobs that run while namzu is closed.
 * Each verb lives in `../schedule/commands/`. See docs/cli/scheduled-tasks.md
 * and docs/cli/scheduler-service.md.
 */

import { EXIT_USAGE } from '../exit-codes.js'
import { withTerminationHandling } from '../termination.js'
import type { CommandDef } from './types.js'

export const SCHEDULE_HELP = [
	'Usage: namzu schedule <command> [options]',
	'',
	'Prompts that run later, in a folder, while namzu is closed: after a reboot,',
	'overnight, every hour. Each run is its own conversation you can /resume, a',
	'desktop notification, and a line in the job’s history. A call the job does',
	'not allow waits for you (or is refused); it is never approved on its own.',
	'',
	'Jobs',
	'  add <name> --prompt <text> --when <spec> --permissions <preset|file.json>',
	'      [--folder <dir>] [--unmatched park|deny|allow] [--execution host|sandbox]',
	'      [--tz <zone>] [--model <provider>/<model>] [--token-budget <n>]',
	'      [--max-iterations <n>] [--timeout 30m] [--wait-for-provider 10m]',
	'      [--approval-ttl 7d] [--keep-sessions 20] [--pause-after-failures 5]',
	'      [--add-dir <dir>] [--notify-summary] [--paused] [--yes]',
	'      [--allow-unattended-host]',
	'  edit <job> [same options]     Change a job (it is confirmed again)',
	'  confirm <job> [--paused]      Confirm a job on this terminal',
	'  list [--json]                 Jobs, next run, last result',
	'  show <job> [--json]           One job in full, with its recent history',
	'  history <job> [--limit 20] [--json]',
	'  pause <job> | resume <job>    Paused occurrences are skipped, not caught up',
	'  remove <job> [--yes] [--force]',
	'  run-now <job>                 Run once now',
	'  prune [--job <j>] [--older-than 30d] [--delete] [--yes]',
	'',
	'The scheduler service',
	'  install [--platform auto|systemd-user|launchd|windows-task|wsl-windows-task]',
	'          [--name <service>] [--at-boot] [--dry-run]',
	'  uninstall [--keep-data | --purge-data] [--wait 10m | --interrupt-runs]',
	'  status [--json]               Exit 0 healthy, 69 not running, 2 not installed',
	'  start | stop                  Through the service manager',
	'  logs [--follow] [--job <j>] [--since 1h] [--run <id> --job <j>]',
	'  daemon                        Run the scheduler in this process',
	'',
	'--when takes "every 30m", "0 9 * * 1-5" (cron, in --tz), "at 2026-09-24 09:00",',
	'"at 09:00" or "in 2h". Presets: read-only (read, glob, grep, ls; everything',
	'else denied) and edit-in-folder (also edit and write; bash waits for you).',
	'Neither reaches the network. Allows come only from the job; a deny in any',
	'config file still holds.',
	'',
	'A job is confirmed by a person, on a terminal or in the TUI (/schedule).',
	'Without a terminal, --yes creates it inert until someone confirms it.',
	'',
	'Exit codes: 0 done, 1 failed, 2 not installed, 64 wrong arguments,',
	'69 the scheduler is not running, 75 another scheduler owns this home.',
].join('\n')

export const scheduleCommand: CommandDef = {
	name: 'schedule',
	description: 'Scheduled jobs that run while namzu is closed, and the service that runs them',
	passThrough: true,
	help: SCHEDULE_HELP,
	handler: withTerminationHandling(async ({ ctx, rawArgs }, termination) => {
		const [verb, ...rest] = rawArgs
		const add = () => import('../schedule/commands/add.js')
		const list = () => import('../schedule/commands/list.js')
		const lifecycle = () => import('../schedule/commands/lifecycle.js')
		const service = () => import('../schedule/commands/service.js')
		switch (verb) {
			case 'add':
				return (await add()).addCommand(ctx, rest)
			case 'edit':
				return (await add()).editCommand(ctx, rest)
			case 'confirm':
				return (await add()).confirmCommand(ctx, rest)
			case 'list':
			case 'ls':
				return (await list()).listCommand(ctx, rest)
			case 'show':
				return (await list()).showCommand(ctx, rest)
			case 'history':
				return (await list()).historyCommand(ctx, rest)
			case 'pause':
				return (await lifecycle()).pauseCommand(ctx, rest, false)
			case 'resume':
				return (await lifecycle()).pauseCommand(ctx, rest, true)
			case 'remove':
			case 'rm':
				return (await lifecycle()).removeCommand(ctx, rest)
			case 'run-now':
				return (await lifecycle()).runNowCommand(ctx, rest)
			case 'prune':
				return (await lifecycle()).pruneCommand(ctx, rest)
			case 'install':
				return (await service()).installCommand(ctx, rest)
			case 'uninstall':
				return (await service()).uninstallCommand(ctx, rest)
			case 'status':
				return (await service()).statusCommand(ctx, rest)
			case 'start':
				return (await service()).startStopCommand(ctx, rest, 'start')
			case 'stop':
				return (await service()).startStopCommand(ctx, rest, 'stop')
			case 'logs':
				return (await import('../schedule/commands/logs.js')).logsCommand(ctx, rest)
			case 'daemon':
				termination.dispose()
				return (await service()).daemonCommand(ctx, rest)
			case '__fire':
				return (await service()).fireCommand(ctx, rest, termination)
			default:
				ctx.formatter.error({
					message: verb ? `unknown schedule command: ${verb}` : 'a schedule command is required',
				})
				ctx.formatter.print({ text: SCHEDULE_HELP })
				return EXIT_USAGE
		}
	}),
}
