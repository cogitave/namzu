/**
 * The files each supervisor is given, byte for byte where it matters, and
 * install/uninstall against a recording command runner.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectPlatform } from '../service/detect.js'
import {
	installService,
	serviceState,
	startService,
	stopService,
	uninstallService,
} from '../service/index.js'
import { launchdLabel, launchdPlist } from '../service/launchd.js'
import { readManifest } from '../service/manifest.js'
import { defaultServiceName } from '../service/names.js'
import { checkWslPath, systemdWord, windowsArgument } from '../service/quote.js'
import type { CommandRunner } from '../service/runner.js'
import { systemdUnit } from '../service/systemd.js'
import {
	REMOVE_EMPTY_TASK_FOLDER_SCRIPT,
	describeTaskResult,
	parseTaskQuery,
	taskXml,
	taskXmlBytes,
} from '../service/windows-task.js'
import { isEphemeralBin, wslTaskDefinition } from '../service/wsl.js'
import { type Sandbox, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => sb.cleanup())

const program = {
	node: '/opt/node 22/bin/node',
	bin: '/usr/lib/node_modules/@namzu/cli/dist/bin.js',
	namzuHome: '/home/a/100%/.namzu',
}

describe('systemd', () => {
	it('quotes spaces and doubles % and $', () => {
		expect(systemdWord('/a b/%x/$y')).toBe('"/a b/%%x/$$y"')
		const unit = systemdUnit(program)
		expect(unit).toContain(
			'ExecStart="/opt/node 22/bin/node" "/usr/lib/node_modules/@namzu/cli/dist/bin.js" "schedule" "daemon" "--home" "/home/a/100%%/.namzu"',
		)
		expect(unit).toContain('Restart=always')
		expect(unit).toContain('StartLimitIntervalSec=0')
		expect(unit).toContain('KillMode=process')
		expect(unit).toContain('Environment="NAMZU_HOME=/home/a/100%%/.namzu"')
		// A daemon that finds the stop request exits 80 once, not every ten seconds.
		expect(unit).toContain('RestartPreventExitStatus=80')
		expect(unit).toContain('SuccessExitStatus=80')
	})

	it('installs, then uninstalls exactly what the manifest lists', async () => {
		const calls: string[] = []
		const run: CommandRunner = async (cmd, args) => {
			calls.push([cmd, ...args].join(' '))
			return { code: 0, stdout: args.includes('show') ? 'LoadState=not-found' : '', stderr: '' }
		}
		const env = { XDG_CONFIG_HOME: join(sb.root, 'config') }
		const ctx = { paths: sb.paths, run, env, version: 'test' }
		const { manifest, problems } = await installService(ctx, {
			platform: 'systemd-user',
			name: 'namzu-test-unit',
			program: { node: process.execPath, bin: '/x/bin.js', namzuHome: sb.home },
		})
		expect(problems).toEqual([])
		const unitPath = join(sb.root, 'config', 'systemd', 'user', 'namzu-test-unit.service')
		expect(existsSync(unitPath)).toBe(true)
		expect(calls).toContain('systemctl --user enable --now namzu-test-unit.service')
		expect(manifest.artifacts).toEqual([
			{ type: 'file', path: unitPath },
			{ type: 'systemd-unit', name: 'namzu-test-unit.service' },
		])
		const removed = await uninstallService(ctx)
		expect(removed.problems).toEqual([])
		expect(existsSync(unitPath)).toBe(false)
		expect(readManifest(sb.paths)).toBeUndefined()
		expect(calls).toContain('systemctl --user disable --now namzu-test-unit.service')
	})

	it('uninstall names what it could not remove, and keeps the manifest', async () => {
		const run: CommandRunner = async (_cmd, args) => ({
			code: 0,
			stdout: args.includes('show') ? 'LoadState=loaded' : '',
			stderr: '',
		})
		const ctx = {
			paths: sb.paths,
			run,
			env: { XDG_CONFIG_HOME: join(sb.root, 'config') },
			version: 'test',
		}
		await installService(ctx, {
			platform: 'systemd-user',
			name: 'namzu-test-stuck',
			program: { node: process.execPath, bin: '/x/bin.js', namzuHome: sb.home },
		})
		const removed = await uninstallService(ctx)
		expect(removed.problems).toEqual(['namzu-test-stuck.service is still loaded'])
		expect(readManifest(sb.paths)).toBeDefined()
	})

	it('refuses a CLI running from the npx cache', async () => {
		expect(isEphemeralBin('/home/a/.npm/_npx/123/node_modules/@namzu/cli/dist/bin.js')).toBe(true)
		const run: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' })
		await expect(
			installService(
				{ paths: sb.paths, run, env: {}, version: 't' },
				{
					platform: 'systemd-user',
					name: 'x',
					program: { node: process.execPath, bin: '/h/.npm/_npx/1/bin.js', namzuHome: sb.home },
				},
			),
		).rejects.toThrow(/npx cache/)
	})
})

function stopStartManifest(sb: Sandbox, platform: 'systemd-user' | 'launchd') {
	return {
		v: 1 as const,
		kind: 'schedule-service' as const,
		platform,
		name: 'namzu-test',
		installedAt: '',
		cliVersion: 't',
		nodePath: '',
		binPath: '',
		namzuHome: sb.home,
		artifacts:
			platform === 'launchd'
				? [
						{ type: 'file' as const, path: '/Users/a/Library/LaunchAgents/com.namzu.test.plist' },
						{ type: 'launchd-agent' as const, label: 'com.namzu.test', domain: 'gui/501' },
					]
				: [],
	}
}

describe('stop keeps the scheduler stopped across a login', () => {
	for (const platform of ['systemd-user', 'launchd'] as const) {
		it(`${platform}: stop disables, start enables`, async () => {
			const calls: string[] = []
			const run: CommandRunner = async (cmd, args) => {
				calls.push([cmd, ...args].join(' '))
				return { code: 0, stdout: '', stderr: '' }
			}
			const ctx = { paths: sb.paths, run, env: {}, version: 't' }
			const manifest = stopStartManifest(sb, platform)
			expect(await stopService(ctx, manifest)).toEqual([])
			expect(calls).toEqual(
				platform === 'systemd-user'
					? ['systemctl --user disable --now namzu-test.service']
					: [
							'launchctl disable gui/501/com.namzu.test',
							'launchctl bootout gui/501/com.namzu.test',
						],
			)
			calls.length = 0
			expect(await startService(ctx, manifest)).toEqual([])
			expect(calls[0]).toBe(
				platform === 'systemd-user'
					? 'systemctl --user enable --now namzu-test.service'
					: 'launchctl enable gui/501/com.namzu.test',
			)
		})
	}
})

describe('launchd', () => {
	it('keeps the daemon alive, abandons its process group, and lives in the GUI session', () => {
		const plist = launchdPlist(launchdLabel('namzu-scheduler'), {
			...program,
			namzuHome: '/Users/a/<&>',
		})
		expect(plist).toContain('<string>com.namzu.scheduler</string>')
		expect(plist).toContain('<key>KeepAlive</key>\n\t<true/>')
		expect(plist).toContain('<key>AbandonProcessGroup</key>\n\t<true/>')
		expect(plist).toContain('<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>')
		expect(plist).toContain('<key>ThrottleInterval</key>\n\t<integer>10</integer>')
		expect(plist).toContain('<string>/Users/a/&lt;&amp;&gt;</string>')
		expect(launchdLabel('namzu-scheduler-1a2b3c4d')).toBe('com.namzu.scheduler-1a2b3c4d')
	})
})

describe('Windows Task Scheduler', () => {
	const xml = taskXml({
		userId: 'DESKTOP\\arda',
		description: 'namzu scheduler',
		command: 'C:\\Windows\\System32\\conhost.exe',
		args: [
			'--headless',
			'C:\\Program Files\\nodejs\\node.exe',
			'C:\\x\\bin.js',
			'schedule',
			'daemon',
		],
	})

	it('has a logon trigger for the user and a five-minute repetition, IgnoreNew, no time limit', () => {
		expect(xml).toContain('<LogonTrigger>')
		expect(xml).toMatch(
			/<LogonTrigger>[\s\S]*<UserId>DESKTOP\\arda<\/UserId>[\s\S]*<\/LogonTrigger>/,
		)
		expect(xml).toContain('<Interval>PT5M</Interval>')
		expect(xml).toContain('<StopAtDurationEnd>false</StopAtDurationEnd>')
		expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
		expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
		expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
		expect(xml).toContain(
			'<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; C:\\x\\bin.js schedule daemon</Arguments>',
		)
	})

	it('is written as UTF-16LE with a byte-order mark, matching its declaration', () => {
		const bytes = taskXmlBytes(xml)
		expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe])
		expect(bytes.subarray(2).toString('utf16le')).toBe(xml)
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true)
	})

	it('quotes Windows arguments by CommandLineToArgvW rules', () => {
		expect(windowsArgument('plain')).toBe('plain')
		expect(windowsArgument('a b')).toBe('"a b"')
		expect(windowsArgument('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"')
		expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""')
	})

	it('reads a task query', () => {
		expect(
			parseTaskQuery('Status:  Running\r\nScheduled Task State: Enabled\r\nLast Result: 0\r\n'),
		).toEqual({
			status: 'Running',
			state: 'Enabled',
			lastResult: '0',
		})
	})

	it('says a task’s last result in words, keeping the number', () => {
		// What the operator's `namzu schedule status` printed: "last result
		// 267009", then "-2147020576".
		expect(describeTaskResult('267009')).toBe('running (267009, 0x41301)')
		expect(describeTaskResult('-2147020576')).toBe(
			'an instance was already running, so a new one was not started; expected, since the task checks every five minutes (-2147020576, 0x800710E0)',
		)
		expect(describeTaskResult('0')).toBe('succeeded (0)')
		expect(describeTaskResult('267011')).toBe('not run yet (267011, 0x41303)')
		expect(describeTaskResult('0x41301')).toBe('running (0x41301)')
		expect(describeTaskResult('75')).toBe(
			'the scheduler exited: another one owns this NAMZU_HOME (75)',
		)
		expect(describeTaskResult('80')).toBe(
			'the scheduler exited: namzu schedule stop asked it to (80)',
		)
		expect(describeTaskResult('42')).toBe('the program exited (42)')
		expect(describeTaskResult('-1073741510')).toBe(
			'ended when its console closed (-1073741510, 0xC000013A)',
		)
		// Unknown: the number, with its hexadecimal.
		expect(describeTaskResult('-1073741819')).toBe('-1073741819 (0xC0000005)')
		expect(describeTaskResult('N/A')).toBe('N/A')
	})

	it('puts the words in the status line', async () => {
		const run: CommandRunner = async () => ({
			code: 0,
			stdout: 'Status:  Running\r\nScheduled Task State: Enabled\r\nLast Result: -2147020576\r\n',
			stderr: '',
		})
		const state = await serviceState({ paths: sb.paths, run, env: {}, version: 't' }, {
			v: 1,
			kind: 'schedule-service',
			platform: 'wsl-windows-task',
			name: 'namzu-test',
			installedAt: '',
			cliVersion: 't',
			nodePath: '',
			binPath: '',
			namzuHome: sb.home,
			artifacts: [],
			windows: { taskPath: '\\namzu\\namzu-test', schtasks: 'schtasks.exe' },
		} as never)
		expect(state).toBe(
			'Task Scheduler: Running, enabled, last result: an instance was already running, so a new one was not started; expected, since the task checks every five minutes (-2147020576, 0x800710E0)',
		)
	})

	it('stop disables the task rather than only ending it', async () => {
		const calls: string[] = []
		const run: CommandRunner = async (cmd, args) => {
			calls.push([cmd, ...args].join(' '))
			return { code: 0, stdout: '', stderr: '' }
		}
		await stopService(
			{ paths: sb.paths, run, env: {}, version: 't' },
			{
				v: 1,
				kind: 'schedule-service',
				platform: 'wsl-windows-task',
				name: 'namzu-test',
				installedAt: '',
				cliVersion: 't',
				nodePath: '',
				binPath: '',
				namzuHome: sb.home,
				artifacts: [],
				windows: {
					taskPath: '\\namzu\\namzu-test',
					schtasks: '/mnt/c/Windows/System32/schtasks.exe',
				},
			},
		)
		expect(calls[0]).toBe(
			'/mnt/c/Windows/System32/schtasks.exe /Change /TN \\namzu\\namzu-test /DISABLE',
		)
	})
})

describe('uninstalling a Windows task', () => {
	it('deletes the \\namzu folder once it is empty, and says so when it could not', async () => {
		const calls: { cmd: string; args: readonly string[] }[] = []
		let folderCode = 0
		const run: CommandRunner = async (cmd, args) => {
			calls.push({ cmd, args })
			if (args.includes('/Query')) return { code: 1, stdout: '', stderr: 'not found' }
			if (cmd.endsWith('powershell.exe')) return { code: folderCode, stdout: '', stderr: '' }
			return { code: 0, stdout: '', stderr: '' }
		}
		const manifest = {
			v: 1 as const,
			kind: 'schedule-service' as const,
			platform: 'wsl-windows-task' as const,
			name: 'namzu-test-wsl-arch',
			installedAt: '',
			cliVersion: 't',
			nodePath: '',
			binPath: '',
			namzuHome: sb.home,
			artifacts: [{ type: 'windows-task' as const, taskPath: '\\namzu\\namzu-test-wsl-arch' }],
			windows: {
				taskPath: '\\namzu\\namzu-test-wsl-arch',
				schtasks: '/mnt/c/Windows/System32/schtasks.exe',
				powershell: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
			},
		}
		const { writeManifest } = await import('../service/manifest.js')
		writeManifest(sb.paths, manifest)
		expect(
			(await uninstallService({ paths: sb.paths, run, env: {}, version: 't' })).problems,
		).toEqual([])
		const ps = calls.find((c) => c.cmd.endsWith('powershell.exe'))
		expect(ps?.args.at(-2)).toBe('-EncodedCommand')
		const script = Buffer.from(String(ps?.args.at(-1)), 'base64').toString('utf16le')
		expect(script).toBe(REMOVE_EMPTY_TASK_FOLDER_SCRIPT)
		expect(script).toContain("DeleteFolder('namzu', 0)")
		expect(script).toContain('GetTasks(1).Count -gt 0')

		folderCode = 1
		writeManifest(sb.paths, manifest)
		const stuck = await uninstallService({ paths: sb.paths, run, env: {}, version: 't' })
		expect(stuck.problems).toEqual([expect.stringMatching(/empty Task Scheduler folder/)])
		expect(readManifest(sb.paths)).toBeDefined()
	})
})

describe('WSL', () => {
	it('starts the daemon through wsl.exe with NAMZU_HOME set, and refuses paths wsl.exe would re-read', () => {
		const def = wslTaskDefinition({
			userId: 'DESKTOP\\arda',
			distro: 'archlinux',
			linuxUser: 'arda',
			node: '/usr/bin/node',
			bin: '/usr/lib/node_modules/@namzu/cli/dist/bin.js',
			namzuHome: '/home/arda/.namzu',
		})
		expect(def.command).toBe('C:\\Windows\\System32\\conhost.exe')
		expect(def.args).toEqual([
			'--headless',
			'C:\\Windows\\System32\\wsl.exe',
			'-d',
			'archlinux',
			'-u',
			'arda',
			'--cd',
			'/',
			'--exec',
			'/usr/bin/env',
			'NAMZU_HOME=/home/arda/.namzu',
			'/usr/bin/node',
			'/usr/lib/node_modules/@namzu/cli/dist/bin.js',
			'schedule',
			'daemon',
			'--home',
			'/home/arda/.namzu',
		])
		expect(() => checkWslPath('node', '/opt/my node/bin/node')).toThrow(/re-read/)
		expect(() => checkWslPath('home', '/home/$USER/.namzu')).toThrow(/re-read/)
		expect(() => checkWslPath('home', "/home/a'b")).toThrow(/re-read/)
	})
})

describe('choosing a supervisor', () => {
	it('picks per platform, WSL over systemd', () => {
		expect(detectPlatform({ platform: 'darwin' }).platform).toBe('launchd')
		expect(detectPlatform({ platform: 'win32' }).platform).toBe('windows-task')
		expect(
			detectPlatform({ platform: 'linux', env: { WSL_DISTRO_NAME: 'arch' }, systemdUser: true })
				.platform,
		).toBe('wsl-windows-task')
		expect(detectPlatform({ platform: 'linux', env: {}, systemdUser: true }).platform).toBe(
			'systemd-user',
		)
		expect(detectPlatform({ platform: 'linux', env: {}, systemdUser: false }).platform).toBeNull()
	})

	it('names the service after its home', () => {
		expect(defaultServiceName('/home/a/.namzu', '/home/a')).toBe('namzu-scheduler')
		expect(defaultServiceName('/tmp/other', '/home/a')).toMatch(/^namzu-scheduler-[0-9a-f]{8}$/)
	})
})
