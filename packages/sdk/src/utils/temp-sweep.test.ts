import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOOK_ENV_OWNER_FILE, TEMP_SWEEP_STAMP, sweepPrivateTempRoot } from './temp-sweep.js'

const DAY = 24 * 60 * 60 * 1000
const SESSION_A = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b'
const SESSION_B = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c'
const SESSION_C = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7d'

let root: string
// Everything the test makes is created "now"; the sweep is asked about a moment 30 days later, so
// a file it should see as recent is stamped into that future instead (a change time cannot be set back).
const later = Date.now() + 30 * DAY

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-temp-sweep-'))
})
afterEach(() => {
	chmodSync(root, 0o700)
	rmSync(root, { recursive: true, force: true })
})

function scratch(slug: string, sessionId: string, recent = false): string {
	const dir = join(root, slug, sessionId, 'scratchpad')
	mkdirSync(join(dir, 'jobs'), { recursive: true })
	const file = join(dir, 'jobs', 'out.log')
	writeFileSync(file, 'output')
	if (recent) utimesSync(file, new Date(later - 60_000), new Date(later - 60_000))
	return join(root, slug, sessionId)
}

describe('sweepPrivateTempRoot', () => {
	it('removes a session folder nothing changed in for a week, and keeps one written to since', async () => {
		const old = scratch('-home-a-proj', SESSION_A)
		const fresh = scratch('-home-a-proj', SESSION_B, true)
		const report = await sweepPrivateTempRoot({ root, now: later, everyMs: 0 })
		expect(report).toMatchObject({ ran: true, removedSessions: 1 })
		expect(existsSync(old)).toBe(false)
		expect(existsSync(fresh)).toBe(true)
	})

	it('never removes a session the caller runs or says is live, however old', async () => {
		const kept = scratch('-home-a-proj', SESSION_A)
		const live = scratch('-home-a-proj', SESSION_B)
		const unsure = scratch('-home-a-proj', SESSION_C)
		const report = await sweepPrivateTempRoot({
			root,
			now: later,
			everyMs: 0,
			keep: new Set([SESSION_A]),
			isSessionLive: (_slug, id) => {
				if (id === SESSION_C) throw new Error('lease unreadable')
				return id === SESSION_B
			},
		})
		expect(report.removedSessions).toBe(0)
		for (const dir of [kept, live, unsure]) expect(existsSync(dir)).toBe(true)
	})

	it('removes an emptied project folder, and leaves a folder that is not a session alone', async () => {
		scratch('-home-a-proj', SESSION_A)
		mkdirSync(join(root, 'pdf-pagesABCDEF'))
		writeFileSync(join(root, 'pdf-pagesABCDEF', 'page-1.png'), 'x')
		await sweepPrivateTempRoot({ root, now: later, everyMs: 0 })
		expect(existsSync(join(root, '-home-a-proj'))).toBe(false)
		expect(existsSync(join(root, 'pdf-pagesABCDEF', 'page-1.png'))).toBe(true)
	})

	it('removes a hook-env folder whose owner exited, and keeps one whose owner runs', async () => {
		const dead = join(root, 'hook-envAAAAAA')
		const alive = join(root, 'hook-envBBBBBB')
		for (const [dir, pid] of [
			[dead, 111],
			[alive, 222],
		] as const) {
			mkdirSync(dir)
			writeFileSync(join(dir, 'session_start.env'), '')
			writeFileSync(join(dir, HOOK_ENV_OWNER_FILE), JSON.stringify({ pid }))
			// Idle for an hour: only the owner decides.
			const idle = new Date(later - 60 * 60 * 1000)
			utimesSync(join(dir, 'session_start.env'), idle, idle)
			utimesSync(join(dir, HOOK_ENV_OWNER_FILE), idle, idle)
			utimesSync(dir, idle, idle)
		}
		const report = await sweepPrivateTempRoot({
			root,
			now: later,
			everyMs: 0,
			isPidAlive: (pid) => pid === 222,
		})
		expect(report.removedHookEnv).toBe(1)
		expect(existsSync(dead)).toBe(false)
		expect(existsSync(alive)).toBe(true)
	})

	it('keeps a hook-env folder whose owner reads as dead while it changed in the last minutes', async () => {
		const dir = join(root, 'hook-envFFFFFF')
		mkdirSync(dir)
		writeFileSync(join(dir, HOOK_ENV_OWNER_FILE), JSON.stringify({ pid: 333 }))
		const recent = new Date(later - 60 * 1000)
		utimesSync(join(dir, HOOK_ENV_OWNER_FILE), recent, recent)
		utimesSync(dir, recent, recent)
		const report = await sweepPrivateTempRoot({
			root,
			now: later,
			everyMs: 0,
			isPidAlive: () => false,
		})
		expect(report.removedHookEnv).toBe(0)
		expect(existsSync(dir)).toBe(true)
	})

	it('removes a hook-env folder that names no owner only once it is a week old', async () => {
		const legacyOld = join(root, 'hook-envCCCCCC')
		const legacyNew = join(root, 'hook-envDDDDDD')
		mkdirSync(legacyOld)
		writeFileSync(join(legacyOld, 'session_start.3.env'), '')
		mkdirSync(legacyNew)
		writeFileSync(join(legacyNew, 'session_start.3.env'), '')
		utimesSync(join(legacyNew, 'session_start.3.env'), new Date(later), new Date(later))
		await sweepPrivateTempRoot({ root, now: later, everyMs: 0, isPidAlive: () => true })
		expect(existsSync(legacyOld)).toBe(false)
		expect(existsSync(legacyNew)).toBe(true)
	})

	it('removes a short name whose folder is gone, including one it just removed', async () => {
		const old = scratch('-home-a-proj', SESSION_A)
		const fresh = scratch('-home-a-proj', SESSION_B, true)
		symlinkSync(join(old, 'scratchpad'), join(root, 's-aaaaaaaa'), 'dir')
		symlinkSync(join(fresh, 'scratchpad'), join(root, 's-bbbbbbbb'), 'dir')
		symlinkSync(join(root, 'nowhere'), join(root, 's-cccccccc'), 'dir')
		const report = await sweepPrivateTempRoot({ root, now: later, everyMs: 0 })
		expect(report.removedAliases).toBe(2)
		expect(existsSync(join(root, 's-bbbbbbbb'))).toBe(true)
	})

	it('never follows a link out of the folder', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'namzu-temp-sweep-outside-'))
		try {
			mkdirSync(join(outside, SESSION_A))
			writeFileSync(join(outside, SESSION_A, 'keep.txt'), 'precious')
			symlinkSync(outside, join(root, '-home-linked'), 'dir')
			symlinkSync(outside, join(root, 'hook-envEEEEEE'), 'dir')
			await sweepPrivateTempRoot({ root, now: later, everyMs: 0 })
			expect(readFileSync(join(outside, SESSION_A, 'keep.txt'), 'utf8')).toBe('precious')
		} finally {
			rmSync(outside, { recursive: true, force: true })
		}
	})

	it('removes a folder a tool left read-only', async () => {
		const old = scratch('-home-a-proj', SESSION_A)
		chmodSync(join(old, 'scratchpad', 'jobs'), 0o500)
		const report = await sweepPrivateTempRoot({ root, now: later, everyMs: 0 })
		expect(report.removedSessions).toBe(1)
		expect(existsSync(old)).toBe(false)
	})

	it('runs at most once a day, by the stamp in the folder', async () => {
		const first = await sweepPrivateTempRoot({ root, now: later })
		expect(first.ran).toBe(true)
		expect(readFileSync(join(root, TEMP_SWEEP_STAMP), 'utf8').trim()).toBe(
			new Date(later).toISOString(),
		)
		scratch('-home-a-proj', SESSION_A)
		const second = await sweepPrivateTempRoot({ root, now: later + DAY / 2 })
		expect(second.ran).toBe(false)
		expect(existsSync(join(root, '-home-a-proj', SESSION_A))).toBe(true)
		const third = await sweepPrivateTempRoot({ root, now: later + DAY + 1 })
		expect(third).toMatchObject({ ran: true, removedSessions: 1 })
	})

	it('does nothing when the folder is missing or is a link', async () => {
		expect((await sweepPrivateTempRoot({ root: join(root, 'absent'), everyMs: 0 })).ran).toBe(false)
		symlinkSync(root, join(root, 'linked-root'), 'dir')
		expect((await sweepPrivateTempRoot({ root: join(root, 'linked-root'), everyMs: 0 })).ran).toBe(
			false,
		)
	})
})
