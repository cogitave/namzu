import {
	chmodSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { fixtureId } from '../../test-support/ids.js'
import { entityIdPattern } from '../../utils/id-format.js'
import {
	ProjectDocumentError,
	SessionPathError,
	SessionPaths,
	ensureProject,
	hashedSlugForCwd,
	slugForCwd,
	tempRoot,
} from '../paths.js'

const made: string[] = []
async function scratch(label: string): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), `namzu-paths-${label}-`)))
	made.push(dir)
	return dir
}
afterEach(async () => {
	await removeTempDirs(made.splice(0))
})

describe('slugForCwd', () => {
	it.each([
		['/home/ada/work/namzu', '-home-ada-work-namzu'],
		['C:\\Users\\ada\\namzu', 'C--Users-ada-namzu'],
		['\\\\server\\share\\repo', '--server-share-repo'],
		['/tmp/with space/ü', '-tmp-with-space--'],
	])('%s → %s', (cwd, slug) => {
		expect(slugForCwd(cwd)).toBe(slug)
	})

	it('never looks like a UUID, so it cannot be mistaken for a legacy project directory', () => {
		for (const cwd of ['/a', 'C:\\a', '\\\\h\\s', `/${fixtureId.project('p')}`]) {
			expect(entityIdPattern().test(slugForCwd(cwd))).toBe(false)
		}
	})

	it('bounds a very long path and keeps it distinct', () => {
		const long = `/${'deep/'.repeat(80)}a`
		const other = `/${'deep/'.repeat(80)}b`
		expect(slugForCwd(long)).toHaveLength(200)
		expect(slugForCwd(long)).not.toBe(slugForCwd(other))
	})

	it('derives the collision slug from the full path', () => {
		expect(hashedSlugForCwd('/a/b')).toMatch(/^-a-b-[0-9a-f]{8}$/)
		expect(hashedSlugForCwd('/a/b')).not.toBe(hashedSlugForCwd('/a-b'))
	})
})

describe('ensureProject', () => {
	it('mints project.json once and adopts it afterwards', async () => {
		const home = await scratch('home')
		const cwd = await scratch('cwd')
		const now = () => new Date('2026-09-21T09:00:00.000Z')
		const first = await ensureProject({ home, cwd, now })
		expect(first.created).toBe(true)
		expect(first.slug).toBe(slugForCwd(cwd))
		expect(first.projectDir).toBe(join(home, 'projects', first.slug))
		const document = JSON.parse(readFileSync(join(first.projectDir, 'project.json'), 'utf8'))
		expect(document).toEqual({
			v: 1,
			kind: 'project',
			projectId: first.projectId,
			cwd,
			slug: first.slug,
			createdAt: '2026-09-21T09:00:00.000Z',
		})
		expect(first.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
		const second = await ensureProject({ home, cwd })
		expect(second).toEqual({ ...first, created: false })
		// No temporary files are left beside the document.
		expect(readdirSync(first.projectDir)).toEqual(['project.json'])
	})

	it('canonicalises the directory, so a symlink names the same project', async () => {
		const home = await scratch('home')
		const cwd = await scratch('real')
		const link = join(await scratch('links'), 'alias')
		symlinkSync(cwd, link, 'dir')
		const viaLink = await ensureProject({ home, cwd: link })
		const direct = await ensureProject({ home, cwd })
		expect(viaLink.projectId).toBe(direct.projectId)
		expect(viaLink.cwd).toBe(cwd)
	})

	it('has exactly one winner when many callers race for one slug', async () => {
		const home = await scratch('home')
		const cwd = await scratch('cwd')
		const results = await Promise.all(
			Array.from({ length: 16 }, () => ensureProject({ home, cwd })),
		)
		expect(results.filter((r) => r.created)).toHaveLength(1)
		expect(new Set(results.map((r) => r.projectId)).size).toBe(1)
		expect(readdirSync(results[0]?.projectDir as string)).toEqual(['project.json'])
	})

	it('moves a different directory that slugs alike to the hashed slug', async () => {
		const home = await scratch('home')
		const cwd = await scratch('cwd')
		const slug = slugForCwd(cwd)
		mkdirSync(join(home, 'projects', slug), { recursive: true })
		writeFileSync(
			join(home, 'projects', slug, 'project.json'),
			JSON.stringify({
				v: 1,
				kind: 'project',
				projectId: fixtureId.project('squatter'),
				cwd: '/somewhere/else',
				slug,
				createdAt: '2026-01-01T00:00:00.000Z',
			}),
		)
		const project = await ensureProject({ home, cwd })
		expect(project.slug).toBe(hashedSlugForCwd(cwd))
		expect(project.created).toBe(true)
		expect(project.projectId).not.toBe(fixtureId.project('squatter'))
		expect((await ensureProject({ home, cwd })).slug).toBe(project.slug)
	})

	it('refuses a damaged project.json instead of overwriting it', async () => {
		const home = await scratch('home')
		const cwd = await scratch('cwd')
		const dir = join(home, 'projects', slugForCwd(cwd))
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'project.json'), '{"v":1')
		await expect(ensureProject({ home, cwd })).rejects.toThrow(ProjectDocumentError)
		writeFileSync(join(dir, 'project.json'), '{"v":9}')
		await expect(ensureProject({ home, cwd })).rejects.toThrow(/not a project document/)
		expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe('{"v":9}')
	})
})

describe('tempRoot', () => {
	it('uses the uid on POSIX and creates the directory private', async () => {
		if (typeof process.getuid !== 'function') return
		const base = await scratch('tmp')
		const root = tempRoot({ tmpdir: base })
		expect(root).toBe(join(base, `namzu-${process.getuid()}`))
		expect(tempRoot({ tmpdir: base })).toBe(root)
	})

	it('without getuid (win32) names the user by 12 hex digits of its hash and does not throw', async () => {
		const base = await scratch('tmp')
		const root = tempRoot({
			tmpdir: base,
			platform: 'win32',
			getuid: undefined,
			username: () => 'Ada Lovelace',
		})
		expect(root).toMatch(/namzu-[0-9a-f]{12}$/)
		expect(
			tempRoot({
				tmpdir: base,
				platform: 'win32',
				getuid: undefined,
				username: () => 'Ada Lovelace',
			}),
		).toBe(root)
	})

	it('falls back to a fixed segment when there is no user name either', async () => {
		const base = await scratch('tmp')
		const root = tempRoot({
			tmpdir: base,
			platform: 'win32',
			getuid: undefined,
			username: () => {
				throw new Error('no passwd entry')
			},
		})
		expect(root).toBe(join(base, 'namzu-user'))
	})

	it('refuses a symlinked root on POSIX and on win32', async () => {
		const base = await scratch('tmp')
		const target = await scratch('elsewhere')
		symlinkSync(target, join(base, 'namzu-1000'), 'dir')
		expect(() => tempRoot({ tmpdir: base, getuid: () => 1000 })).toThrow(/symbolic link/)
		symlinkSync(target, join(base, 'namzu-user'), 'dir')
		expect(() =>
			tempRoot({ tmpdir: base, platform: 'win32', getuid: undefined, username: () => '' }),
		).toThrow(SessionPathError)
	})

	it('refuses a root owned by another uid, or open to others', async () => {
		if (typeof process.getuid !== 'function') return
		const uid = process.getuid()
		const base = await scratch('tmp')
		mkdirSync(join(base, `namzu-${uid + 1}`), { mode: 0o700 })
		expect(() => tempRoot({ tmpdir: base, getuid: () => uid + 1 })).toThrow(/belongs to uid/)
		const open = join(base, `namzu-${uid}`)
		mkdirSync(open)
		chmodSync(open, 0o755)
		expect(() => tempRoot({ tmpdir: base, getuid: () => uid })).toThrow(/must be 700/)
	})

	it('refuses a file where the root should be', async () => {
		const base = await scratch('tmp')
		writeFileSync(join(base, 'namzu-7'), '')
		expect(() => tempRoot({ tmpdir: base, getuid: () => 7 })).toThrow(/not a directory/)
	})
})

describe('SessionPaths', () => {
	const home = '/n'
	const root = fixtureId.session('root')
	const child = fixtureId.session('child')
	const grandchild = fixtureId.session('grandchild')
	const paths = new SessionPaths({ home, slug: '-work-repo', tempRoot: '/t/namzu-1000' })
	const project = '/n/projects/-work-repo'

	it('lays out a root session beside its directory', () => {
		const at = { sessionId: root }
		expect(paths.indexFile()).toBe('/n/index.sqlite')
		expect(paths.projectFile()).toBe(`${project}/project.json`)
		expect(paths.memoryDir()).toBe(`${project}/memory`)
		expect(paths.sessionLog(at)).toBe(`${project}/${root}.jsonl`)
		expect(paths.sessionDir(at)).toBe(`${project}/${root}`)
		expect(paths.lease(at)).toBe(`${project}/${root}/lease.json`)
		expect(paths.checkpoints(at)).toBe(`${project}/${root}/checkpoints`)
		expect(paths.checkpointFile(at, fixtureId.checkpoint('c'))).toBe(
			`${project}/${root}/checkpoints/${fixtureId.checkpoint('c')}.json`,
		)
		expect(paths.budgetFile(at, fixtureId.turn('t'))).toBe(
			`${project}/${root}/budgets/${fixtureId.turn('t')}.json`,
		)
		expect(paths.taskFile(at, fixtureId.task('k'))).toBe(
			`${project}/${root}/tasks/${fixtureId.task('k')}.json`,
		)
		expect(paths.feedbackFile(at, fixtureId.message('m'))).toBe(
			`${project}/${root}/feedback/${fixtureId.message('m')}.json`,
		)
		expect(paths.goals(at)).toBe(`${project}/${root}/goals`)
		expect(paths.fileHistory(at)).toBe(`${project}/${root}/file-history`)
		expect(paths.toolResultFile(at, 'toolu_01')).toMatch(
			new RegExp(`^${project}/${root}/tool-results/[0-9a-f]{64}\\.txt$`),
		)
		expect(paths.tempDir(root)).toBe(`/t/namzu-1000/-work-repo/${root}/scratchpad`)
	})

	it('nests child sessions under subagents/, recursively', () => {
		const parent = { sessionId: root }
		expect(paths.subagentLog(parent, child)).toBe(`${project}/${root}/subagents/${child}.jsonl`)
		expect(paths.subagentMeta(parent, child)).toBe(
			`${project}/${root}/subagents/${child}.meta.json`,
		)
		const middle = { sessionId: child, ancestors: [root] }
		expect(paths.sessionDir(middle)).toBe(`${project}/${root}/subagents/${child}`)
		expect(paths.subagentLog(middle, grandchild)).toBe(
			`${project}/${root}/subagents/${child}/subagents/${grandchild}.jsonl`,
		)
		expect(paths.sessionLog({ sessionId: grandchild, ancestors: [root, child] })).toBe(
			paths.subagentLog(middle, grandchild),
		)
	})

	it('keeps worktrees and residents under the project', () => {
		expect(paths.worktrees()).toBe(`${project}/worktrees`)
		expect(paths.worktrees('fix-1')).toBe(`${project}/worktrees/fix-1`)
		expect(paths.residentDir('reviewer')).toBe(`${project}/residents/reviewer`)
	})

	it.each([
		['a non-UUID session', () => paths.sessionLog({ sessionId: '../x' as typeof root })],
		[
			'a non-UUID ancestor',
			() => paths.sessionLog({ sessionId: root, ancestors: ['..' as typeof root] }),
		],
		['a traversal label', () => paths.worktrees('../escape')],
		['a dotted label', () => paths.worktrees('a..b')],
		['an empty tool-use id', () => paths.toolResultFile({ sessionId: root }, '')],
		['a slashed agent key', () => paths.residentDir('a/b')],
	])('refuses %s as a path segment', (_name, build) => {
		expect(build).toThrow(SessionPathError)
	})

	it('refuses a slug that is not one plain segment', () => {
		expect(() => new SessionPaths({ home, slug: '../x' })).toThrow(SessionPathError)
		expect(() => new SessionPaths({ home, slug: '' })).toThrow(SessionPathError)
	})
})
