import { randomUUID } from 'node:crypto'
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadIdentity } from './identity.js'

import { DiskSessionStore } from '@namzu/sdk'

import { inspectNamzuState } from './report.js'

const roots: string[] = []

function temporary(label: string): string {
	const path = mkdtempSync(join(tmpdir(), `namzu-state-${label}-`))
	roots.push(path)
	return path
}

function json(path: string, value: unknown): void {
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
}

function session(
	root: string,
	projectId: string,
	sessionId: string,
	origin: Record<string, unknown> = { kind: 'new' },
): string {
	const dir = join(root, 'projects', projectId, 'sessions', sessionId)
	mkdirSync(dir, { recursive: true })
	json(join(dir, 'session.json'), {
		id: sessionId,
		projectId,
		topicId: '889a000d-16f9-46e1-9033-87d8e5927609',
		tenantId: 'ten_unknown',
	})
	writeFileSync(
		join(dir, 'turns.jsonl'),
		`${JSON.stringify({
			format: 'namzu.cli-turn-evidence.v1',
			type: 'conversation_started',
			projectId,
			sessionId,
			recordedAt: 1,
			origin,
		})}\n`,
		'utf8',
	)
	return dir
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('read-only state inventory', () => {
	it.each(['legacy', 'uuid', 'mixed'])(
		'reports canonical records, child runs and recovery files with %s ids',
		async (format) => {
			const cwd = temporary('project')
			const home = temporary('home')
			const state = join(cwd, '.namzu')
			const id = (legacy: string): string =>
				format === 'uuid' || (format === 'mixed' && legacy.startsWith('run_'))
					? randomUUID()
					: legacy
			const projectId = id('66d4ce64-d2ff-431b-9118-21526c08e843')
			const candidateId = id('a3baf845-eb6b-4e1e-bdcf-6eb7796a4ce4')
			const nonemptyId = id('cfcefaba-ff1d-4aa3-8128-9e4c4e6c7c9f')
			const sourceId = id('be4aded1-82e6-4494-9caf-334514c0ac8e')
			const forkId = id('4e1542d3-722a-4a72-bcd6-238e44c0da82')
			const parentRunId = id('c0250b29-330b-445f-b11d-2926ffd9059c')
			const childRunId = id('4721e070-5ba2-425a-bf5a-8cc927907e9a')
			const parentCheckpointId = id('dfbbd9ea-62c0-47fd-a21f-4d133b931c27')
			const childCheckpointId = id('d78abd23-164b-4f72-8766-6987ad7e97ef')
			mkdirSync(join(state, 'projects', projectId), { recursive: true })
			chmodSync(join(state, 'projects'), 0o755)
			json(join(state, 'cli.json'), { projectId })
			json(join(state, 'projects', projectId, 'project.json'), {
				id: projectId,
				rootPath: cwd,
			})
			writeFileSync(join(cwd, 'namzu.config.json'), '{}\n')

			session(state, projectId, candidateId)
			const nonempty = session(state, projectId, nonemptyId)
			writeFileSync(join(nonempty, 'messages.jsonl'), '{"message":true}\n')
			session(state, projectId, sourceId)
			session(state, projectId, forkId, {
				kind: 'fork',
				sourceSessionId: sourceId,
				copiedMessages: 0,
				turns: [],
			})

			const topRun = join(nonempty, 'runs', parentRunId)
			const childRun = join(topRun, 'children', childRunId)
			json(join(topRun, 'run.json'), { id: parentRunId })
			json(join(childRun, 'run.json'), { id: childRunId })
			json(join(topRun, 'checkpoints', `${parentCheckpointId}.json`), {
				id: parentCheckpointId,
			})
			const largeCheckpoint = join(childRun, 'checkpoints', `${childCheckpointId}.json`)
			mkdirSync(join(largeCheckpoint, '..'), { recursive: true })
			writeFileSync(largeCheckpoint, '')
			truncateSync(largeCheckpoint, 8 * 1024 * 1024)
			json(join(nonempty, 'runs', 'emergency', `${parentRunId}.json`), {
				id: '776e5308-a9c1-4de6-91c4-164ebeabbc95',
			})

			const attachments = join(home, '.namzu', 'attachments', 'aa')
			mkdirSync(attachments, { recursive: true })
			writeFileSync(join(attachments, 'pair.bin'), 'bytes')
			writeFileSync(join(attachments, 'pair.type'), 'image/png')
			writeFileSync(join(attachments, 'data-only.bin'), 'bytes')
			writeFileSync(join(attachments, 'type-only.type'), 'image/png')

			const report = await inspectNamzuState({
				cwd,
				home,
				platform: 'linux',
				uid: process.getuid?.(),
			})
			const project = report.roots.find((root) => root.roles.includes('project'))
			const user = report.roots.find((root) => root.roles.includes('user'))

			expect(report.complete).toBe(true)
			expect(report.physicalTotals.roots).toBe(2)
			expect(report.projectBinding).toMatchObject({
				status: 'bound',
				projectId,
			})
			expect(report.projectConfig).toMatchObject({ status: 'present' })
			expect(project?.inventory.sessions).toMatchObject({
				files: 4,
				directories: 4,
				invalidOrMissingRecords: 0,
			})
			expect(project?.inventory.runs).toMatchObject({
				files: 2,
				directories: 2,
				invalidOrMissingRecords: 0,
			})
			expect(project?.inventory.checkpointFiles).toEqual({
				files: 2,
				logicalBytes: expect.any(Number),
			})
			expect(project?.inventory.checkpointFiles.logicalBytes).toBeGreaterThanOrEqual(
				8 * 1024 * 1024,
			)
			expect(project?.inventory.emergencyDumpFiles.files).toBe(1)
			expect(project?.inventory.originOnlySessionCandidates).toMatchObject({
				files: 1,
				complete: true,
			})
			expect(project?.inventory.originOnlySessionCandidates.logicalBytes).toBeGreaterThan(0)
			expect(project?.privacy).toContainEqual(
				expect.objectContaining({ path: 'projects', status: 'insecure' }),
			)
			expect(user?.inventory.attachments).toMatchObject({
				files: 4,
				pairs: 1,
				orphanedDataFiles: 1,
				orphanedTypeFiles: 1,
			})
		},
	)

	it('deduplicates project and user roles when cwd is home', async () => {
		const root = temporary('overlap')
		mkdirSync(join(root, '.namzu'), { recursive: true })
		writeFileSync(join(root, '.namzu', 'preferences.json'), '1234567')

		const report = await inspectNamzuState({ cwd: root, home: root })

		expect(report.scopeRoots.overlap).toBe(true)
		expect(report.roots).toHaveLength(1)
		expect(report.roots[0]?.roles).toEqual(['project', 'user'])
		expect(report.physicalTotals).toEqual({
			roots: 1,
			files: 1,
			logicalBytes: 7,
		})
	})

	it('does not create either state root while reporting an uninitialized machine', async () => {
		const cwd = temporary('absent-project')
		const home = temporary('absent-home')
		const beforeProject = readdirSync(cwd)
		const beforeHome = readdirSync(home)

		const report = await inspectNamzuState({ cwd, home })

		expect(report.complete).toBe(true)
		expect(report.physicalTotals).toEqual({
			roots: 0,
			files: 0,
			logicalBytes: 0,
		})
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
		expect(report.projectBinding).toMatchObject({ status: 'uninitialized' })
	})

	it('honors NAMZU_HOME and reports the central Project bound to this workspace', async () => {
		const cwd = temporary('central-project')
		const home = temporary('central-os-home')
		const stateRoot = temporary('central-override')
		const project = await new DiskSessionStore({ rootDir: stateRoot }).createProject(
			{ tenantId: loadIdentity(stateRoot).tenantId, name: 'central', rootPath: cwd },
			loadIdentity(stateRoot).tenantId,
		)

		const report = await inspectNamzuState({
			cwd,
			home,
			env: { NAMZU_HOME: stateRoot },
		})

		expect(report.scopeRoots.user).toBe(stateRoot)
		expect(report.projectBinding).toMatchObject({
			status: 'bound',
			projectId: project.id,
		})
		expect(readdirSync(cwd)).toEqual([])
	})

	it('does not follow a symlink outside the state root and marks the snapshot incomplete', async () => {
		const cwd = temporary('symlink-project')
		const home = temporary('symlink-home')
		const outside = temporary('symlink-outside')
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(join(outside, 'secret'), 'not counted')
		symlinkSync(join(outside, 'secret'), join(cwd, '.namzu', 'evil\u001b\u202e'))

		const report = await inspectNamzuState({ cwd, home })
		const project = report.roots.find((root) => root.roles.includes('project'))

		expect(report.complete).toBe(false)
		expect(project?.logicalBytes).toBe(0)
		expect(project?.issues).toContainEqual(
			expect.objectContaining({ code: 'symlink_not_followed' }),
		)
	})

	it('counts oversized metadata bytes but skips semantic validation instead of parsing it', async () => {
		const cwd = temporary('oversized-project')
		const home = temporary('oversized-home')
		const sessionDir = join(
			cwd,
			'.namzu',
			'projects',
			'7c2d1c6c-3338-4280-9d19-3be9efe7ad80',
			'sessions',
			'77849dcc-64a7-483e-8ae4-6c123112cd93',
		)
		mkdirSync(sessionDir, { recursive: true })
		const record = join(sessionDir, 'session.json')
		writeFileSync(record, '')
		truncateSync(record, 5 * 1024 * 1024)

		const report = await inspectNamzuState({ cwd, home })
		const project = report.roots.find((root) => root.roles.includes('project'))

		expect(report.complete).toBe(false)
		expect(project?.logicalBytes).toBe(5 * 1024 * 1024)
		expect(project?.inventory.sessions).toMatchObject({
			files: 0,
			directories: 1,
			invalidOrMissingRecords: 1,
		})
		expect(project?.issues).toContainEqual(
			expect.objectContaining({
				code: 'inspection_skipped',
				path: expect.stringContaining('session.json'),
			}),
		)
	})

	it('marks candidate analysis incomplete when turn evidence exceeds its smaller inspection cap', async () => {
		const cwd = temporary('oversized-origin-project')
		const home = temporary('oversized-origin-home')
		const state = join(cwd, '.namzu')
		const dir = session(
			state,
			'7c2d1c6c-3338-4280-9d19-3be9efe7ad80',
			'77849dcc-64a7-483e-8ae4-6c123112cd93',
		)
		const evidence = join(dir, 'turns.jsonl')
		truncateSync(evidence, 65 * 1024)

		const report = await inspectNamzuState({ cwd, home })
		const project = report.roots.find((root) => root.roles.includes('project'))

		expect(report.complete).toBe(false)
		expect(project?.inventory.originOnlySessionCandidates).toMatchObject({
			files: 0,
			complete: false,
		})
		expect(project?.issues).toContainEqual(
			expect.objectContaining({
				code: 'inspection_skipped',
				path: expect.stringContaining('turns.jsonl'),
			}),
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

	it('does not accept a relative project root as a canonical binding', async () => {
		const cwd = temporary('relative-root-project')
		const home = temporary('relative-root-home')
		const state = join(cwd, '.namzu')
		const projectId = 'a70a2aef-9d30-408e-b51a-b4517fe936d5'
		json(join(state, 'cli.json'), { projectId })
		json(join(state, 'projects', projectId, 'project.json'), {
			id: projectId,
			rootPath: '.',
		})

		const report = await inspectNamzuState({ cwd, home })

		expect(report.projectBinding).toMatchObject({ status: 'corrupt-project', projectId })
	})
})
