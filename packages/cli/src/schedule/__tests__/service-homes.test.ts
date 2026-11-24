/**
 * A named service keeps its home in the Namzu folder (`services/<name>`), an
 * older one is brought there by `service move`, and a job's folder may not sit
 * in any of those homes. The supervisor is a recording fake; every folder is
 * temporary and HOME is stubbed to one.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const supervisor = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../service/runner.js', () => ({
	runCommand: async (cmd: string, args: string[]) => {
		supervisor.calls.push([cmd, ...args].join(' '))
		return { code: 0, stdout: args.includes('show') ? 'LoadState=not-found' : '', stderr: '' }
	},
}))

import { scheduleCommand } from '../../commands/schedule.js'
import { buildJob, confirmJob } from '../build.js'
import { checkJobFolder, checkScratchFolder, plannedScratchFolder } from '../folder.js'
import { schedulePaths } from '../paths.js'
import { readManifest } from '../service/manifest.js'
import { readServiceIndex, serviceHomePath, serviceIndexPath } from '../service/registry.js'
import { confirmationHolds, createJob, findJob } from '../store/jobs.js'
import { readState, writeState } from '../store/state.js'
import { type Sandbox, confirmedJob, jobRequest, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
	supervisor.calls.length = 0
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

const systemd = ['--platform', 'systemd-user']

/** What a command printed, as one text. */
function said(out: { printed: unknown[] }): string {
	return out.printed
		.map((p) => (typeof p === 'string' ? p : String((p as { text?: unknown }).text ?? '')))
		.join('\n')
}

/** A pure-script job with a scratch folder beside `home`, confirmed. */
function scratchJob(home: string, name: string) {
	const paths = schedulePaths(home)
	const built = buildJob(
		jobRequest(sb, {
			name,
			runKind: 'script',
			workspace: 'none',
			folder: undefined,
			script: { body: 'echo done', shell: 'sh' as const },
			permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
		}),
		{ paths, config: {}, now: new Date(), osHome: sb.osHome },
	)
	return createJob(paths, confirmJob(built, 'cli-tty', new Date(), { paths }))
}

describe('install by name', () => {
	it('keeps the home in the Namzu folder and records it', async () => {
		const r = run(['service', 'install', 'autodev', ...systemd])
		expect(await r.code).toBe(0)
		const home = join(sb.osHome, '.namzu', 'services', 'autodev')
		expect(serviceHomePath('autodev', sb.osHome)).toBe(home)
		expect(statSync(home).isDirectory()).toBe(true)
		expect(readServiceIndex(sb.osHome)).toMatchObject([{ name: 'autodev', home }])
		expect(readManifest(schedulePaths(home))?.namzuHome).toBe(home)
		expect(supervisor.calls).toContain('systemctl --user enable --now autodev.service')
		expect(said(r.out)).toContain(home)
	})

	it('creates nothing on a dry run', async () => {
		const r = run(['service', 'install', 'autodev', ...systemd, '--dry-run'])
		expect(await r.code).toBe(0)
		expect(existsSync(join(sb.osHome, '.namzu'))).toBe(false)
		expect(supervisor.calls).toEqual([])
	})

	it('stays the current home’s own scheduler without a name, and --home is still a choice', async () => {
		vi.stubEnv('NAMZU_HOME', sb.home)
		expect(await run(['service', 'install', ...systemd]).code).toBe(0)
		expect(readServiceIndex(sb.osHome)[0]?.home).toBe(sb.home)
		const other = join(sb.osHome, 'elsewhere')
		mkdirSync(other)
		expect(await run(['service', 'install', 'chosen', '--home', other, ...systemd]).code).toBe(0)
		expect(readServiceIndex(sb.osHome).find((e) => e.name === 'chosen')?.home).toBe(other)
	})

	it('retires --name with one line naming the new spelling, and exits 64', async () => {
		const r = run(['service', 'install', '--name', 'autodev', ...systemd])
		expect(await r.code).toBe(64)
		expect(r.out.errors).toHaveLength(1)
		expect(r.out.errors[0]).toContain('namzu schedule service install <n>')
		expect(supervisor.calls).toEqual([])
		expect(readServiceIndex(sb.osHome)).toEqual([])
	})

	it('refuses a name the scratch folders use, and two words', async () => {
		const bad = run(['service', 'install', 'x-schedule-workspaces', ...systemd])
		expect(await bad.code).toBe(64)
		const two = run(['service', 'install', 'a', 'b', ...systemd])
		expect(await two.code).toBe(64)
		expect(supervisor.calls).toEqual([])
	})

	it('says how to move a same-named service that lives elsewhere', async () => {
		expect(await run(['service', 'install', 'autodev', '--home', sb.home, ...systemd]).code).toBe(0)
		const r = run(['service', 'install', 'autodev', ...systemd])
		expect(await r.code).toBe(1)
		expect(r.out.errors[0]).toContain('namzu schedule service move autodev')
		expect(existsSync(join(sb.osHome, '.namzu', 'services', 'autodev'))).toBe(false)
	})
})

describe('service move', () => {
	async function legacy() {
		expect(await run(['service', 'install', 'autodev', '--home', sb.home, ...systemd]).code).toBe(0)
		const outside = confirmedJob(sb, { name: 'project-job' })
		const scratch = scratchJob(sb.home, 'scratch-job')
		writeFileSync(join(sb.home, 'schedule', 'daemon.env'), 'SECRET_KEY=hunter2\n', { mode: 0o600 })
		// A daemon that is up: its heartbeat is fresh.
		mkdirSync(join(sb.home, 'schedule', 'daemon'), { recursive: true })
		writeFileSync(
			join(sb.home, 'schedule', 'daemon', 'heartbeat.json'),
			JSON.stringify({ at: new Date().toISOString(), pid: 1, epoch: 'e', version: 'x' }),
		)
		supervisor.calls.length = 0
		return { outside, scratch }
	}

	it('prints the plan and changes nothing with --dry-run', async () => {
		await legacy()
		const to = serviceHomePath('autodev', sb.osHome)
		const r = run(['service', 'move', 'autodev', '--dry-run'])
		expect(await r.code).toBe(0)
		expect(said(r.out)).toContain(to)
		expect(said(r.out)).toContain('Nothing was changed')
		expect(existsSync(to)).toBe(false)
		expect(existsSync(sb.home)).toBe(true)
		expect(readServiceIndex(sb.osHome)[0]?.home).toBe(sb.home)
		expect(supervisor.calls).toEqual([])
	})

	it('moves the home and the scratch folders, reinstalls the unit and keeps what still holds', async () => {
		const { outside, scratch } = await legacy()
		const oldScratch = scratch.folder.path
		expect(existsSync(oldScratch)).toBe(true)
		const to = serviceHomePath('autodev', sb.osHome)
		const r = run(['service', 'move', 'autodev'])
		expect(await r.code).toBe(0)

		expect(existsSync(sb.home)).toBe(false)
		expect(existsSync(oldScratch)).toBe(false)
		expect(statSync(to).isDirectory()).toBe(true)
		expect(readServiceIndex(sb.osHome)).toMatchObject([{ name: 'autodev', home: to }])
		expect(readManifest(schedulePaths(to))?.namzuHome).toBe(to)
		const unit = readFileSync(join(sb.root, 'config', 'systemd', 'user', 'autodev.service'), 'utf8')
		expect(unit).toContain(to)
		expect(unit).not.toContain(sb.home)
		expect(supervisor.calls).toContain('systemctl --user disable --now autodev.service')
		expect(supervisor.calls).toContain('systemctl --user enable --now autodev.service')

		// A job with a project folder never stored the home: still confirmed.
		const paths = schedulePaths(to)
		expect(confirmationHolds(findJob(paths, outside.id))).toBe(true)
		// The scratch job follows its folder and must be confirmed again.
		const moved = findJob(paths, scratch.id)
		expect(moved.folder.path).toBe(plannedScratchFolder(to, scratch.id))
		expect(existsSync(moved.folder.path)).toBe(true)
		expect(checkScratchFolder(to, scratch.id)).toMatchObject({ ok: true })
		expect(confirmationHolds(moved)).toBe(false)
		expect(moved.confirmation).not.toBeNull()
		const text = said(r.out)
		expect(text).toContain('Confirm again')
		expect(text).toContain('scratch-job')
		expect(text).not.toContain('project-job')
		expect(text).toContain('Confirmations still hold for 1 job')
		// The secret file moved untouched and was never printed.
		expect(readFileSync(join(to, 'schedule', 'daemon.env'), 'utf8')).toBe('SECRET_KEY=hunter2\n')
		expect(text).not.toContain('hunter2')

		// `schedule list` finds the service at its new home.
		const listed = run(['service', 'list', '--json'])
		expect(await listed.code).toBe(0)
		expect(JSON.parse(listed.out.printed[0] as string).services[0].home).toBe(to)
	})

	it('leaves a stopped service stopped', async () => {
		await legacy()
		expect(await run(['service', 'stop', 'autodev']).code).toBe(0)
		rmSync(join(sb.home, 'schedule', 'daemon', 'heartbeat.json'))
		supervisor.calls.length = 0
		expect(await run(['service', 'move', 'autodev']).code).toBe(0)
		const to = serviceHomePath('autodev', sb.osHome)
		expect(existsSync(join(to, 'schedule', 'daemon', 'stop.json'))).toBe(true)
		expect(supervisor.calls.at(-1)).toBe('systemctl --user disable --now autodev.service')
	})

	it('refuses while a run is in progress, and changes nothing', async () => {
		const { outside } = await legacy()
		writeState(sb.paths, {
			...readState(sb.paths, outside.id),
			activeRun: {
				runId: 'run-busy',
				key: 'k',
				trigger: 'manual',
				startedAt: new Date().toISOString(),
				daemonEpoch: 'e',
				status: 'running',
			},
		})
		const r = run(['service', 'move', 'autodev'])
		expect(await r.code).toBe(1)
		expect(r.out.errors[0]).toContain('in progress')
		expect(r.out.errors[0]).toContain('--wait')
		expect(existsSync(sb.home)).toBe(true)
		expect(existsSync(serviceHomePath('autodev', sb.osHome))).toBe(false)
		expect(readServiceIndex(sb.osHome)[0]?.home).toBe(sb.home)
		// The daemon was stopped for the check and started again.
		expect(supervisor.calls.at(-1)).toBe('systemctl --user enable --now autodev.service')
	})

	it('refuses when the destination exists, and for a service already in place', async () => {
		await legacy()
		const to = serviceHomePath('autodev', sb.osHome)
		mkdirSync(to, { recursive: true })
		const r = run(['service', 'move', 'autodev'])
		expect(await r.code).toBe(1)
		expect(r.out.errors[0]).toContain('already exists')
		expect(existsSync(sb.home)).toBe(true)

		expect(await run(['service', 'install', 'fresh', ...systemd]).code).toBe(0)
		const same = run(['service', 'move', 'fresh'])
		expect(await same.code).toBe(0)
		expect(said(same.out)).toContain('already in the Namzu folder')
	})

	it('puts the folder back when the service index cannot be written', async () => {
		await legacy()
		const to = serviceHomePath('autodev', sb.osHome)
		const dir = dirname(serviceIndexPath(sb.osHome))
		chmodSync(dir, 0o555)
		try {
			const r = run(['service', 'move', 'autodev'])
			const code = await r.code
			expect(code).toBe(1)
			expect(r.out.errors.join('\n')).toContain('the move was undone')
			expect(existsSync(to)).toBe(false)
			expect(existsSync(sb.home)).toBe(true)
			expect(readServiceIndex(sb.osHome)[0]?.home).toBe(sb.home)
		} finally {
			chmodSync(dir, 0o755)
		}
	})

	it('refuses an index entry whose name would leave the services folder', async () => {
		await legacy()
		const file = serviceIndexPath(sb.osHome)
		const doc = JSON.parse(readFileSync(file, 'utf8'))
		const list = Array.isArray(doc) ? doc : doc.services
		list[0].name = '../../x'
		writeFileSync(file, JSON.stringify(doc))
		const r = run(['service', 'move', '../../x'])
		expect(await r.code).toBe(1)
		expect(existsSync(sb.home)).toBe(true)
		expect(existsSync(join(sb.osHome, 'x'))).toBe(false)
	})

	it('names an unknown service, and needs a name', async () => {
		const unknown = run(['service', 'move', 'nope'])
		expect(await unknown.code).toBe(64)
		const bare = run(['service', 'move'])
		expect(await bare.code).toBe(64)
		expect(bare.out.errors[0]).toContain('usage: namzu schedule service move <name>')
	})
})

describe('a job folder beside the Namzu homes', () => {
	it('refuses the default home, a service’s home and a folder that contains one', async () => {
		expect(await run(['service', 'install', 'autodev', ...systemd]).code).toBe(0)
		const main = join(sb.osHome, '.namzu')
		const service = serviceHomePath('autodev', sb.osHome)
		const options = { namzuHome: sb.home, osHome: sb.osHome }
		const inService = join(service, 'schedule')
		const inMain = join(main, 'projects')
		mkdirSync(inMain, { recursive: true })
		for (const folder of [main, service, inService, inMain]) {
			expect(checkJobFolder(folder, options), folder).toMatchObject({ ok: false })
		}
		const parent = join(sb.osHome, 'a')
		mkdirSync(join(parent, '.namzu', 'services', 'x'), { recursive: true })
		expect(checkJobFolder(join(sb.osHome, 'project'), options)).toMatchObject({ ok: true })
		const inside = checkJobFolder(inService, options)
		expect(inside.ok === false && inside.reason).toContain('inside a scheduler service’s home')
		const containing = checkJobFolder(join(main, 'services'), options)
		expect(containing.ok === false && containing.reason).toContain(
			'contains a scheduler service’s home',
		)
		const inMainOnly = checkJobFolder(inMain, options)
		expect(inMainOnly.ok === false && inMainOnly.reason).toContain('inside the Namzu home')
	})

	it('refuses a service home registered outside the Namzu folder, and a folder holding it', async () => {
		expect(await run(['service', 'install', 'old', '--home', sb.home, ...systemd]).code).toBe(0)
		const options = { namzuHome: join(sb.osHome, 'other-home'), osHome: sb.osHome }
		mkdirSync(options.namzuHome)
		const inside = join(sb.home, 'schedule')
		mkdirSync(inside, { recursive: true })
		expect(checkJobFolder(inside, options)).toMatchObject({ ok: false })
		expect(checkJobFolder(realpathSync(sb.home), options)).toMatchObject({ ok: false })
	})

	it('still lets a service job use its own scratch folder inside the Namzu folder', async () => {
		expect(await run(['service', 'install', 'autodev', ...systemd]).code).toBe(0)
		const service = serviceHomePath('autodev', sb.osHome)
		const job = scratchJob(service, 'in-service')
		expect(existsSync(job.folder.path)).toBe(true)
		expect(job.folder.path.startsWith(join(sb.osHome, '.namzu', 'services'))).toBe(true)
		expect(checkScratchFolder(service, job.id)).toMatchObject({ ok: true })
		expect(confirmationHolds(job)).toBe(true)
	})
})
