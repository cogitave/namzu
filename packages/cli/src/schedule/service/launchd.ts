/**
 * macOS: a LaunchAgent. `KeepAlive=true` so the daemon comes back after any
 * exit (an upgrade's planned exit 0 included), `AbandonProcessGroup` so runs
 * in progress outlive a daemon restart, `LimitLoadToSessionType=Aqua` so the
 * agent lives in the graphical session that can show notifications.
 * A LaunchAgent starts at login, not at boot. Tested here by its generated
 * file only; see the manual check list in docs/cli/scheduler-service.md.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { xmlText } from './quote.js'
import type { CommandRunner } from './runner.js'
import type { ServiceProgram } from './systemd.js'

export function launchdLabel(name: string): string {
	return name === 'namzu-scheduler'
		? 'com.namzu.scheduler'
		: `com.namzu.${name.replace(/^namzu-/, '')}`
}

export function launchdPlistPath(label: string, home = homedir()): string {
	return join(home, 'Library', 'LaunchAgents', `${label}.plist`)
}

export function launchdPlist(label: string, program: ServiceProgram): string {
	const args = [program.node, program.bin, 'schedule', 'daemon', '--home', program.namzuHome]
	const log = join(program.namzuHome, 'schedule', 'daemon')
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		'<dict>',
		'\t<key>Label</key>',
		`\t<string>${xmlText(label)}</string>`,
		'\t<key>ProgramArguments</key>',
		'\t<array>',
		...args.map((a) => `\t\t<string>${xmlText(a)}</string>`),
		'\t</array>',
		'\t<key>EnvironmentVariables</key>',
		'\t<dict>',
		'\t\t<key>NAMZU_HOME</key>',
		`\t\t<string>${xmlText(program.namzuHome)}</string>`,
		'\t</dict>',
		'\t<key>RunAtLoad</key>',
		'\t<true/>',
		'\t<key>KeepAlive</key>',
		'\t<true/>',
		'\t<key>ThrottleInterval</key>',
		'\t<integer>10</integer>',
		'\t<key>ProcessType</key>',
		'\t<string>Background</string>',
		'\t<key>AbandonProcessGroup</key>',
		'\t<true/>',
		'\t<key>LimitLoadToSessionType</key>',
		'\t<string>Aqua</string>',
		'\t<key>StandardOutPath</key>',
		`\t<string>${xmlText(join(log, 'launchd.out.log'))}</string>`,
		'\t<key>StandardErrorPath</key>',
		`\t<string>${xmlText(join(log, 'launchd.err.log'))}</string>`,
		'</dict>',
		'</plist>',
		'',
	].join('\n')
}

export interface LaunchdSteps {
	readonly run: CommandRunner
	readonly uid: number
}

/** Bootstrap into the GUI domain, falling back to the user domain. Returns the domain used. */
export async function installLaunchd(
	label: string,
	program: ServiceProgram,
	steps: LaunchdSteps,
	plistPath = launchdPlistPath(label),
): Promise<{ domain: string; problems: string[] }> {
	mkdirSync(dirname(plistPath), { recursive: true })
	writeFileSync(plistPath, launchdPlist(label, program), { mode: 0o644 })
	for (const domain of [`gui/${steps.uid}`, `user/${steps.uid}`]) {
		await steps.run('launchctl', ['bootout', `${domain}/${label}`])
		const result = await steps.run('launchctl', ['bootstrap', domain, plistPath])
		if (result.code === 0) return { domain, problems: [] }
	}
	return { domain: `gui/${steps.uid}`, problems: [`launchctl bootstrap failed for ${plistPath}`] }
}

export async function uninstallLaunchd(
	label: string,
	domain: string,
	steps: LaunchdSteps,
	plistPath = launchdPlistPath(label),
): Promise<string[]> {
	await steps.run('launchctl', ['bootout', `${domain}/${label}`])
	rmSync(plistPath, { force: true })
	const problems: string[] = []
	if (existsSync(plistPath)) problems.push(`${plistPath} is still there`)
	const printed = await steps.run('launchctl', ['print', `${domain}/${label}`])
	if (printed.code === 0) problems.push(`${label} is still loaded in ${domain}`)
	return problems
}
