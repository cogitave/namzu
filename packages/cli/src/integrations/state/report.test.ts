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
