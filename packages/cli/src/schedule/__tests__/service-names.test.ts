/**
 * Named scheduler services: the per-user index, the target word on the
 * service commands, and `--service` on the job commands. The supervisor is a
 * recording fake; every folder is temporary and HOME is stubbed to one.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const supervisor = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../service/runner.js', () => ({
	runCommand: async (cmd: string, args: string[]) => {
		supervisor.calls.push([cmd, ...args].join(' '))
		return { code: 0, stdout: args.includes('show') ? 'LoadState=not-found' : '', stderr: '' }
	},
}))

const fired = vi.hoisted(() => ({ homes: [] as string[] }))
vi.mock('../fire/fire.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../fire/fire.js')>()),
	runFire: async (_ctx: unknown, paths: { home: string }) => {
		fired.homes.push(paths.home)
		return 0
	},
}))

import { scheduleCommand } from '../../commands/schedule.js'
import { schedulePaths } from '../paths.js'
import { defaultServiceName } from '../service/names.js'
import { readServiceIndex, serviceIndexPath } from '../service/registry.js'
import { readJob } from '../store/jobs.js'
import { type Sandbox, confirmedJob, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
let homeB: string
beforeEach(() => {
	sb = sandbox()
	homeB = join(sb.osHome, 'home-b')
	mkdirSync(homeB, { recursive: true })
	supervisor.calls.length = 0
	fired.homes.length = 0
	vi.stubEnv('HOME', sb.osHome)
	vi.stubEnv('USERPROFILE', sb.osHome)
	vi.stubEnv('XDG_CONFIG_HOME', join(sb.root, 'config'))
	vi.stubEnv('NAMZU_HOME', '')
})
afterEach(() => {
	vi.unstubAllEnvs()
	sb.cleanup()
})

function run(rawArgs: string[]) {
	const ctx = recordingContext()
	const code = scheduleCommand.handler({ ctx, rawArgs } as never)
	return { code, out: ctx.out }
}

async function install(name: string | undefined, home: string, extra: string[] = []) {
	const r = run([
		'service',
		'install',
		'--platform',
		'systemd-user',
		'--home',
		home,
		...(name ? ['--name', name] : []),
		...extra,
	])
	return { code: await r.code, out: r.out }
}

describe('the service index', () => {
	it('is written on install, in the default home, with the home each name serves', async () => {
		expect((await install('autodev', homeB)).code).toBe(0)
		const path = serviceIndexPath(sb.osHome)
		expect(path).toBe(join(sb.osHome, '.namzu', 'schedule', 'services.json'))
		const file = JSON.parse(readFileSync(path, 'utf8'))
		expect(file.v).toBe(1)
		expect(file.kind).toBe('schedule-service-index')
		expect(file.services).toHaveLength(1)
		expect(file.services[0]).toMatchObject({
			name: 'autodev',
			home: homeB,
			platform: 'systemd-user',
		})
		expect(typeof file.services[0].installedAt).toBe('string')
	})

	it('refuses a name that serves another home, naming both', async () => {
		await install('autodev', homeB)
		const r = await install('autodev', sb.home)
		expect(r.code).toBe(1)
		expect(r.out.errors).toHaveLength(1)
		expect(r.out.errors[0]).toContain(homeB)
		expect(r.out.errors[0]).toContain(sb.home)
		expect(r.out.errors[0]).toContain('uninstall')
		expect(r.out.errors[0]).toContain('--name')
		expect(readServiceIndex(sb.osHome)).toHaveLength(1)
	})

	it('updates the entry when the same name is installed again for the same home', async () => {
		await install('autodev', homeB)
		const first = readServiceIndex(sb.osHome)[0]
		expect((await install('autodev', homeB)).code).toBe(0)
		const after = readServiceIndex(sb.osHome)
		expect(after).toHaveLength(1)
		expect(after[0]?.installedAt >= (first?.installedAt ?? '')).toBe(true)
	})

	it('records the default name when --name is omitted', async () => {
		await install(undefined, homeB)
		expect(readServiceIndex(sb.osHome)[0]?.name).toBe(defaultServiceName(homeB))
	})

	it('is removed on uninstall, also when the supervisor has nothing left', async () => {
		await install('autodev', homeB)
		await install('other', sb.home)
		const r = run(['service', 'uninstall', 'autodev', '--wait', '0s'])
		expect(await r.code).toBe(0)
		expect(readServiceIndex(sb.osHome).map((e) => e.name)).toEqual(['other'])
		// The supervisor's record is already gone: the entry still goes.
		await install('gone', homeB)
		rmSync(schedulePaths(homeB).service)
		expect(await run(['service', 'uninstall', 'gone', '--wait', '0s']).code).toBe(0)
		expect(readServiceIndex(sb.osHome).map((e) => e.name)).toEqual(['other'])
	})
})

describe('a service named on a service command', () => {
	beforeEach(async () => {
		await install('alpha', sb.home)
		await install('beta', homeB)
		supervisor.calls.length = 0
	})

	it('acts on the named service for status, start, stop, logs and uninstall', async () => {
		const status = run(['service', 'status', 'beta', '--json'])
		await status.code
		expect(supervisor.calls.join('\n')).toContain('beta.service')
		expect(supervisor.calls.join('\n')).not.toContain('alpha.service')
		expect(status.out.info[0]).toBe(`Using the scheduler service beta (${homeB}).`)

		supervisor.calls.length = 0
		expect(await run(['service', 'start', 'beta']).code).toBe(0)
		expect(supervisor.calls).toContain('systemctl --user enable --now beta.service')

		supervisor.calls.length = 0
		const stop = run(['service', 'stop', 'beta'])
		expect(await stop.code).toBe(0)
		expect(supervisor.calls).toContain('systemctl --user disable --now beta.service')
		expect(JSON.stringify(stop.out.printed)).toContain('Stopped beta')
		// The stop request landed in beta's home, not alpha's.
		expect(existsSync(join(homeB, 'schedule'))).toBe(true)

		const logFile = join(schedulePaths(homeB).daemonLog, 'daemon-2999-01-01.jsonl')
		mkdirSync(dirname(logFile), { recursive: true })
		writeFileSync(
			logFile,
			`${JSON.stringify({ time: '2999-01-01T00:00:00Z', level: 'info', message: 'beta-only-line' })}\n`,
		)
		const logs = run(['service', 'logs', 'beta'])
		expect(await logs.code).toBe(0)
		expect(logs.out.info[0]).toContain(homeB)
		expect(logs.out.printed.join('\n')).toContain('beta-only-line')

		supervisor.calls.length = 0
		const gone = run(['service', 'uninstall', 'beta', '--wait', '0s'])
		expect(await gone.code).toBe(0)
		expect(supervisor.calls).toContain('systemctl --user disable --now beta.service')
		expect(supervisor.calls.join('\n')).not.toContain('alpha.service')
		expect(readServiceIndex(sb.osHome).map((e) => e.name)).toEqual(['alpha'])
	})

	it('does not change what an unnamed command acts on', async () => {
		vi.stubEnv('NAMZU_HOME', sb.home)
		const status = run(['service', 'status', '--json'])
		await status.code
		expect(supervisor.calls.join('\n')).toContain('alpha.service')
		expect(status.out.info).toEqual([])
	})

	it('fails an unknown name with the known ones and the list hint', async () => {
		const r = run(['service', 'status', 'nope'])
		expect(await r.code).toBe(64)
		expect(r.out.errors).toEqual([
			'no scheduler service is named nope; known: alpha, beta; see namzu schedule service list',
		])
		expect(supervisor.calls).toEqual([])
	})

	it('says once that the name wins over a different NAMZU_HOME', async () => {
		vi.stubEnv('NAMZU_HOME', sb.home)
		const r = run(['service', 'status', 'beta', '--json'])
		await r.code
		expect(r.out.info).toEqual([
			`Using the scheduler service beta (${homeB}).`,
			`NAMZU_HOME points at ${sb.home}; the service name wins.`,
		])
		expect(process.env.NAMZU_HOME).toBe(sb.home)
	})
})

describe('service list', () => {
	it('shows every entry with its state, and a gone home as missing', async () => {
		await install('alpha', sb.home)
		await install('beta', homeB)
		const ghost = join(sb.osHome, 'ghost-home')
		mkdirSync(ghost)
		await install('ghost', ghost)
		rmSync(ghost, { recursive: true, force: true })
		rmSync(schedulePaths(homeB).service)
		const r = run(['service', 'list', '--json'])
		expect(await r.code).toBe(0)
		const payload = JSON.parse(r.out.printed[0] as string)
		const byName = Object.fromEntries(
			payload.services.map((s: { name: string; state: string }) => [s.name, s]),
		)
		expect(byName.alpha).toMatchObject({
			home: sb.home,
			platform: 'systemd-user',
			state: 'not running',
		})
		expect(byName.beta.state).toBe('not installed')
		expect(byName.ghost).toMatchObject({ home: ghost, state: 'missing' })
	})

	it('prints rows as text', async () => {
		await install('alpha', sb.home)
		const r = run(['service', 'list'])
		await r.code
		expect(String(r.out.printed[0])).toContain('alpha')
		expect(String(r.out.printed[0])).toContain('not running')
	})
})

describe('--service on the job commands', () => {
	it('lists, pauses and runs against the named service’s home', async () => {
		const other: Sandbox = { ...sb, home: homeB, paths: schedulePaths(homeB) }
		const job = confirmedJob(other, { name: 'nightly' })
		await install('beta', homeB)

		const listed = run(['list', '--service', 'beta', '--json'])
		expect(await listed.code).toBe(0)
		expect(JSON.stringify(listed.out.printed)).toContain(job.id)
		expect(listed.out.info[0]).toBe(`Using the scheduler service beta (${homeB}).`)

		const paused = run(['pause', 'nightly', '--service', 'beta'])
		expect(await paused.code).toBe(0)
		expect(readJob(other.paths, job.id)?.state).toBe('paused')

		await run(['resume', 'nightly', '--service', 'beta']).code
		const ran = run(['run', 'nightly', '--service', 'beta'])
		expect(await ran.code).toBe(0)
		expect(ran.out.info[0]).toBe(`Using the scheduler service beta (${homeB}).`)
		expect(fired.homes).toEqual([homeB])

		const ghost = run(['run', 'ghost', '--service', 'beta'])
		expect(await ghost.code).not.toBe(0)
		expect(ghost.out.errors.join('\n')).toContain('ghost')
	})

	it('fails an unknown service in one line', async () => {
		const unknown = run(['list', '--service', 'nope'])
		expect(await unknown.code).toBe(64)
		expect(unknown.out.errors).toHaveLength(1)
		expect(unknown.out.errors[0]).toContain('namzu schedule service list')
	})
})

describe('a service name in the wrong place', () => {
	beforeEach(async () => {
		await install('alpha', sb.home)
		await install('beta', homeB)
		supervisor.calls.length = 0
	})

	it('refuses a name after a flag instead of acting on the current home', async () => {
		vi.stubEnv('NAMZU_HOME', sb.home)
		const r = run(['service', 'status', '--json', 'beta'])
		expect(await r.code).toBe(64)
		expect(r.out.errors).toHaveLength(1)
		expect(r.out.errors[0]).toContain('unexpected argument: beta')
		expect(supervisor.calls).toEqual([])
	})

	it('refuses extra words after the name on every service verb', async () => {
		for (const verb of ['status', 'start', 'stop', 'logs', 'uninstall']) {
			const r = run(['service', verb, 'beta', 'extra'])
			expect(await r.code).toBe(64)
			expect(r.out.errors[0]).toContain('unexpected argument: extra')
		}
		expect(supervisor.calls).toEqual([])
	})
})

describe('a damaged or newer index', () => {
	const writeIndex = (text: string) => {
		const path = serviceIndexPath(sb.osHome)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, text)
		return path
	}

	it('is reported in one line and never overwritten, whatever the command', async () => {
		for (const text of [
			'garbage',
			JSON.stringify({ v: 2, kind: 'schedule-service-index', services: [] }),
		]) {
			const path = writeIndex(text)
			const installed = await install('a', homeB)
			expect(installed.code).toBe(0)
			expect(installed.out.info.join('\n')).toContain('cannot be read')
			expect(readFileSync(path, 'utf8')).toBe(text)

			const status = run(['service', 'status', 'a'])
			expect(await status.code).toBe(1)
			expect(status.out.errors[0]).toContain('cannot be read')

			const list = run(['service', 'list'])
			expect(await list.code).toBe(1)
			expect(list.out.errors[0]).toContain('fix or move it')

			const gone = run(['service', 'uninstall', '--home', homeB, '--wait', '0s'])
			expect(await gone.code).toBe(0)
			expect(JSON.stringify(gone.out.printed)).toContain('Removed')
			expect(gone.out.info.join('\n')).toContain('not updated')
			expect(readFileSync(path, 'utf8')).toBe(text)
		}
	})

	it('skips entries that are null or lack a home or platform', async () => {
		writeIndex(
			JSON.stringify({
				v: 1,
				kind: 'schedule-service-index',
				services: [
					{ name: 'x' },
					null,
					{ name: 'ok', home: homeB, platform: 'systemd-user', installedAt: 'x' },
				],
			}),
		)
		const list = run(['service', 'list', '--json'])
		expect(await list.code).toBe(0)
		expect(
			JSON.parse(list.out.printed[0] as string).services.map((s: { name: string }) => s.name),
		).toEqual(['ok'])
		const status = run(['service', 'status', 'y'])
		expect(await status.code).toBe(64)
	})
})

describe('one home, one name', () => {
	it('replaces an older name for the same home on install', async () => {
		await install('a', homeB)
		expect((await install('b', homeB)).code).toBe(0)
		expect(readServiceIndex(sb.osHome).map((e) => e.name)).toEqual(['b'])
		const r = run(['service', 'status', 'a'])
		expect(await r.code).toBe(64)
	})
})
