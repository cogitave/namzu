/**
 * Linux: a systemd user unit.
 *
 * `Restart=always` with no start limit: a second daemon waits on standby
 * instead of exiting, and a daemon that exits 0 after an upgrade is started
 * again on the new code. The one exit that must not restart is a daemon
 * finding `schedule stop`'s request: it exits `EXIT_STOP_REQUESTED`, which
 * `RestartPreventExitStatus=` names (and `SuccessExitStatus=`, so the unit
 * is inactive rather than failed). `schedule stop` also DISABLES the unit,
 * and `start` enables it again, so a stopped scheduler is not started at the
 * next login.
 * `KillMode=process`: stopping or restarting the daemon leaves runs in
 * progress alone; they finish, record their result and the next daemon
 * adopts them.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { EXIT_STOP_REQUESTED } from '../daemon/exit.js'
import { systemdAssignment, systemdWord } from './quote.js'
import type { CommandRunner } from './runner.js'

export interface ServiceProgram {
	readonly node: string
	readonly bin: string
	readonly namzuHome: string
}

export function systemdUnitPath(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): string {
	const config = env.XDG_CONFIG_HOME || join(home, '.config')
	return join(config, 'systemd', 'user', `${name}.service`)
}

export function systemdUnit(program: ServiceProgram): string {
	return [
		'[Unit]',
		`Description=namzu scheduler (NAMZU_HOME=${program.namzuHome.replaceAll('%', '%%')})`,
		'Documentation=https://github.com/cogitave/namzu/blob/main/docs/cli/scheduler-service.md',
		'StartLimitIntervalSec=0',
		'',
		'[Service]',
		'Type=simple',
		`ExecStart=${[program.node, program.bin, 'schedule', 'daemon', '--home', program.namzuHome].map(systemdWord).join(' ')}`,
		`Environment=${systemdAssignment('NAMZU_HOME', program.namzuHome)}`,
		'Restart=always',
		'RestartSec=10',
		`SuccessExitStatus=${EXIT_STOP_REQUESTED}`,
		`RestartPreventExitStatus=${EXIT_STOP_REQUESTED}`,
		'KillMode=process',
		'TimeoutStopSec=20',
		'',
		'[Install]',
		'WantedBy=default.target',
		'',
	].join('\n')
}

export interface SystemdSteps {
	readonly run: CommandRunner
	readonly systemctl?: string
}

async function systemctl(steps: SystemdSteps, ...args: string[]) {
	return steps.run(steps.systemctl ?? 'systemctl', ['--user', ...args])
}

export async function installSystemd(
	name: string,
	program: ServiceProgram,
	steps: SystemdSteps,
	unitPath = systemdUnitPath(name),
): Promise<string[]> {
	mkdirSync(dirname(unitPath), { recursive: true })
	writeFileSync(unitPath, systemdUnit(program), { mode: 0o644 })
	const problems: string[] = []
	for (const args of [['daemon-reload'], ['enable', '--now', `${name}.service`]]) {
		const result = await systemctl(steps, ...args)
		if (result.code !== 0)
			problems.push(
				`systemctl --user ${args.join(' ')}: ${result.stderr.trim() || `exit ${result.code}`}`,
			)
	}
	return problems
}

export async function uninstallSystemd(
	name: string,
	steps: SystemdSteps,
	unitPath = systemdUnitPath(name),
): Promise<string[]> {
	const problems: string[] = []
	await systemctl(steps, 'disable', '--now', `${name}.service`)
	rmSync(unitPath, { force: true })
	await systemctl(steps, 'daemon-reload')
	await systemctl(steps, 'reset-failed', `${name}.service`)
	if (existsSync(unitPath)) problems.push(`${unitPath} is still there`)
	const shown = await systemctl(steps, 'show', `${name}.service`, '--property=LoadState')
	if (shown.code === 0 && /LoadState=loaded/.test(shown.stdout))
		problems.push(`${name}.service is still loaded`)
	return problems
}

export async function systemdState(name: string, steps: SystemdSteps): Promise<string> {
	const result = await systemctl(steps, 'is-active', `${name}.service`)
	return result.stdout.trim() || result.stderr.trim() || 'unknown'
}

/** Enable and start: `stop` disabled it. */
export async function startSystemd(name: string, steps: SystemdSteps): Promise<string[]> {
	const result = await systemctl(steps, 'enable', '--now', `${name}.service`)
	return result.code === 0 ? [] : [result.stderr.trim() || `exit ${result.code}`]
}

/** Disable and stop, so the next login does not start it again. */
export async function stopSystemd(name: string, steps: SystemdSteps): Promise<string[]> {
	const result = await systemctl(steps, 'disable', '--now', `${name}.service`)
	return result.code === 0 ? [] : [result.stderr.trim() || `exit ${result.code}`]
}

/** Whether a systemd user manager answers here. */
export async function systemdUserAvailable(steps: SystemdSteps): Promise<boolean> {
	if (!existsSync('/run/systemd/system')) return false
	const result = await systemctl(steps, 'show-environment')
	return result.code === 0
}
