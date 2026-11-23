/**
 * `namzu schedule <verb>`: scheduled jobs that run while namzu is closed.
 * Each verb lives in `../schedule/commands/`. See docs/cli/scheduled-tasks.md
 * and docs/cli/scheduler-service.md.
 */

import { EXIT_USAGE } from '../exit-codes.js'
import { applyTarget } from '../schedule/service/target.js'
import { withTerminationHandling } from '../termination.js'
import { SCHEDULE_ACTIONS } from './actions/schedule.js'
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
	'  Every job command takes --service <name> to act on that service’s home,',
	'  e.g. namzu schedule pause nightly --service autodev',
	'',
	'The scheduler service',
	'  service install [--platform auto|systemd-user|launchd|windows-task|wsl-windows-task]',
	'          [--name <service>] [--at-boot] [--dry-run]',
	'  service list [--json]         Installed services: name, home, platform, state',
	'  service uninstall [<name>] [--keep-data | --purge-data] [--wait 10m | --interrupt-runs]',
	'  service status [<name>] [--json]   Exit 0 healthy, 69 not running, 2 not installed',
	'  service start [<name>] | service stop [<name>]   Through the service manager',
	'  service logs [<name>] [--follow] [--job <j>] [--since 1h] [--run <id> --job <j>]',
	'  service daemon                Run the scheduler in this process',
	'  A <name> picks a service from `service list` and acts on its home, as if',
	'  NAMZU_HOME were set to it; without one, the current NAMZU_HOME is used.',
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
	actions: SCHEDULE_ACTIONS,
	handler: withTerminationHandling(async ({ ctx, rawArgs }, termination) => {
		const [verb, ...rest] = rawArgs
		const add = () => import('../schedule/commands/add.js')
		const list = () => import('../schedule/commands/list.js')
		const lifecycle = () => import('../schedule/commands/lifecycle.js')
		const service = () => import('../schedule/commands/service.js')
		// A job command's `--service <name>` runs it on that service's home.
		const onService = async (act: (argv: string[]) => Promise<number>) => {
			const targeted = applyTarget(ctx, rest, 'flag', true)
			if ('code' in targeted) return targeted.code
			try {
				return await act(targeted.argv)
			} finally {
				targeted.restore()
			}
		}
		switch (verb) {
			case 'add':
				return onService(async (a) => (await add()).addCommand(ctx, a))
			case 'edit':
				return onService(async (a) => (await add()).editCommand(ctx, a))
			case 'confirm':
				return onService(async (a) => (await add()).confirmCommand(ctx, a))
			case 'list':
			case 'ls':
				return onService(async (a) => (await list()).listCommand(ctx, a))
			case 'show':
				return onService(async (a) => (await list()).showCommand(ctx, a))
			case 'history':
				return onService(async (a) => (await list()).historyCommand(ctx, a))
			case 'pause':
				return onService(async (a) => (await lifecycle()).pauseCommand(ctx, a, false))
			case 'resume':
				return onService(async (a) => (await lifecycle()).pauseCommand(ctx, a, true))
			case 'remove':
			case 'rm':
				return onService(async (a) => (await lifecycle()).removeCommand(ctx, a))
			case 'run':
				return onService(async (a) => (await lifecycle()).runNowCommand(ctx, a))
			case 'prune':
				return onService(async (a) => (await lifecycle()).pruneCommand(ctx, a))
			case 'service':
				switch (rest[0]) {
					case 'list':
						return (await service()).listCommand(ctx, rest.slice(1))
					case 'status':
					case 'start':
					case 'stop':
					case 'logs':
					case 'uninstall': {
						const targeted = applyTarget(ctx, rest.slice(1), 'word', false)
						if ('code' in targeted) return targeted.code
						try {
							switch (rest[0]) {
								case 'status':
									return await (await service()).statusCommand(ctx, targeted.argv)
								case 'start':
								case 'stop':
									return await (await service()).startStopCommand(ctx, targeted.argv, rest[0])
								case 'logs':
									return await (await import('../schedule/commands/logs.js')).logsCommand(
										ctx,
										targeted.argv,
									)
								default:
									return await (await service()).uninstallCommand(
										ctx,
										targeted.argv,
										targeted.target?.name,
									)
							}
						} finally {
							targeted.restore()
						}
					}
					case 'install':
						return (await service()).installCommand(ctx, rest.slice(1))
					case 'daemon':
						termination.dispose()
						return (await service()).daemonCommand(ctx, rest.slice(1))
					default:
						ctx.formatter.error({
							message: rest[0]
								? `unknown schedule service command: ${rest[0]}`
								: 'a schedule service command is required: install, list, uninstall, status, start, stop, logs or daemon',
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
