/**
 * The name given to `schedule service install` is the name typed afterwards,
 * also on WSL, where only the Windows task carries the distro.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installService, serviceState, startService, stopService } from '../service/index.js'
import { type ServiceManifest, readManifest, writeManifest } from '../service/manifest.js'
import { displayName, matchService } from '../service/registry.js'
import type { CommandRunner } from '../service/runner.js'
import { windowsTools } from '../service/wsl.js'
import { type Sandbox, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => sb.cleanup())

const TASK = '\\namzu\\autodev-wsl-archlinux'

function fakeWindows() {
	const system32 = join(sb.root, 'win', 'c', 'Windows', 'System32')
	mkdirSync(system32, { recursive: true })
	const tools = windowsTools(system32)
	writeFileSync(tools.cmd, '')
	const calls: string[] = []
	const run: CommandRunner = async (cmd, args) => {
		calls.push([cmd, ...args].join(' '))
		if (cmd === tools.whoami) return { code: 0, stdout: 'PC\\me\r\n', stderr: '' }
		if (args.includes('echo'))
			return { code: 0, stdout: 'C:\\Users\\me\\AppData\\Local\r\n', stderr: '' }
		if (cmd === 'wslpath' && args[0] === '-u')
			return {
				code: 0,
				stdout: `${join(tools.mountRoot, 'c', 'Users', 'me', 'namzu')}\n`,
				stderr: '',
			}
		if (cmd === 'wslpath') return { code: 0, stdout: 'C:\\stage.xml\n', stderr: '' }
		return { code: 0, stdout: '', stderr: '' }
	}
	return { tools, run, calls }
}

describe('a WSL service keeps the name it was given', () => {
	it('records the given name and keeps the suffixed Windows task', async () => {
		const { tools, run, calls } = fakeWindows()
		const ctx = {
			paths: sb.paths,
			run,
			env: { WSL_DISTRO_NAME: 'archlinux', WSL_INTEROP: '1' },
			version: 't',
			tools,
		}
		const { manifest, problems } = await installService(ctx, {
			platform: 'wsl-windows-task',
			name: 'autodev',
			program: { node: process.execPath, bin: '/x/bin.js', namzuHome: sb.home },
		})
		expect(problems).toEqual([])
		expect(manifest.name).toBe('autodev')
		expect(readManifest(sb.paths)?.name).toBe('autodev')
		expect(manifest.windows?.taskPath).toBe(TASK)
		expect(calls).toContain(`${tools.schtasks} /Create /TN ${TASK} /XML C:\\stage.xml /F`)

		// The word the person types resolves through the index entry to the
		// service, and its calls reach the suffixed task.
		const entry = {
			name: manifest.name,
			home: sb.home,
			platform: manifest.platform,
			installedAt: '',
		}
		expect(matchService([entry], 'autodev', ctx.env)).toBe(entry)
		expect(displayName(entry, ctx.env)).toBe('autodev')
		const found = readManifest(sb.paths)
		if (!found) throw new Error('manifest missing')

		calls.length = 0
		await serviceState(ctx, found)
		await stopService(ctx, found)
		await startService(ctx, found)
		const tasks = calls.filter((c) => c.startsWith(tools.schtasks))
		expect(tasks.length).toBeGreaterThanOrEqual(4)
		for (const call of tasks) expect(call).toContain(`/TN ${TASK}`)
	})
})

describe('an entry written by the older code', () => {
	const old = {
		name: 'autodev-wsl-archlinux',
		home: '/data/autodev',
		platform: 'wsl-windows-task' as const,
		installedAt: '',
	}
	const systemd = {
		name: 'beta',
		home: '/data/beta',
		platform: 'systemd-user' as const,
		installedAt: '',
	}

	it('is found by the base name through the distro in the environment', () => {
		const env = { WSL_DISTRO_NAME: 'archlinux' }
		expect(matchService([old, systemd], 'autodev', env)).toBe(old)
		expect(displayName(old, env)).toBe('autodev')
		expect(matchService([old], 'autodev-wsl-archlinux', env)).toBe(old)
		expect(matchService([old], 'other', env)).toBeUndefined()
	})

	it('is found through the distro stored in the service manifest', () => {
		const manifest: ServiceManifest = {
			v: 1,
			kind: 'schedule-service',
			platform: 'wsl-windows-task',
			name: old.name,
			installedAt: '',
			cliVersion: 't',
			nodePath: '',
			binPath: '',
			namzuHome: sb.home,
			artifacts: [],
			windows: { taskPath: TASK, schtasks: 's', distro: 'archlinux' },
		}
		writeManifest(sb.paths, manifest)
		const entry = { ...old, home: sb.home }
		expect(matchService([entry], 'autodev', {})).toBe(entry)
	})

	it('does not touch other platforms, and an exact name wins', () => {
		const lookalike = { ...systemd, name: 'autodev-wsl-archlinux' }
		expect(matchService([lookalike], 'autodev', { WSL_DISTRO_NAME: 'archlinux' })).toBeUndefined()
		const exact = { ...old, name: 'autodev', home: '/data/x' }
		expect(matchService([old, exact], 'autodev', { WSL_DISTRO_NAME: 'archlinux' })).toBe(exact)
	})
})

describe('systemd naming is unchanged', () => {
	it('uses the given name for the manifest and the unit', async () => {
		const run: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' })
		const ctx = {
			paths: sb.paths,
			run,
			env: { XDG_CONFIG_HOME: join(sb.root, 'config') },
			version: 't',
		}
		const { manifest } = await installService(ctx, {
			platform: 'systemd-user',
			name: 'autodev',
			program: { node: process.execPath, bin: '/x/bin.js', namzuHome: sb.home },
		})
		expect(manifest.name).toBe('autodev')
		expect(manifest.artifacts).toContainEqual({ type: 'systemd-unit', name: 'autodev.service' })
	})
})
