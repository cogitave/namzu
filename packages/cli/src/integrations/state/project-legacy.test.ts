import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
	type LegacyMoveResult,
	describeLegacyExclude,
	excludeProjectLegacy,
	moveProjectLegacyState,
	projectLegacyDestination,
} from './project-legacy.js'

// Real folders and real git, no timers: a hang is caught by Vitest's own
// per-test timeout, raised for the tests that run git several times.
const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(options: { trusted?: boolean } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-project-legacy-')))
	roots.push(root)
	const cwd = join(root, 'checkout')
	const home = join(root, 'home')
	mkdirSync(cwd)
	mkdirSync(home)
	if (options.trusted !== false) {
		writeFileSync(join(home, 'trust.json'), JSON.stringify({ version: 1, trusted: [cwd] }))
	}
	return { root, cwd, home }
}

function write(path: string, text: string): void {
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, text)
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		'git',
		['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
		{ cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
	)
}

function repository(cwd: string): void {
	git(cwd, 'init', '-q', '-b', 'main')
	write(join(cwd, 'README.md'), 'hello\n')
	git(cwd, 'add', 'README.md')
	git(cwd, 'commit', '-q', '-m', 'first')
}

/** Every path under `root` with its bytes, hashed. */
function treeHash(root: string, skip: (name: string) => boolean = () => false): string {
	const hash = createHash('sha256')
	const visit = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name)
			const rel = relative(root, path)
			if (skip(rel)) continue
			const stat = lstatSync(path)
			hash.update(`${rel}\0${stat.isDirectory() ? 'd' : 'f'}\0`)
			if (stat.isDirectory()) visit(path)
			else if (stat.isFile()) hash.update(readFileSync(path))
		}
	}
	visit(root)
	return hash.digest('hex')
}

type Done = Extract<LegacyMoveResult, { state: 'done' }>

function done(result: LegacyMoveResult): Done {
	if (result.state !== 'done') throw new Error(`expected a run, got ${JSON.stringify(result)}`)
	return result
}

const outcome = (result: Done, name: string) => result.outcomes.find((o) => o.name === name)

describe('moving state an earlier Namzu kept in a project', () => {
	it('moves only the old names, keeps the bytes, and records where they came from', async () => {
		const { cwd, home } = setup()
		write(join(cwd, '.namzu', 'sessions', 'a', 'session.json'), '{"old":1}')
		write(join(cwd, '.namzu', 'projects', 'prj_1', 'sessions', 'b.json'), '{"old":2}')
		write(join(cwd, '.namzu', 'cli.json'), '{"project":"prj_1"}')
		const before = treeHash(join(cwd, '.namzu'))

		const result = done(await moveProjectLegacyState({ cwd, home, now: () => 1_000 }))

		expect(result.destination).toBe(join(projectLegacyDestination(home, cwd), '1000'))
		expect(result.outcomes.map((o) => [o.name, o.kind])).toEqual([
			['cli.json', 'moved'],
			['projects', 'moved'],
			['sessions', 'moved'],
		])
		expect(readdirSync(join(cwd, '.namzu'))).toEqual([])
		// The same tree, byte for byte, now in the Namzu home.
		expect(treeHash(result.destination, (name) => name === 'origin.json')).toBe(before)
		expect(JSON.parse(readFileSync(join(result.destination, 'origin.json'), 'utf8'))).toMatchObject(
			{ v: 1, kind: 'project-legacy', from: join(cwd, '.namzu') },
		)
		if (process.platform !== 'win32') {
			expect(lstatSync(result.destination).mode & 0o777).toBe(0o700)
		}
	})

	it('leaves a folder with only what a person authors exactly as it was', async () => {
		const { cwd, home } = setup()
		write(join(cwd, '.namzu', 'skills', 'review', 'SKILL.md'), '# review')
		write(join(cwd, '.namzu', 'MEMORY.md'), '- use pnpm')
		write(join(cwd, '.namzu', 'settings.local.json'), '{}')
		const before = treeHash(join(cwd, '.namzu'))

		expect(await moveProjectLegacyState({ cwd, home })).toEqual({
			state: 'nothing',
			root: join(cwd, '.namzu'),
		})
		expect(treeHash(join(cwd, '.namzu'))).toBe(before)
		expect(existsSync(join(home, 'legacy'))).toBe(false)
	})

	it('moves the old names beside authored files and a file of the person’s own, and touches neither', async () => {
		const { cwd, home } = setup()
		write(join(cwd, '.namzu', 'checkpoints', 'c.json'), '{}')
		write(join(cwd, '.namzu', 'agents', 'reviewer.md'), '# reviewer')
		write(join(cwd, '.namzu', 'notes.txt'), 'mine')
		const kept = treeHash(join(cwd, '.namzu'), (name) => name.startsWith('checkpoints'))

		const result = done(await moveProjectLegacyState({ cwd, home }))

		expect(result.outcomes).toMatchObject([{ name: 'checkpoints', kind: 'moved' }])
		expect(treeHash(join(cwd, '.namzu'))).toBe(kept)
		expect(readFileSync(join(result.destination, 'checkpoints', 'c.json'), 'utf8')).toBe('{}')
	})

	it('says what would move with --dry-run and changes nothing', async () => {
		const { cwd, home } = setup()
		write(join(cwd, '.namzu', 'state', 'sessions.sqlite'), 'bytes')
		const before = treeHash(cwd)

		const result = done(await moveProjectLegacyState({ cwd, home, dryRun: true }))

		expect(result.dryRun).toBe(true)
		expect(result.outcomes).toMatchObject([{ name: 'state', kind: 'moved' }])
		expect(treeHash(cwd)).toBe(before)
		expect(existsSync(join(home, 'legacy'))).toBe(false)
	})

	it('refuses in a folder that is not trusted and changes nothing', async () => {
		const { cwd, home } = setup({ trusted: false })
		write(join(cwd, '.namzu', 'sessions', 'x.json'), '{}')
		const before = treeHash(cwd)

		const result = await moveProjectLegacyState({ cwd, home })

		expect(result).toMatchObject({ state: 'refused' })
		expect(result.state === 'refused' && result.reason).toContain('trust')
		expect(treeHash(cwd)).toBe(before)
		expect(existsSync(join(home, 'legacy'))).toBe(false)
	})

	it('refuses a .namzu that is a link, and one that holds the Namzu home', async () => {
		const { root, cwd, home } = setup()
		const elsewhere = join(root, 'elsewhere')
		write(join(elsewhere, 'sessions', 'x.json'), '{}')
		symlinkSync(elsewhere, join(cwd, '.namzu'), 'dir')
		expect(await moveProjectLegacyState({ cwd, home })).toMatchObject({ state: 'refused' })
		expect(existsSync(join(elsewhere, 'sessions', 'x.json'))).toBe(true)

		const other = join(root, 'other')
		write(join(other, '.namzu', 'sessions', 'x.json'), '{}')
		writeFileSync(
			join(other, '.namzu', 'trust.json'),
			JSON.stringify({ version: 1, trusted: [other] }),
		)
		expect(await moveProjectLegacyState({ cwd: other, home: join(other, '.namzu') })).toMatchObject(
			{ state: 'refused' },
		)
		expect(existsSync(join(other, '.namzu', 'sessions', 'x.json'))).toBe(true)
	})

	it('copies, compares and only then removes when the home is on another file system', async () => {
		const { cwd, home } = setup()
		write(join(cwd, '.namzu', 'projects', 'prj_1', 's.json'), '{"old":1}')
		write(join(cwd, '.namzu', 'titles.json'), '{"t":1}')
		const before = treeHash(join(cwd, '.namzu'))
		const crossDevice = async () => {
			throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
		}

		const result = done(await moveProjectLegacyState({ cwd, home, rename: crossDevice }))

		expect(result.outcomes.map((o) => o.kind === 'moved' && o.how)).toEqual(['copied', 'copied'])
		expect(readdirSync(join(cwd, '.namzu'))).toEqual([])
		expect(treeHash(result.destination, (name) => name === 'origin.json')).toBe(before)
	})

	it('keeps folder modes and times when it copies to another file system', async () => {
		const { cwd, home } = setup()
		write(join(cwd, '.namzu', 'projects', 'prj_1', 's.json'), '{"old":1}')
		const dir = join(cwd, '.namzu', 'projects', 'prj_1')
		chmodSync(dir, 0o750)
		const when = new Date('2020-01-02T03:04:05Z')
		utimesSync(dir, when, when)
		const crossDevice = async () => {
			throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
		}

		const result = done(await moveProjectLegacyState({ cwd, home, rename: crossDevice }))

		const copied = join(result.destination, 'projects', 'prj_1')
		expect(lstatSync(copied).mode & 0o777).toBe(0o750)
		expect(lstatSync(copied).mtime.getTime()).toBe(when.getTime())
	})

	it('keeps both when the copy does not match the original', async () => {
		const { cwd, home } = setup()
		write(join(cwd, '.namzu', 'sessions', 'x.json'), '{"old":1}')
		const crossDevice = async () => {
			throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
		}

		const result = done(
			await moveProjectLegacyState({
				cwd,
				home,
				rename: crossDevice,
				afterCopy: async (copy) => appendFile(join(copy, 'x.json'), 'changed'),
			}),
		)

		expect(outcome(result, 'sessions')).toMatchObject({ kind: 'kept' })
		expect(readFileSync(join(cwd, '.namzu', 'sessions', 'x.json'), 'utf8')).toBe('{"old":1}')
		expect(existsSync(join(result.destination, 'sessions', 'x.json'))).toBe(true)
	})

	it.runIf(process.platform !== 'win32')(
		'leaves a name that is not a file, a folder or a link',
		async () => {
			const { cwd, home } = setup()
			mkdirSync(join(cwd, '.namzu'))
			const fifo = spawnSync('mkfifo', [join(cwd, '.namzu', 'trust.json')])
			if (fifo.status !== 0) return
			write(join(cwd, '.namzu', 'goals', 'g.json'), '{}')

			const result = done(await moveProjectLegacyState({ cwd, home }))

			expect(outcome(result, 'trust.json')).toMatchObject({ kind: 'kept' })
			expect(outcome(result, 'goals')).toMatchObject({ kind: 'moved' })
			expect(existsSync(join(cwd, '.namzu', 'trust.json'))).toBe(true)
		},
	)

	it('moves each entry once when two moves run at the same time', async () => {
		const { cwd, home } = setup()
		for (const name of ['sessions', 'checkpoints', 'goals', 'feedback']) {
			write(join(cwd, '.namzu', name, 'x.json'), `{"${name}":1}`)
		}

		const results = await Promise.all([
			moveProjectLegacyState({ cwd, home, now: () => 5_000 }),
			moveProjectLegacyState({ cwd, home, now: () => 5_000 }),
		])

		// However the two interleave, each entry is moved by exactly one of them:
		// the other is refused by the lock, or finds what it planned already gone.
		const moved = results
			.flatMap((r) => (r.state === 'done' ? r.outcomes : []))
			.filter((o) => o.kind === 'moved')
			.map((o) => o.name)
			.sort()
		expect(moved).toEqual(['checkpoints', 'feedback', 'goals', 'sessions'])
		for (const result of results) {
			if (result.state === 'refused') expect(result.reason).toContain('Another Namzu')
			else if (result.state === 'done') {
				for (const o of result.outcomes) expect(['moved', 'gone']).toContain(o.kind)
			} else throw new Error(`unexpected ${result.state}`)
		}
		expect(readdirSync(join(cwd, '.namzu'))).toEqual([])
		const base = projectLegacyDestination(home, cwd)
		const runs = readdirSync(base).filter((name) => !name.endsWith('.lock'))
		expect(runs).toHaveLength(1)
		for (const name of ['sessions', 'checkpoints', 'goals', 'feedback']) {
			expect(readFileSync(join(base, runs[0] ?? '', name, 'x.json'), 'utf8')).toBe(`{"${name}":1}`)
		}
		expect(existsSync(`${base}.lock`)).toBe(false)
	})

	it('takes over the lock of a mover that died', async () => {
		const { cwd, home } = setup()
		write(join(cwd, '.namzu', 'sessions', 'x.json'), '{}')
		const base = projectLegacyDestination(home, cwd)
		mkdirSync(base, { recursive: true })
		// No process runs with this pid.
		writeFileSync(`${base}.lock`, '2147483646:0:dead\n')

		expect(done(await moveProjectLegacyState({ cwd, home })).outcomes).toMatchObject([
			{ name: 'sessions', kind: 'moved' },
		])
	})

	describe('in a git checkout', () => {
		it('leaves what git tracks and moves the rest', { timeout: 30_000 }, async () => {
			const { cwd, home } = setup()
			repository(cwd)
			write(join(cwd, '.namzu', 'sessions', 'tracked.json'), '{"t":1}')
			git(cwd, 'add', '.namzu/sessions/tracked.json')
			git(cwd, 'commit', '-q', '-m', 'oops')
			write(join(cwd, '.namzu', 'projects', 'prj_1', 's.json'), '{}')

			const result = done(await moveProjectLegacyState({ cwd, home }))

			expect(outcome(result, 'sessions')).toMatchObject({ kind: 'kept' })
			expect(
				outcome(result, 'sessions')?.kind === 'kept' && outcome(result, 'sessions'),
			).toMatchObject({
				reason: expect.stringContaining('git tracks'),
			})
			expect(outcome(result, 'projects')).toMatchObject({ kind: 'moved' })
			expect(readFileSync(join(cwd, '.namzu', 'sessions', 'tracked.json'), 'utf8')).toBe('{"t":1}')
		})

		it('keeps everything when git cannot say what it tracks', async () => {
			const { cwd, home } = setup()
			writeFileSync(join(cwd, '.git'), 'gitdir: /nowhere/at/all\n')
			write(join(cwd, '.namzu', 'sessions', 'x.json'), '{}')
			const before = treeHash(join(cwd, '.namzu'))

			const result = done(await moveProjectLegacyState({ cwd, home }))

			expect(result.outcomes).toMatchObject([{ name: 'sessions', kind: 'kept' }])
			expect(treeHash(join(cwd, '.namzu'))).toBe(before)
		})

		it(
			'moves a clean registered worktree with git and leaves one with changes',
			{ timeout: 60_000 },
			async () => {
				const { cwd, home } = setup()
				repository(cwd)
				git(cwd, 'worktree', 'add', '-q', '-b', 'clean', '.namzu/worktrees/clean')
				git(cwd, 'worktree', 'add', '-q', '-b', 'dirty', '.namzu/worktrees/dirty')
				writeFileSync(join(cwd, '.namzu', 'worktrees', 'dirty', 'README.md'), 'changed\n')
				write(join(cwd, '.namzu', 'worktrees', 'leftover', 'notes.txt'), 'plain folder')

				const result = done(await moveProjectLegacyState({ cwd, home }))

				expect(outcome(result, 'worktrees/clean')).toMatchObject({
					kind: 'moved',
					how: 'git-worktree-move',
				})
				expect(outcome(result, 'worktrees/dirty')).toMatchObject({ kind: 'kept' })
				expect(outcome(result, 'worktrees/leftover')).toMatchObject({
					kind: 'moved',
					how: 'renamed',
				})
				const list = git(cwd, 'worktree', 'list', '--porcelain')
				expect(list).toContain(`worktree ${join(result.destination, 'worktrees', 'clean')}`)
				expect(list).toContain(`worktree ${join(cwd, '.namzu', 'worktrees', 'dirty')}`)
				expect(readFileSync(join(cwd, '.namzu', 'worktrees', 'dirty', 'README.md'), 'utf8')).toBe(
					'changed\n',
				)
				// The moved worktree still works as one.
				expect(git(join(result.destination, 'worktrees', 'clean'), 'status', '--porcelain')).toBe(
					'',
				)
			},
		)
	})
})

describe('keeping git from listing the old state', () => {
	it('adds one anchored block to the clone’s exclude file, once', { timeout: 30_000 }, async () => {
		const { cwd } = setup()
		repository(cwd)
		write(join(cwd, '.namzu', 'sessions', 'x.json'), '{}')
		write(join(cwd, '.namzu', 'skills', 'review', 'SKILL.md'), '# review')

		const first = await excludeProjectLegacy({ cwd })
		const second = await excludeProjectLegacy({ cwd })

		expect(first).toMatchObject({ state: 'added', names: ['sessions'] })
		expect(second).toMatchObject({ state: 'present' })
		const exclude = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')
		expect(exclude.match(/# namzu: /g)).toHaveLength(1)
		expect(exclude).toContain('/.namzu/sessions\n')
		const status = git(cwd, 'status', '--porcelain', '--untracked-files=all')
		expect(status).not.toContain('.namzu/sessions')
		// What a person authors still shows, so it can be committed.
		expect(status).toContain('.namzu/skills/review/SKILL.md')
		expect(describeLegacyExclude(first)).toContain('namzu state move legacy')
		expect(describeLegacyExclude(second)).toBeUndefined()
	})

	it('anchors the block to a folder below the checkout root', { timeout: 30_000 }, async () => {
		const { cwd } = setup()
		repository(cwd)
		const sub = join(cwd, 'packages', 'app')
		write(join(sub, '.namzu', 'projects', 'prj_1', 's.json'), '{}')
		write(join(cwd, 'packages', 'other', '.namzu', 'projects', 'keep.json'), '{}')

		expect(await excludeProjectLegacy({ cwd: sub })).toMatchObject({ state: 'added' })
		const status = git(cwd, 'status', '--porcelain', '--untracked-files=all')
		expect(status).not.toContain('packages/app/.namzu/projects')
		expect(status).toContain('packages/other/.namzu/projects/keep.json')
	})

	it(
		'does nothing when the folder’s .namzu is the live Namzu home',
		{ timeout: 30_000 },
		async () => {
			const { cwd } = setup()
			repository(cwd)
			const live = join(cwd, '.namzu')
			write(join(live, 'projects', 'p', 's.json'), '{}')
			write(join(live, 'config.yaml'), 'a: 1\n')
			const before = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')

			expect(await excludeProjectLegacy({ cwd, home: live })).toEqual({ state: 'none' })
			expect(readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')).toBe(before)
		},
	)

	it('writes nothing where there is no old state, or no repository', async () => {
		const { cwd } = setup()
		repository(cwd)
		const before = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')
		expect(await excludeProjectLegacy({ cwd })).toEqual({ state: 'none' })
		expect(readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')).toBe(before)

		const plain = setup().cwd
		write(join(plain, '.namzu', 'sessions', 'x.json'), '{}')
		expect(await excludeProjectLegacy({ cwd: plain })).toEqual({ state: 'not-a-repository' })
	})
})
