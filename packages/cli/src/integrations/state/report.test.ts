import { createHash } from 'node:crypto'
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { openSessions, startConversation } from '../sessions/store.js'
import { inspectNamzuState } from './report.js'

const roots: string[] = []

function temporary(label: string): string {
	const path = mkdtempSync(join(tmpdir(), `namzu-state-${label}-`))
	roots.push(path)
	return path
}

function write(path: string, contents: string): void {
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, contents, 'utf8')
}

/** Every path under `root` with its bytes, hashed: the tree's identity. */
function treeHash(root: string): string {
	const hash = createHash('sha256')
	const visit = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name)
			const stat = lstatSync(path)
			hash.update(`${relative(root, path)}\0${stat.mode}\0`)
			if (stat.isDirectory()) visit(path)
			else if (stat.isFile()) hash.update(readFileSync(path))
		}
	}
	visit(root)
	return hash.digest('hex')
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('read-only state inventory, version 2', () => {
	it('reports only UUID project directories and old top-level names as legacy, and changes nothing', async () => {
		const cwd = temporary('mixed-project')
		const home = temporary('mixed-os-home')
		const stateRoot = temporary('mixed-state')
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		sessions.index.close()
		// The old layout: a UUID project with a session tree, and old top-level names.
		const oldProject = 'c9e2190e-7298-4132-a0d7-f7d1ebc2341b'
		write(join(stateRoot, 'projects', oldProject, 'sessions', 'x', 'session.json'), '{"old":1}')
		write(join(stateRoot, 'state', 'sessions.sqlite'), 'sqlite bytes')
		write(join(stateRoot, 'titles.json'), '{}')
		write(join(stateRoot, 'memory', 'p', 'MEMORY.md'), '# memory')
		const before = treeHash(stateRoot)

		const report = await inspectNamzuState({ cwd, home, env: { NAMZU_HOME: stateRoot } })

		expect(treeHash(stateRoot)).toBe(before)
		expect(report.version).toBe(2)
		const user = report.roots.find((root) => root.roles.includes('user'))
		expect(user?.legacy.map((entry) => entry.path)).toEqual([
			'memory',
			`projects/${oldProject}`,
			'state',
			'titles.json',
		])
		expect(user?.legacy.find((entry) => entry.path === `projects/${oldProject}`)).toMatchObject({
			kind: 'uuid-project',
			files: 1,
			logicalBytes: 9,
		})
		expect(user?.legacy.some((entry) => entry.path.includes(sessions.slug))).toBe(false)
		expect(user?.categories.legacy.files).toBe(4)
		expect(user?.inventory).toMatchObject({ projects: 1, sessionLogs: { files: 1 } })
		expect(report.projectBinding).toMatchObject({
			status: 'bound',
			slug: sessions.slug,
			projectId: sessions.projectId,
		})
		expect(id).toBeTruthy()
	})

	it('counts what move-legacy put under the home’s legacy folder as legacy, not unknown', async () => {
		const cwd = temporary('moved-cwd')
		const home = temporary('moved-os-home')
		const stateRoot = temporary('moved-state')
		write(join(stateRoot, 'legacy', 'slug', '1', 'sessions', 'x.json'), '{}')

		const report = await inspectNamzuState({ cwd, home, env: { NAMZU_HOME: stateRoot } })

		const user = report.roots.find((root) => root.roles.includes('user'))
		expect(user?.categories.legacy.files).toBe(1)
		expect(user?.categories.unknown.files).toBe(0)
	})

	it('deduplicates project and user roles when cwd is home', async () => {
		const root = temporary('overlap')
		mkdirSync(join(root, '.namzu'), { recursive: true })
		writeFileSync(join(root, '.namzu', 'preferences.json'), '1234567')

		const report = await inspectNamzuState({ cwd: root, home: root })

		expect(report.scopeRoots.overlap).toBe(true)
		expect(report.roots).toHaveLength(1)
		expect(report.roots[0]?.roles).toEqual(['project', 'user'])
		expect(report.physicalTotals).toEqual({ roots: 1, files: 1, logicalBytes: 7 })
	})

	it('does not create either state root while reporting an uninitialized machine', async () => {
		const cwd = temporary('absent-project')
		const home = temporary('absent-home')
		const beforeProject = readdirSync(cwd)
		const beforeHome = readdirSync(home)

		const report = await inspectNamzuState({ cwd, home })

		expect(report.complete).toBe(true)
		expect(report.physicalTotals).toEqual({ roots: 0, files: 0, logicalBytes: 0 })
		expect(report.projectBinding).toMatchObject({ status: 'uninitialized' })
		expect(readdirSync(cwd)).toEqual(beforeProject)
		expect(readdirSync(home)).toEqual(beforeHome)
	})

	it('classifies project-local skills as authored input rather than unknown runtime state', async () => {
		const cwd = temporary('authored-skills')
		const home = temporary('authored-skills-home')
		mkdirSync(join(cwd, '.namzu', 'skills', 'review'), { recursive: true })
		writeFileSync(join(cwd, '.namzu', 'skills', 'review', 'SKILL.md'), '# Review\n')

		const report = await inspectNamzuState({ cwd, home })
		const project = report.roots.find((root) => root.roles.includes('project'))

		expect(project?.categories.authored).toMatchObject({ files: 1 })
		expect(project?.categories.unknown).toEqual({ files: 0, logicalBytes: 0 })
	})

	it('counts the recovery copies and the account and approval files as configuration', async () => {
		const cwd = temporary('backups')
		const home = temporary('backups-home')
		write(join(home, '.namzu', 'backups', 'trust.json.backup.1'), '{}')
		write(join(home, '.namzu', 'backups', 'trust.json.corrupted.2'), '{')
		write(join(home, '.namzu', 'accounts.json'), '{}')
		write(join(home, '.namzu', 'mcp-approvals.json'), '{}')

		const report = await inspectNamzuState({ cwd, home })
		const user = report.roots.find((root) => root.roles.includes('user'))

		expect(user?.categories.configuration).toMatchObject({ files: 4 })
		expect(user?.categories.unknown).toEqual({ files: 0, logicalBytes: 0 })
	})

	it('counts everything an earlier Namzu wrote in a project folder as legacy, cli.json and projects/ included', async () => {
		const cwd = temporary('project-legacy')
		const home = temporary('project-legacy-home')
		const state = join(cwd, '.namzu')
		// The project-local layout before state moved to the Namzu home.
		write(join(state, 'cli.json'), '{"project":"prj_1"}')
		write(join(state, 'projects', 'prj_1', 'sessions', 's', 'session.json'), '{"old":1}')
		write(join(state, 'worktrees', 'job', 'a.ts'), 'x')
		// What a person authors, and the project's settings files.
		write(join(state, 'skills', 'review', 'SKILL.md'), '# review')
		write(join(state, 'rules', 'style.md'), '# style')
		write(join(state, 'settings.json'), '{}')
		write(join(state, 'settings.local.json'), '{}')
		// A name no Namzu wrote is the person's own: unknown, never legacy.
		write(join(state, 'notes.txt'), 'mine')
		const before = treeHash(state)

		const report = await inspectNamzuState({ cwd, home })
		const project = report.roots.find((root) => root.roles.includes('project'))

		expect(treeHash(state)).toBe(before)
		expect(project?.legacy.map((entry) => [entry.path, entry.kind])).toEqual([
			['cli.json', 'top-level'],
			['projects', 'top-level'],
			['worktrees', 'top-level'],
		])
		expect(project?.categories).toMatchObject({
			legacy: { files: 3 },
			authored: { files: 2 },
			configuration: { files: 2 },
			unknown: { files: 1 },
			runtime: { files: 0 },
		})
	})

	it('does not call the memory curation log in the Namzu home legacy', async () => {
		const cwd = temporary('curation-project')
		const home = temporary('curation-home')
		const stateRoot = temporary('curation-state')
		write(join(stateRoot, 'memory', 'curation.jsonl'), '{}\n')

		const report = await inspectNamzuState({ cwd, home, env: { NAMZU_HOME: stateRoot } })
		const user = report.roots.find((root) => root.roles.includes('user'))

		expect(user?.legacy).toEqual([])
		expect(user?.categories.runtime).toMatchObject({ files: 1 })
	})

	it('reports a project document that does not parse as corrupt, by slug', async () => {
		const cwd = temporary('corrupt-binding')
		const home = temporary('corrupt-binding-home')
		const stateRoot = temporary('corrupt-binding-state')
		const sessions = await openSessions(cwd, { stateRoot })
		sessions.index.close()
		writeFileSync(join(stateRoot, 'projects', sessions.slug, 'project.json'), '{ not json')

		const report = await inspectNamzuState({ cwd, home, env: { NAMZU_HOME: stateRoot } })

		expect(report.projectBinding).toMatchObject({ status: 'corrupt-project', slug: sessions.slug })
	})

	it('does not follow a symlink outside the state root and marks the snapshot incomplete', async () => {
		const cwd = temporary('symlink-project')
		const home = temporary('symlink-home')
		const outside = temporary('symlink-outside')
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(join(outside, 'secret'), 'not counted')
		symlinkSync(join(outside, 'secret'), join(cwd, '.namzu', 'evil\u001b‮'))

		const report = await inspectNamzuState({ cwd, home })
		const project = report.roots.find((root) => root.roles.includes('project'))

		expect(report.complete).toBe(false)
		expect(project?.logicalBytes).toBe(0)
		expect(project?.issues).toContainEqual(
			expect.objectContaining({ code: 'symlink_not_followed' }),
		)
	})

	it('bounds filesystem enumeration and reports an honestly partial inventory', async () => {
		const cwd = temporary('entry-limit-project')
		const home = temporary('entry-limit-home')
		const state = join(cwd, '.namzu')
		mkdirSync(state, { recursive: true })
		for (const name of ['one', 'two', 'three']) writeFileSync(join(state, name), name)

		const report = await inspectNamzuState({ cwd, home, entryLimit: 2 })
		const project = report.roots.find((root) => root.roles.includes('project'))

		expect(report.complete).toBe(false)
		expect(project?.files).toBe(2)
		expect(project?.issues).toContainEqual(
			expect.objectContaining({
				code: 'inspection_skipped',
				detail: expect.stringContaining('2-entry memory bound'),
			}),
		)
	})

	it.runIf(process.platform !== 'win32')(
		'reports a projects boundary open to other users as insecure',
		async () => {
			const cwd = temporary('privacy-project')
			const home = temporary('privacy-home')
			const stateRoot = temporary('privacy-state')
			chmodSync(stateRoot, 0o755)
			mkdirSync(join(stateRoot, 'projects'), { mode: 0o755 })
			chmodSync(join(stateRoot, 'projects'), 0o755)

			const report = await inspectNamzuState({ cwd, home, env: { NAMZU_HOME: stateRoot } })
			const user = report.roots.find((root) => root.roles.includes('user'))

			expect(user?.privacy).toContainEqual(
				expect.objectContaining({ path: 'projects', status: 'insecure' }),
			)
		},
	)
})
