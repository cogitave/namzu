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
	'Jobs that run later in a folder while namzu is closed: a model prompt, a',
	'fixed script, or a script that decides whether to wake the model. Model',
	'runs open conversations you can /resume; pure scripts use no model.',
	'Every run is recorded in the job’s history and may send a notification.',
	'',
	'Jobs',
	'  add <name> --when <spec> --permissions <preset|file.json>',
	'      [--kind agent|script|script+agent] --prompt <text>|--prompt-file <file>',
	'      [--script <text>|--script-file <file> --shell bash|sh [--script-timeout 2m]]',
	'      [--gate <command>|--gate-file <file> [--gate-shell bash|sh] [--gate-timeout 30s]]',
	'      [--folder <dir>] [--unmatched park|deny|allow] [--execution host|sandbox]',
	'      [--tz <zone>] [--model <provider>/<model>] [--token-budget <n>]',
	'      [--max-iterations <n>] [--timeout 30m] [--wait-for-provider 10m]',
	'      [--approval-ttl 7d] [--keep-sessions 20] [--pause-after-failures 5]',
	'      [--add-dir <dir>] [--notify-summary] [--notify-finished true|false]',
	'      [--paused] [--yes]',
	'      [--allow-unattended-host]',
	'      [--browser <profile> --browser-site <site>=read|ask|act … [--browser-headed]]',
	'  edit <job> [same options]     Change a job (it is confirmed again);',
	'      --browser-site <site>=none takes a site off, --no-browser the whole grant,',
	'      --no-gate drops the gate',
	'  confirm <job> [--paused]      Confirm a job on this terminal',
	'  list [--json]                 Jobs, next run, last result',
	'  show <job> [--json]           One job in full, with its recent history',
	'  history <job> [--limit 20] [--json]',
	'  pause <job> | resume <job>    Paused occurrences are skipped, not caught up',
	'  remove <job> [--yes] [--force]',
	'  run <job>                     Run once now; the schedule is untouched',
	'  prune [--job <j>] [--older-than 30d] [--delete] [--yes]',
	'',
	'The scheduler service',
	'  service install [--platform auto|systemd-user|launchd|windows-task|wsl-windows-task]',
	'          [--name <service>] [--at-boot] [--dry-run]',
	'  service uninstall [--keep-data | --purge-data] [--wait 10m | --interrupt-runs]',
	'  service status [--json]       Exit 0 healthy, 69 not running, 2 not installed',
	'  service start | stop          Through the service manager',
	'  service logs [--follow] [--job <j>] [--since 1h] [--run <id> --job <j>]',
	'  service daemon                Run the scheduler in this process',
	'',
	'--when takes "every 30m", "0 9 * * 1-5" (cron, in --tz), "at 2026-09-24 09:00",',
	'"at 09:00" or "in 2h". Presets: read-only (read, glob, grep, ls; everything',
	'else denied, including bash) and edit-in-folder (also edit and write; bash',
	'waits for you). For pure scripts, use a JSON permission set with empty',
	'rules and unmatched deny; read-only refuses every script command.',
	'Neither reaches the network. Allows come only from the job; a deny in any',
	'config file still holds.',
	'',
	'--gate is a command that runs first: the model is called only when it exits',
	'0 and prints something; otherwise the run is skipped and costs nothing.',
	'',
	'--browser lets a run drive the browser profile you signed in with',
	'`namzu browser login <profile> <url>`, on the listed sites only: read opens',
	'and reads, act also clicks and types, ask waits for you before each change',
	'(needs --unmatched park). Every other site is denied. A page that needs you',
	'(a sign-in, a CAPTCHA) stops the run and notifies you. No window unless',
	'--browser-headed.',
	'',
	'A job is confirmed by a person, on a terminal or in the TUI (/schedule).',
	'Without a terminal, --yes creates it inert until someone confirms it.',
	'',
	'Exit codes: 0 done, 1 failed, 2 not installed, 64 wrong arguments,',
	'69 the scheduler is not running, 75 another scheduler owns this home.',
].join('\n')

/** Old spellings that no longer run; each names the one new spelling. */
const RENAMED: Readonly<Record<string, string>> = {
	'run-now': 'namzu schedule run <job>',
	install: 'namzu schedule service install',
	uninstall: 'namzu schedule service uninstall',
	status: 'namzu schedule service status',
	start: 'namzu schedule service start',
	stop: 'namzu schedule service stop',
	logs: 'namzu schedule service logs',
}

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
			case 'run':
				return (await lifecycle()).runNowCommand(ctx, rest)
			case 'prune':
				return (await lifecycle()).pruneCommand(ctx, rest)
			case 'service':
				switch (rest[0]) {
					case 'install':
						return (await service()).installCommand(ctx, rest.slice(1))
					case 'uninstall':
						return (await service()).uninstallCommand(ctx, rest.slice(1))
					case 'status':
						return (await service()).statusCommand(ctx, rest.slice(1))
					case 'start':
						return (await service()).startStopCommand(ctx, rest.slice(1), 'start')
					case 'stop':
						return (await service()).startStopCommand(ctx, rest.slice(1), 'stop')
					case 'logs':
						return (await import('../schedule/commands/logs.js')).logsCommand(ctx, rest.slice(1))
					case 'daemon':
						termination.dispose()
						return (await service()).daemonCommand(ctx, rest.slice(1))
					default:
						ctx.formatter.error({
							message: rest[0]
								? `unknown schedule service command: ${rest[0]}`
								: 'a schedule service command is required: install, uninstall, status, start, stop, logs or daemon',
						})
						return EXIT_USAGE
				}
			// The one old spelling that still runs: a service installed before the
			// keyword grammar starts `schedule daemon`, and must keep working until
			// it is reinstalled.
			case 'daemon':
				termination.dispose()
				return (await service()).daemonCommand(ctx, rest)
			case '__fire':
				return (await service()).fireCommand(ctx, rest, termination)
			default: {
				const renamed = verb ? RENAMED[verb] : undefined
				if (renamed) {
					ctx.formatter.error({ message: `This command is now \`${renamed}\`.` })
					return EXIT_USAGE
				}
				ctx.formatter.error({
					message: verb ? `unknown schedule command: ${verb}` : 'a schedule command is required',
				})
				ctx.formatter.print({ text: SCHEDULE_HELP })
				return EXIT_USAGE
			}
		}
	}),
}
