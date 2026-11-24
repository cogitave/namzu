import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { MAX_MAIL_ENTRIES, MAX_MAIL_TEXT_BYTES, TeamStore } from './store.js'
import { TeamStoreError } from './types.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function fixture(options: ConstructorParameters<typeof TeamStore>[0] = {}) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-teams-'))
	dirs.push(root)
	const store = new TeamStore({ rootDir: join(root, 'teams'), sleep: () => undefined, ...options })
	return { root, store }
}

function codeOf(fn: () => unknown): string | undefined {
	try {
		fn()
	} catch (error) {
		if (error instanceof TeamStoreError) return error.code
		throw error
	}
	return undefined
}

describe('TeamStore teams', () => {
	it('creates a team with a private directory and an empty member list', () => {
		const { store } = fixture()
		const team = store.createTeam({ name: 'team-a', leadSessionId: 'sess-1', cwd: '/work' })
		expect(team).toMatchObject({ version: 1, name: 'team-a', leadSessionId: 'sess-1', members: [] })
		expect(team.leadPid).toBe(process.pid)
		expect(store.readTeam('team-a')).toEqual(team)
		expect(store.listTeams()).toEqual(['team-a'])
		if (process.platform !== 'win32')
			expect(readFileSync(store.configPath('team-a'), 'utf8').endsWith('\n')).toBe(true)
	})

	it('returns the team that is there for the same lead session and refuses another lead', () => {
		const { store } = fixture()
		const first = store.createTeam({ name: 'team-a', leadSessionId: 'sess-1' })
		expect(store.createTeam({ name: 'team-a', leadSessionId: 'sess-1' })).toEqual(first)
		expect(codeOf(() => store.createTeam({ name: 'team-a', leadSessionId: 'sess-2' }))).toBe(
			'team_exists',
		)
	})

	it('refuses a team name that is not a safe directory name', () => {
		const { store } = fixture()
		expect(codeOf(() => store.createTeam({ name: '../x', leadSessionId: 's' }))).toBe('bad_name')
		expect(codeOf(() => store.readTeam('a/b'))).toBe('bad_name')
	})

	it('reads an unreadable or invalid config as no team', () => {
		const { store } = fixture()
		store.createTeam({ name: 'team-a', leadSessionId: 's' })
		writeFileSync(store.configPath('team-a'), '{not json')
		expect(store.readTeam('team-a')).toBeUndefined()
		writeFileSync(store.configPath('team-a'), JSON.stringify({ version: 2 }))
		expect(store.readTeam('team-a')).toBeUndefined()
		expect(store.readTeam('nope')).toBeUndefined()
		expect(store.listTeams()).toEqual([])
	})
})

describe('TeamStore members', () => {
	it('reserves a name with a colour, the first free one each time', () => {
		const { store } = fixture()
		store.createTeam({ name: 't', leadSessionId: 's' })
		const a = store.reserveMember('t', { name: 'alice', agentType: 'reviewer' })
		const b = store.reserveMember('t', { name: 'bob' })
		expect(a).toMatchObject({
			name: 'alice',
			active: true,
			backend: 'in-process',
			agentType: 'reviewer',
		})
		expect(a.color).not.toBe(b.color)
		expect(a.id).not.toBe(b.id)
		expect(store.readTeam('t')?.members.map((m) => m.name)).toEqual(['alice', 'bob'])
	})

	it('refuses a taken name however it is spelled, and the reserved ones', () => {
		const { store } = fixture()
		store.createTeam({ name: 't', leadSessionId: 's' })
		store.reserveMember('t', { name: 'Alice' })
		expect(codeOf(() => store.reserveMember('t', { name: 'alice' }))).toBe('name_taken')
		expect(codeOf(() => store.reserveMember('t', { name: 'lead' }))).toBe('bad_name')
		expect(codeOf(() => store.reserveMember('t', { name: 'a b' }))).toBe('bad_name')
		expect(codeOf(() => store.reserveMember('nope', { name: 'x' }))).toBe('team_not_found')
	})

	it('counts only members that hold a place against the limit', () => {
		const { store } = fixture()
		store.createTeam({ name: 't', leadSessionId: 's' })
		store.reserveMember('t', { name: 'a', maxMembers: 2 })
		store.reserveMember('t', { name: 'b', maxMembers: 2 })
		expect(codeOf(() => store.reserveMember('t', { name: 'c', maxMembers: 2 }))).toBe('team_full')
		store.setMemberActive('t', 'a', false)
		store.reserveMember('t', { name: 'c', maxMembers: 2 })
		expect(codeOf(() => store.setMemberActive('t', 'a', true, 2))).toBe('team_full')
		expect(store.setMemberActive('t', 'a', true).active).toBe(true)
		expect(codeOf(() => store.setMemberActive('t', 'ghost', true))).toBe('member_not_found')
	})

	it('rolls back exactly the member it reserved', () => {
		const { store } = fixture()
		store.createTeam({ name: 't', leadSessionId: 's' })
		const a = store.reserveMember('t', { name: 'alice' })
		expect(store.rollbackMember('t', a.id)).toBe(true)
		expect(store.rollbackMember('t', a.id)).toBe(false)
		const again = store.reserveMember('t', { name: 'alice' })
		expect(store.rollbackMember('t', a.id)).toBe(false)
		expect(store.readTeam('t')?.members.map((m) => m.id)).toEqual([again.id])
		expect(store.rollbackMember('gone', again.id)).toBe(false)
	})

	it('gives the name back when starting fails, and keeps it when it works', async () => {
		const { store } = fixture()
		store.createTeam({ name: 't', leadSessionId: 's' })
		await expect(
			store.withReservedMember('t', { name: 'alice' }, async () => {
				throw new Error('could not start')
			}),
		).rejects.toThrow('could not start')
		expect(store.readTeam('t')?.members).toEqual([])
		const ok = await store.withReservedMember('t', { name: 'alice' }, async (m) => m.name)
		expect(ok.result).toBe('alice')
		expect(store.readTeam('t')?.members.map((m) => m.name)).toEqual(['alice'])
	})

	it('removes a member and its mailbox', () => {
		const { store } = fixture()
		store.createTeam({ name: 't', leadSessionId: 's' })
		store.reserveMember('t', { name: 'alice' })
		store.appendMail('t', 'alice', { from: 'lead', text: 'hi' })
		expect(existsSync(store.inboxPath('t', 'alice'))).toBe(true)
		expect(store.removeMember('t', 'ALICE')).toBe(true)
		expect(store.removeMember('t', 'alice')).toBe(false)
		expect(existsSync(store.inboxPath('t', 'alice'))).toBe(false)
	})

	it('reports a config held by a live process as busy once the retries are spent', () => {
		const { store } = fixture()
		store.createTeam({ name: 't', leadSessionId: 's' })
		// A lock whose recorded owner is a live process other than this one: the parent of the runner.
		writeFileSync(`${store.configPath('t')}.lock`, `${process.ppid}:1:abc`)
		expect(codeOf(() => store.reserveMember('t', { name: 'alice' }))).toBe('busy')
	})
})

describe('TeamStore mail', () => {
	function team() {
		const f = fixture()
		f.store.createTeam({ name: 't', leadSessionId: 's' })
		f.store.reserveMember('t', { name: 'alice' })
		return f
	}

	it('keeps mail in order, for a member and for the lead', () => {
		const { store } = team()
		const first = store.appendMail('t', 'alice', {
			from: 'lead',
			text: 'one',
			summary: 'first',
			kind: 'message',
		})
		store.appendMail('t', 'Alice', { from: 'lead', text: 'two' })
		store.appendMail('t', 'lead', { from: 'alice', text: 'done', kind: 'idle' })
		expect(store.readMail('t', 'alice').map((e) => e.text)).toEqual(['one', 'two'])
		expect(first).toMatchObject({ from: 'lead', summary: 'first', kind: 'message' })
		expect(Number.isNaN(Date.parse(first.at))).toBe(false)
		expect(store.readMail('t', 'lead')).toHaveLength(1)
		expect(store.readMail('t', 'bob')).toEqual([])
	})

	it('refuses a recipient outside the team, text that is too large and a team that is gone', () => {
		const { store } = team()
		expect(codeOf(() => store.appendMail('t', 'bob', { from: 'lead', text: 'x' }))).toBe(
			'unknown_recipient',
		)
		expect(
			codeOf(() =>
				store.appendMail('t', 'alice', { from: 'lead', text: 'x'.repeat(MAX_MAIL_TEXT_BYTES + 1) }),
			),
		).toBe('too_large')
		expect(codeOf(() => store.appendMail('nope', 'alice', { from: 'lead', text: 'x' }))).toBe(
			'team_not_found',
		)
	})

	it('drops entries that do not match the schema, and prunes them from the file', () => {
		const { store } = team()
		const good = store.appendMail('t', 'alice', { from: 'lead', text: 'keep' })
		const path = store.inboxPath('t', 'alice')
		const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown[]
		writeFileSync(
			path,
			JSON.stringify([raw[0], { id: 'x' }, 'text', null, { ...(raw[0] as object), kind: 'bogus' }]),
		)
		expect(store.readMail('t', 'alice').map((e) => e.id)).toEqual([good.id])
		expect(store.pruneMail('t', 'alice')).toBe(4)
		expect((JSON.parse(readFileSync(path, 'utf8')) as unknown[]).length).toBe(1)
	})

	it('reads a mailbox that is not an array, or not JSON, as empty and repairs it on the next append', () => {
		const { store } = team()
		const path = store.inboxPath('t', 'alice')
		mkdirSync(join(store.teamDir('t'), 'inboxes'), { recursive: true })
		writeFileSync(path, '{"oops":true}')
		expect(store.readMail('t', 'alice')).toEqual([])
		writeFileSync(path, 'not json')
		expect(store.readMail('t', 'alice')).toEqual([])
		store.appendMail('t', 'alice', { from: 'lead', text: 'fresh' })
		expect(store.readMail('t', 'alice').map((e) => e.text)).toEqual(['fresh'])
	})

	it('hands each unread entry out once', () => {
		const { store } = team()
		const a = store.appendMail('t', 'alice', { from: 'lead', text: 'a' })
		store.appendMail('t', 'alice', { from: 'lead', text: 'b' })
		expect(store.drainMail('t', 'alice').map((e) => e.text)).toEqual(['a', 'b'])
		expect(store.drainMail('t', 'alice')).toEqual([])
		store.appendMail('t', 'alice', { from: 'lead', text: 'c' })
		expect(store.readMail('t', 'alice', { unreadOnly: true }).map((e) => e.text)).toEqual(['c'])
		expect(store.readMail('t', 'alice')).toHaveLength(3)
		expect(store.readMail('t', 'alice')[0]?.id).toBe(a.id)
		expect(store.drainMail('t', 'bob')).toEqual([])
	})

	it('marks named entries read', () => {
		const { store } = team()
		const a = store.appendMail('t', 'alice', { from: 'lead', text: 'a' })
		store.appendMail('t', 'alice', { from: 'lead', text: 'b' })
		store.markRead('t', 'alice', [a.id, 'unknown'])
		expect(store.readMail('t', 'alice', { unreadOnly: true }).map((e) => e.text)).toEqual(['b'])
		store.markRead('t', 'bob', [a.id])
	})

	it('prunes read mail down to the newest, and never unread mail', () => {
		const { store } = team()
		for (let i = 0; i < 5; i++) store.appendMail('t', 'alice', { from: 'lead', text: `r${i}` })
		store.drainMail('t', 'alice')
		store.appendMail('t', 'alice', { from: 'lead', text: 'unread' })
		expect(store.pruneMail('t', 'alice', { keepRead: 2 })).toBe(3)
		expect(store.readMail('t', 'alice').map((e) => e.text)).toEqual(['r3', 'r4', 'unread'])
		expect(store.pruneMail('t', 'bob')).toBe(0)
	})

	it('bounds a mailbox, dropping read entries first', () => {
		const { store } = team()
		const path = store.inboxPath('t', 'alice')
		const entries = Array.from({ length: MAX_MAIL_ENTRIES }, (_, i) => ({
			id: `m${i}`,
			from: 'lead',
			text: `t${i}`,
			at: new Date(0).toISOString(),
			...(i < 10 ? { read: true } : {}),
		}))
		store.appendMail('t', 'alice', { from: 'lead', text: 'seed' })
		writeFileSync(path, JSON.stringify(entries))
		store.appendMail('t', 'alice', { from: 'lead', text: 'new' })
		const after = store.readMail('t', 'alice')
		expect(after).toHaveLength(MAX_MAIL_ENTRIES)
		expect(after[0]?.id).toBe('m1')
		expect(after.at(-1)?.text).toBe('new')
	})
})

describe('TeamStore removal', () => {
	it('refuses writes to a removed team and does not bring its directory back', () => {
		const { store } = fixture()
		store.createTeam({ name: 't', leadSessionId: 's' })
		store.reserveMember('t', { name: 'alice' })
		expect(store.deleteTeam('t')).toBe(true)
		expect(store.deleteTeam('t')).toBe(false)
		expect(codeOf(() => store.reserveMember('t', { name: 'bob' }))).toBe('team_not_found')
		expect(codeOf(() => store.appendMail('t', 'alice', { from: 'lead', text: 'x' }))).toBe(
			'team_not_found',
		)
		expect(codeOf(() => store.setMemberActive('t', 'alice', false))).toBe('team_not_found')
		expect(store.rollbackMember('t', 'id')).toBe(false)
		expect(existsSync(store.teamDir('t'))).toBe(false)
	})

	it('does not recreate a directory when the team goes between the check and the write', () => {
		const { store } = fixture()
		store.createTeam({ name: 't', leadSessionId: 's' })
		store.reserveMember('t', { name: 'alice' })
		const path = store.inboxPath('t', 'alice')
		store.appendMail('t', 'alice', { from: 'lead', text: 'x' })
		store.deleteTeam('t')
		// A writer that passed its own checks earlier arrives at the lock after the removal.
		const racing = new TeamStore({ rootDir: store.rootDir, sleep: () => undefined })
		expect(
			codeOf(() =>
				(
					racing as unknown as {
						changeInbox: (t: string, p: string, c: (e: never[]) => never[]) => void
					}
				).changeInbox('t', path, (e) => e),
			),
		).toBe('team_not_found')
		expect(existsSync(store.teamDir('t'))).toBe(false)
	})

	it('does not remove a symlink or a plain file named like a team', () => {
		const { store, root } = fixture()
		store.createTeam({ name: 't', leadSessionId: 's' })
		writeFileSync(join(store.rootDir, 'plain'), 'x')
		expect(store.deleteTeam('plain')).toBe(false)
		expect(existsSync(join(store.rootDir, 'plain'))).toBe(true)
		expect(readdirSync(root)).toContain('teams')
	})
})

describe('TeamStore orphan sweep', () => {
	it('removes the team of a lead that is gone and keeps the others', () => {
		const alivePids = new Set([111])
		const { store } = fixture({ isProcessAlive: (pid) => alivePids.has(pid) })
		store.createTeam({ name: 'alive', leadSessionId: 'a', leadPid: 111 })
		store.createTeam({ name: 'dead', leadSessionId: 'b', leadPid: 222 })
		expect(store.sweepOrphans()).toEqual(['dead'])
		expect(store.listTeams()).toEqual(['alive'])
		expect(store.sweepOrphans()).toEqual([])
	})

	it('keeps a team that records no lead process', () => {
		const { store } = fixture({ isProcessAlive: () => false })
		const config = store.createTeam({ name: 't', leadSessionId: 's' })
		writeFileSync(store.configPath('t'), JSON.stringify({ ...config, leadPid: undefined }))
		expect(store.sweepOrphans()).toEqual([])
	})

	it('removes a directory without a readable config only after the grace period', () => {
		let now = Date.now()
		const { store } = fixture({ now: () => now })
		mkdirSync(join(store.rootDir, 'half'), { recursive: true })
		expect(store.sweepOrphans()).toEqual([])
		expect(existsSync(join(store.rootDir, 'half'))).toBe(true)
		now += 120_000
		expect(store.sweepOrphans()).toEqual(['half'])
		expect(existsSync(join(store.rootDir, 'half'))).toBe(false)
	})

	it('leaves entries that are not team directories alone', () => {
		let now = Date.now() + 10 * 60_000
		const { store } = fixture({ now: () => now })
		mkdirSync(store.rootDir, { recursive: true })
		writeFileSync(join(store.rootDir, 'file.txt'), 'x')
		mkdirSync(join(store.rootDir, '.hidden'))
		utimesSync(join(store.rootDir, '.hidden'), 0, 0)
		expect(store.sweepOrphans()).toEqual([])
		now += 1
		expect(existsSync(join(store.rootDir, '.hidden'))).toBe(true)
	})

	it('finds nothing to sweep when there is no teams directory', () => {
		const { store } = fixture()
		expect(store.sweepOrphans()).toEqual([])
		expect(store.listTeams()).toEqual([])
	})
})

describe('TeamStore hardening', () => {
	function team() {
		const f = fixture()
		f.store.createTeam({ name: 't', leadSessionId: 's' })
		f.store.reserveMember('t', { name: 'alice' })
		return f
	}

	it('refuses a mailbox name that is not a plain name, and leaves the config alone', () => {
		const { store } = team()
		const before = readFileSync(store.configPath('t'), 'utf8')
		for (const bad of ['..', '../config', '..\\config', '/etc/x', 'a/b', '../../x', '']) {
			expect(codeOf(() => store.readMail('t', bad))).toBe('bad_name')
			expect(codeOf(() => store.drainMail('t', bad))).toBe('bad_name')
			expect(codeOf(() => store.markRead('t', bad, []))).toBe('bad_name')
			expect(codeOf(() => store.pruneMail('t', bad))).toBe('bad_name')
			expect(codeOf(() => store.removeMember('t', bad))).toBe('bad_name')
		}
		expect(readFileSync(store.configPath('t'), 'utf8')).toBe(before)
		expect(store.readTeam('t')?.members).toHaveLength(1)
	})

	it('moves a corrupt mailbox aside instead of dropping its mail silently', () => {
		const { store } = team()
		const path = store.inboxPath('t', 'alice')
		store.appendMail('t', 'alice', { from: 'lead', text: 'one' })
		writeFileSync(path, '{not json')
		store.appendMail('t', 'alice', { from: 'lead', text: 'two' })
		expect(store.readMail('t', 'alice').map((e) => e.text)).toEqual(['two'])
		const aside = readdirSync(join(path, '..')).filter((n) => n.includes('.corrupt-'))
		expect(aside).toHaveLength(1)
		expect(readFileSync(join(path, '..', aside[0] as string), 'utf8')).toBe('{not json')
	})

	it('reads a zero-length mailbox as empty and keeps no corrupt copy', () => {
		const { store } = team()
		const path = store.inboxPath('t', 'alice')
		store.appendMail('t', 'alice', { from: 'lead', text: 'one' })
		writeFileSync(path, '')
		store.appendMail('t', 'alice', { from: 'lead', text: 'two' })
		expect(store.readMail('t', 'alice')).toHaveLength(1)
		expect(readdirSync(join(path, '..')).some((n) => n.includes('.corrupt-'))).toBe(false)
	})

	it('waits for the config of a team being created by the same lead instead of reporting team_exists', () => {
		const { root, store } = fixture()
		mkdirSync(join(root, 'teams', 't'), { recursive: true })
		const config = {
			version: 1,
			name: 't',
			leadSessionId: 's',
			leadPid: process.pid,
			createdAt: 1,
			members: [],
		}
		let slept = 0
		const racing = new TeamStore({
			rootDir: join(root, 'teams'),
			sleep: () => {
				slept++
				if (slept === 2)
					writeFileSync(join(root, 'teams', 't', 'config.json'), JSON.stringify(config))
			},
		})
		expect(racing.createTeam({ name: 't', leadSessionId: 's' }).leadSessionId).toBe('s')
		expect(slept).toBe(2)
		expect(store.readTeam('t')).toBeDefined()
	})
})
