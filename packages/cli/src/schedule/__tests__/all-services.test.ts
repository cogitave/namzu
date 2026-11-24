/**
 * Jobs of installed scheduler services are found without naming the service:
 * `schedule list` groups them, a job command resolves a name across the
 * current home and every service, and a name in several homes is refused.
 * Two temporary homes (a current one and a registered service's); HOME is
 * stubbed to a temporary folder, so the real index is never read.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { locateJob, scheduleHomes } from '../service/homes.js'
import { recordService } from '../service/registry.js'
import { findJob, readJob, updateJob } from '../store/jobs.js'
import { type Sandbox, confirmedJob, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
let svc: Sandbox
beforeEach(() => {
	sb = sandbox()
	const home = join(sb.osHome, 'autodev-home')
	mkdirSync(home, { recursive: true })
	svc = { ...sb, home, paths: schedulePaths(home) }
	fired.homes.length = 0
	vi.stubEnv('HOME', sb.osHome)
	vi.stubEnv('USERPROFILE', sb.osHome)
	vi.stubEnv('NAMZU_HOME', sb.home)
	register('autodev', svc.home)
})
afterEach(() => {
	vi.unstubAllEnvs()
	sb.cleanup()
})

function register(name: string, home: string) {
	expect(
		recordService(
			{ name, home, platform: 'systemd-user', installedAt: new Date().toISOString() },
			sb.osHome,
		),
	).toBeUndefined()
}

async function run(rawArgs: string[]) {
	const ctx = recordingContext()
	const code = await scheduleCommand.handler({ ctx, rawArgs } as never)
	return { code, out: ctx.out }
}

describe('schedule list without --service', () => {
	it('lists this home, then each service under its name', async () => {
		confirmedJob(sb, { name: 'local-job' })
		confirmedJob(svc, { name: 'autodev-scout' })
		const r = await run(['list'])
		expect(r.code).toBe(0)
		const text = String(r.out.printed[0])
		const here = text.indexOf('This home')
		const there = text.indexOf('Service autodev')
		expect(here).toBeGreaterThanOrEqual(0)
		expect(there).toBeGreaterThan(here)
		expect(text.indexOf('local-job')).toBeLessThan(there)
		expect(text.indexOf('autodev-scout')).toBeGreaterThan(there)
	})

	it('--service narrows to one home, with no headings', async () => {
		confirmedJob(sb, { name: 'local-job' })
		confirmedJob(svc, { name: 'autodev-scout' })
		const r = await run(['list', '--service', 'autodev'])
		const text = String(r.out.printed[0])
		expect(text).toContain('autodev-scout')
		expect(text).not.toContain('local-job')
		expect(text).not.toContain('This home')
	})

	it('prints the service jobs in --json under services', async () => {
		confirmedJob(sb, { name: 'local-job' })
		confirmedJob(svc, { name: 'autodev-scout' })
		const r = await run(['list', '--json'])
		const payload = JSON.parse(String(r.out.printed[0]))
		expect(payload.jobs.map((j: { name: string }) => j.name)).toEqual(['local-job'])
		expect(payload.services).toHaveLength(1)
		expect(payload.services[0]).toMatchObject({ name: 'autodev', home: svc.home })
		expect(payload.services[0].jobs.map((j: { name: string }) => j.name)).toEqual(['autodev-scout'])
	})

	it('is unchanged when no service is installed', async () => {
		rmSync(join(sb.osHome, '.namzu'), { recursive: true, force: true })
		confirmedJob(sb, { name: 'local-job' })
		const text = String((await run(['list'])).out.printed[0])
		expect(text).not.toContain('This home')
		expect(text).toContain('local-job')
	})

	it('says "cannot read" for a service home it cannot open, and does not fail', async () => {
		register('gone', join(sb.osHome, 'no-such-home'))
		confirmedJob(sb, { name: 'local-job' })
		const r = await run(['list'])
		expect(r.code).toBe(0)
		expect(String(r.out.printed[0])).toMatch(/Service gone .*\n {2}cannot read: /)
	})

	it('never opens a service’s daemon.env', async () => {
		confirmedJob(svc, { name: 'autodev-scout' })
		const env = schedulePaths(svc.home).daemonEnv
		writeFileSync(env, 'SECRET_TOKEN=do-not-print\n', { mode: 0o600 })
		chmodSync(env, 0o000)
		const r = await run(['list', '--json'])
		expect(r.code).toBe(0)
		expect(JSON.stringify(r.out.printed)).not.toContain('do-not-print')
		chmodSync(env, 0o600)
	})
})

describe('a job command without --service', () => {
	it('finds a job that only a service has, acts on that home, and says which', async () => {
		const job = confirmedJob(svc, { name: 'autodev-scout' })
		const r = await run(['pause', 'autodev-scout'])
		expect(r.code).toBe(0)
		expect(readJob(svc.paths, job.id)?.state).toBe('paused')
		expect(r.out.info).toEqual([`Using the scheduler service autodev (${svc.home}).`])
		const resumed = await run(['resume', 'autodev-scout'])
		expect(resumed.code).toBe(0)
		expect(readJob(svc.paths, job.id)?.state).toBe('active')
		const ran = await run(['run', 'autodev-scout'])
		expect(ran.code).toBe(0)
		expect(fired.homes).toEqual([svc.home])
	})

	it('acts on this home, quietly, when only this home has the job', async () => {
		const job = confirmedJob(sb, { name: 'local-job' })
		const r = await run(['pause', 'local-job'])
		expect(r.code).toBe(0)
		expect(readJob(sb.paths, job.id)?.state).toBe('paused')
		expect(r.out.info).toEqual([])
	})

	it('refuses a name found in several homes, listing the ways to say which', async () => {
		const here = confirmedJob(sb, { name: 'nightly' })
		const there = confirmedJob(svc, { name: 'nightly' })
		const r = await run(['pause', 'nightly'])
		expect(r.code).toBe(64)
		expect(r.out.errors).toHaveLength(1)
		expect(r.out.errors[0]).toContain('this home, autodev')
		expect(r.out.errors[0]).toContain('--service autodev')
		expect(readJob(sb.paths, here.id)?.state).toBe('active')
		expect(readJob(svc.paths, there.id)?.state).toBe('active')
		// --service still picks one.
		expect((await run(['pause', 'nightly', '--service', 'autodev'])).code).toBe(0)
		expect(readJob(svc.paths, there.id)?.state).toBe('paused')
		expect(readJob(sb.paths, here.id)?.state).toBe('active')
	})

	it('gives the usual not-found error when no home has the job', async () => {
		const r = await run(['pause', 'nothing-like-it'])
		expect(r.code).not.toBe(0)
		expect(r.out.errors.join('\n')).toContain('No scheduled job is named or starts with')
	})

	it('shows and reads history of a service job by name', async () => {
		confirmedJob(svc, { name: 'autodev-scout' })
		const shown = await run(['show', 'autodev-scout', '--json'])
		expect(shown.code).toBe(0)
		expect(JSON.stringify(shown.out.printed)).toContain('autodev-scout')
		expect((await run(['history', 'autodev-scout', '--json'])).code).toBe(0)
	})

	it('still refuses to confirm without a terminal, on a service job too', async () => {
		const job = confirmedJob(svc, { name: 'autodev-scout' })
		updateJob(svc.paths, job.id, job.revision, (j) => ({
			...j,
			state: 'pending-confirmation',
			confirmation: null,
		}))
		const r = await run(['confirm', 'autodev-scout'])
		expect(r.code).toBe(64)
		expect(findJob(svc.paths, 'autodev-scout').state).toBe('pending-confirmation')
	})
})

describe('locateJob', () => {
	it('reports one, several, none and an unknown service', () => {
		confirmedJob(sb, { name: 'both' })
		confirmedJob(svc, { name: 'both' })
		confirmedJob(svc, { name: 'only-there' })
		expect(locateJob('only-there', sb.home).kind).toBe('found')
		expect(locateJob('both', sb.home).kind).toBe('several')
		expect(locateJob('both', sb.home, null).kind).toBe('found')
		expect(locateJob('missing', sb.home).kind).toBe('none')
		expect(locateJob('both', sb.home, 'nope').kind).toBe('no-service')
		expect(scheduleHomes(sb.home).homes).toHaveLength(2)
	})

	it('never settles an ambiguous local reference with a service job', () => {
		// Two local jobs of one name make the reference ambiguous here; the
		// service's job of that name must not be acted on instead.
		const first = confirmedJob(sb, { name: 'nightly' })
		const second = confirmedJob(sb, { name: 'nightly-2' })
		const file = sb.paths.job(second.id)
		writeFileSync(
			file,
			readFileSync(file, 'utf8').replace('"name": "nightly-2"', '"name": "nightly"'),
		)
		expect(first.name).toBe('nightly')
		confirmedJob(svc, { name: 'nightly' })
		expect(() => locateJob('nightly', sb.home)).toThrow()
	})

	it('tells two services with one shown name apart by their registered names', () => {
		const other = join(sb.osHome, 'other-home')
		mkdirSync(other, { recursive: true })
		register('autodev-wsl-ubuntu', other)
		const names = scheduleHomes(sb.home).homes.flatMap((h) => (h.service ? [h.service] : []))
		expect(new Set(names).size).toBe(names.length)
	})
})
