/**
 * `schedule install | uninstall | start | stop` over the four supervisors,
 * with the manifest as the record of what exists. The service always runs
 * `"<absolute node>" "<absolute CLI>" schedule daemon --home "<NAMZU_HOME>"`,
 * both paths resolved at install: no shell, no PATH lookup, no profile.
 */

import { mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SchedulePaths } from '../paths.js'
import { installLaunchd, launchdLabel, launchdPlistPath, uninstallLaunchd } from './launchd.js'
import {
	type ServiceArtifact,
	type ServiceManifest,
	type ServicePlatform,
	readManifest,
	removeManifest,
	writeManifest,
} from './manifest.js'
import type { CommandRunner } from './runner.js'
import {
	type ServiceProgram,
	installSystemd,
	startSystemd,
	stopSystemd,
	systemdState,
	systemdUnitPath,
	uninstallSystemd,
} from './systemd.js'
import { parseTaskQuery, taskPath, taskXml, taskXmlBytes } from './windows-task.js'
import {
	type WindowsTools,
	isEphemeralBin,
	probeInterop,
	toWindowsPath,
	windowsTools,
	windowsUser,
	wslTaskDefinition,
	wslTaskName,
} from './wsl.js'

export interface ServiceContext {
	readonly paths: SchedulePaths
	readonly run: CommandRunner
	readonly env: NodeJS.ProcessEnv
	readonly version: string
	/** Windows tools under WSL; default the standard `/mnt/c` locations. */
	readonly tools?: WindowsTools
}

export interface InstallRequest {
	readonly platform: ServicePlatform
	readonly name: string
	readonly program: ServiceProgram
	readonly atBoot?: boolean
}

export class ServiceRefusal extends Error {
	override readonly name = 'ServiceRefusal'
}

function refuseUnsafeProgram(program: ServiceProgram): void {
	if (!isAbsolute(program.node) && !/^[A-Za-z]:\\/.test(program.node)) {
		throw new ServiceRefusal(`node must be an absolute path, got ${program.node}`)
	}
	if (isEphemeralBin(program.bin)) {
		throw new ServiceRefusal(
			`namzu is running from the npx cache (${program.bin}), which is not kept; install it (npm i -g @namzu/cli) and run schedule install from that`,
		)
	}
}

async function lingerEnabled(run: CommandRunner, user: string): Promise<boolean> {
	const result = await run('loginctl', ['show-user', user, '-p', 'Linger'])
	return /Linger=yes/.test(result.stdout)
}

export async function installService(
	ctx: ServiceContext,
	request: InstallRequest,
): Promise<{ manifest: ServiceManifest; problems: string[]; notes: string[] }> {
	refuseUnsafeProgram(request.program)
	const { paths, run } = ctx
	const notes: string[] = []
	const base = {
		v: 1 as const,
		kind: 'schedule-service' as const,
		platform: request.platform,
		name: request.name,
		installedAt: new Date().toISOString(),
		cliVersion: ctx.version,
		nodePath: request.program.node,
		binPath: request.program.bin,
		namzuHome: request.program.namzuHome,
	}
	switch (request.platform) {
		case 'systemd-user': {
			const unit = systemdUnitPath(request.name, ctx.env)
			const problems = await installSystemd(request.name, request.program, { run }, unit)
			let enabledLinger = false
			if (request.atBoot) {
				const user = userInfo().username
				if (!(await lingerEnabled(run, user))) {
					const result = await run('loginctl', ['enable-linger', user])
					if (result.code === 0) enabledLinger = true
					else
						problems.push(
							`loginctl enable-linger ${user}: ${result.stderr.trim() || `exit ${result.code}`}`,
						)
				}
			} else {
				notes.push(
					'The daemon starts when you log in; --at-boot keeps it running without a login (linger).',
				)
			}
			const manifest: ServiceManifest = {
				...base,
				enabledLinger,
				artifacts: [
					{ type: 'file', path: unit },
					{ type: 'systemd-unit', name: `${request.name}.service` },
				],
			}
			writeManifest(paths, manifest)
			return { manifest, problems, notes }
		}
		case 'launchd': {
			const label = launchdLabel(request.name)
			const plist = launchdPlistPath(label)
			const { domain, problems } = await installLaunchd(
				label,
				request.program,
				{
					run,
					uid: process.getuid?.() ?? 501,
				},
				plist,
			)
			const manifest: ServiceManifest = {
				...base,
				artifacts: [
					{ type: 'file', path: plist },
					{ type: 'launchd-agent', label, domain },
				],
			}
			writeManifest(paths, manifest)
			notes.push('A LaunchAgent starts at login, not at boot.')
			return { manifest, problems, notes }
		}
		case 'windows-task': {
			const root = ctx.env.SystemRoot ?? 'C:\\Windows'
			const schtasks = `${root}\\System32\\schtasks.exe`
			const who = await run(`${root}\\System32\\whoami.exe`, [])
			const userId = who.stdout.trim()
			if (who.code !== 0 || !userId.includes('\\'))
				throw new ServiceRefusal('could not read the Windows user from whoami.exe')
			const path = taskPath(request.name)
			const xml = taskXml({
				userId,
				description: `namzu scheduler for NAMZU_HOME=${request.program.namzuHome}`,
				command: `${root}\\System32\\conhost.exe`,
				args: [
					'--headless',
					request.program.node,
					request.program.bin,
					'schedule',
					'daemon',
					'--home',
					request.program.namzuHome,
				],
			})
			const file = join(paths.daemon, `${request.name}.task.xml`)
			mkdirSync(paths.daemon, { recursive: true })
			writeFileSync(file, taskXmlBytes(xml))
			const problems: string[] = []
			try {
				const created = await run(schtasks, ['/Create', '/TN', path, '/XML', file, '/F'])
				if (created.code !== 0)
					problems.push(`schtasks /Create: ${created.stderr.trim() || created.stdout.trim()}`)
				else await run(schtasks, ['/Run', '/TN', path])
			} finally {
				rmSync(file, { force: true })
			}
			const manifest: ServiceManifest = {
				...base,
				artifacts: [{ type: 'windows-task', taskPath: path }],
				windows: { taskPath: path, schtasks },
			}
			writeManifest(paths, manifest)
			notes.push('The task starts at logon; jobs run while you are logged on.')
			return { manifest, problems, notes }
		}
		case 'wsl-windows-task': {
			const tools = ctx.tools ?? windowsTools()
			const interop = await probeInterop(run, tools, ctx.env)
			if (!interop.ok)
				throw new ServiceRefusal(
					`WSL interop is not usable: ${interop.reason}. Use --platform systemd-user instead.`,
				)
			const distro = ctx.env.WSL_DISTRO_NAME
			if (!distro)
				throw new ServiceRefusal('WSL_DISTRO_NAME is not set; cannot name the distro for wsl.exe')
			const userId = await windowsUser(run, tools)
			const definition = wslTaskDefinition({
				userId,
				distro,
				linuxUser: userInfo().username,
				node: request.program.node,
				bin: request.program.bin,
				namzuHome: request.program.namzuHome,
			})
			const name = wslTaskName(request.name, distro)
			const path = taskPath(name)
			// The XML goes where Windows can read it without a UNC path.
			const localAppData = (
				await run(tools.cmd, ['/d', '/c', 'echo', '%LOCALAPPDATA%'], { cwd: '/mnt/c' })
			).stdout.trim()
			if (!/^[A-Za-z]:\\/.test(localAppData))
				throw new ServiceRefusal('could not resolve %LOCALAPPDATA% through interop')
			const linuxDir = (await run('wslpath', ['-u', `${localAppData}\\namzu`])).stdout.trim()
			if (!linuxDir.startsWith('/mnt/'))
				throw new ServiceRefusal(`could not map ${localAppData} into WSL`)
			mkdirSync(linuxDir, { recursive: true })
			const linuxFile = join(linuxDir, `${name}.xml`)
			writeFileSync(linuxFile, taskXmlBytes(taskXml(definition)))
			const problems: string[] = []
			try {
				const windowsFile = await toWindowsPath(run, linuxFile)
				const created = await run(
					tools.schtasks,
					['/Create', '/TN', path, '/XML', windowsFile, '/F'],
					{ cwd: '/mnt/c' },
				)
				if (created.code !== 0)
					problems.push(`schtasks.exe /Create: ${created.stderr.trim() || created.stdout.trim()}`)
				else {
					const started = await run(tools.schtasks, ['/Run', '/TN', path], { cwd: '/mnt/c' })
					if (started.code !== 0)
						problems.push(`schtasks.exe /Run: ${started.stderr.trim() || started.stdout.trim()}`)
				}
			} finally {
				rmSync(linuxFile, { force: true })
				// The staging folder, when this install made it and nothing else uses it.
				try {
					rmdirSync(linuxDir)
				} catch {}
			}
			const manifest: ServiceManifest = {
				...base,
				name,
				artifacts: [{ type: 'windows-task', taskPath: path }],
				windows: {
					taskPath: path,
					schtasks: tools.schtasks,
					powershell: tools.powershell,
					distro,
					user: userId,
				},
			}
			writeManifest(paths, manifest)
			notes.push(
				'Windows Task Scheduler starts the daemon in this distro at logon and re-checks it every 5 minutes; jobs run while you are logged on to Windows.',
			)
			return { manifest, problems, notes }
		}
	}
}

async function removeArtifact(
	ctx: ServiceContext,
	manifest: ServiceManifest,
	artifact: ServiceArtifact,
): Promise<string[]> {
	switch (artifact.type) {
		case 'file':
			rmSync(artifact.path, { force: true })
			return []
		case 'systemd-unit': {
			const unitFile = manifest.artifacts.find((a) => a.type === 'file')
			return uninstallSystemd(
				artifact.name.replace(/\.service$/, ''),
				{ run: ctx.run },
				unitFile?.type === 'file' ? unitFile.path : systemdUnitPath(manifest.name, ctx.env),
			)
		}
		case 'launchd-agent':
			return uninstallLaunchd(artifact.label, artifact.domain, {
				run: ctx.run,
				uid: process.getuid?.() ?? 501,
			})
		case 'windows-task': {
			const schtasks = manifest.windows?.schtasks ?? 'schtasks.exe'
			const cwd = manifest.platform === 'wsl-windows-task' ? { cwd: '/mnt/c' } : {}
			await ctx.run(schtasks, ['/End', '/TN', artifact.taskPath], cwd)
			await ctx.run(schtasks, ['/Delete', '/TN', artifact.taskPath, '/F'], cwd)
			const queried = await ctx.run(schtasks, ['/Query', '/TN', artifact.taskPath], cwd)
			return queried.code === 0 ? [`task ${artifact.taskPath} is still registered`] : []
		}
	}
}

/** Remove exactly what the manifest lists, verify, and remove the manifest last. */
export async function uninstallService(
	ctx: ServiceContext,
): Promise<{ problems: string[]; manifest?: ServiceManifest }> {
	const manifest = readManifest(ctx.paths)
	if (!manifest) return { problems: [] }
	const problems: string[] = []
	// The supervisor first, then the files it read.
	const ordered = [...manifest.artifacts].sort(
		(a, b) => (a.type === 'file' ? 1 : 0) - (b.type === 'file' ? 1 : 0),
	)
	for (const artifact of ordered) problems.push(...(await removeArtifact(ctx, manifest, artifact)))
	if (manifest.enabledLinger) {
		const result = await ctx.run('loginctl', ['disable-linger', userInfo().username])
		if (result.code !== 0) problems.push('loginctl disable-linger failed (install had enabled it)')
	}
	if (problems.length === 0) removeManifest(ctx.paths)
	return { problems, manifest }
}

/** Ask the supervisor for its view. */
export async function serviceState(
	ctx: ServiceContext,
	manifest: ServiceManifest,
): Promise<string> {
	switch (manifest.platform) {
		case 'systemd-user':
			return `systemd: ${await systemdState(manifest.name, { run: ctx.run })}`
		case 'launchd': {
			const agent = manifest.artifacts.find((a) => a.type === 'launchd-agent')
			if (agent?.type !== 'launchd-agent') return 'launchd: unknown'
			const printed = await ctx.run('launchctl', ['print', `${agent.domain}/${agent.label}`])
			return printed.code === 0
				? `launchd: loaded (${/state = (\w+)/.exec(printed.stdout)?.[1] ?? 'unknown'})`
				: 'launchd: not loaded'
		}
		case 'windows-task':
		case 'wsl-windows-task': {
			const schtasks = manifest.windows?.schtasks ?? 'schtasks.exe'
			const cwd = manifest.platform === 'wsl-windows-task' ? { cwd: '/mnt/c' } : {}
			const queried = await ctx.run(
				schtasks,
				['/Query', '/TN', manifest.windows?.taskPath ?? '', '/FO', 'LIST', '/V'],
				cwd,
			)
			if (queried.code !== 0) return 'Task Scheduler: task not found'
			const fields = parseTaskQuery(queried.stdout)
			return `Task Scheduler: ${fields.status ?? 'unknown'}${fields.state ? `, ${fields.state.toLowerCase()}` : ''}${fields.lastResult ? `, last result ${fields.lastResult}` : ''}`
		}
	}
}

export async function startService(
	ctx: ServiceContext,
	manifest: ServiceManifest,
): Promise<string[]> {
	switch (manifest.platform) {
		case 'systemd-user':
			return startSystemd(manifest.name, { run: ctx.run })
		case 'launchd': {
			const agent = manifest.artifacts.find((a) => a.type === 'launchd-agent')
			if (agent?.type !== 'launchd-agent') return ['no launchd agent in the manifest']
			const plist = manifest.artifacts.find((a) => a.type === 'file')
			// `stop` disabled it; a disabled label is not loaded at all.
			await ctx.run('launchctl', ['enable', `${agent.domain}/${agent.label}`])
			const booted = await ctx.run('launchctl', [
				'bootstrap',
				agent.domain,
				plist?.type === 'file' ? plist.path : '',
			])
			if (booted.code === 0) return []
			const kicked = await ctx.run('launchctl', ['kickstart', `${agent.domain}/${agent.label}`])
			return kicked.code === 0 ? [] : [kicked.stderr.trim() || 'launchctl kickstart failed']
		}
		case 'windows-task':
		case 'wsl-windows-task': {
			const schtasks = manifest.windows?.schtasks ?? 'schtasks.exe'
			const cwd = manifest.platform === 'wsl-windows-task' ? { cwd: '/mnt/c' } : {}
			const task = manifest.windows?.taskPath ?? ''
			const enabled = await ctx.run(schtasks, ['/Change', '/TN', task, '/ENABLE'], cwd)
			if (enabled.code !== 0) return [enabled.stderr.trim() || 'schtasks /Change /ENABLE failed']
			const ran = await ctx.run(schtasks, ['/Run', '/TN', task], cwd)
			return ran.code === 0 ? [] : [ran.stderr.trim() || 'schtasks /Run failed']
		}
	}
}

/**
 * Stop through the supervisor, and keep it stopped: the systemd unit and the
 * launchd agent are disabled (else the next login starts them), and a
 * Windows task is disabled (ending it alone is undone by its repetition).
 */
export async function stopService(
	ctx: ServiceContext,
	manifest: ServiceManifest,
): Promise<string[]> {
	switch (manifest.platform) {
		case 'systemd-user':
			return stopSystemd(manifest.name, { run: ctx.run })
		case 'launchd': {
			const agent = manifest.artifacts.find((a) => a.type === 'launchd-agent')
			if (agent?.type !== 'launchd-agent') return ['no launchd agent in the manifest']
			// Disabled as well as booted out: the plist stays in LaunchAgents, and
			// with RunAtLoad and KeepAlive the next login would start the daemon,
			// which would find the stop request, exit and be started again.
			const disabled = await ctx.run('launchctl', ['disable', `${agent.domain}/${agent.label}`])
			const out = await ctx.run('launchctl', ['bootout', `${agent.domain}/${agent.label}`])
			if (disabled.code !== 0) return [disabled.stderr.trim() || 'launchctl disable failed']
			return out.code === 0 ? [] : [out.stderr.trim() || 'launchctl bootout failed']
		}
		case 'windows-task':
		case 'wsl-windows-task': {
			const schtasks = manifest.windows?.schtasks ?? 'schtasks.exe'
			const cwd = manifest.platform === 'wsl-windows-task' ? { cwd: '/mnt/c' } : {}
			const task = manifest.windows?.taskPath ?? ''
			const disabled = await ctx.run(schtasks, ['/Change', '/TN', task, '/DISABLE'], cwd)
			await ctx.run(schtasks, ['/End', '/TN', task], cwd)
			return disabled.code === 0
				? []
				: [disabled.stderr.trim() || 'schtasks /Change /DISABLE failed']
		}
	}
}
