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

import { DiskSessionStore, UNKNOWN_TENANT_ID } from '@namzu/sdk'

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
		topicId: 'top_cli',
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
	it('reports canonical records, child runs, recovery files and only structurally isolated origin shells', async () => {
		const cwd = temporary('project')
		const home = temporary('home')
		const state = join(cwd, '.namzu')
		const projectId = 'prj_project'
		mkdirSync(join(state, 'projects', projectId), { recursive: true })
		chmodSync(join(state, 'projects'), 0o755)
		json(join(state, 'cli.json'), { projectId })
		json(join(state, 'projects', projectId, 'project.json'), {
			id: projectId,
			rootPath: cwd,
		})
		writeFileSync(join(cwd, 'namzu.config.json'), '{}\n')

		session(state, projectId, 'ses_candidate')
		const nonempty = session(state, projectId, 'ses_nonempty')
		writeFileSync(join(nonempty, 'messages.jsonl'), '{"message":true}\n')
		session(state, projectId, 'ses_source')
		session(state, projectId, 'ses_fork', {
			kind: 'fork',
			sourceSessionId: 'ses_source',
			copiedMessages: 0,
			turns: [],
		})

		const topRun = join(nonempty, 'runs', 'run_parent')
		const childRun = join(topRun, 'children', 'run_child')
		json(join(topRun, 'run.json'), { id: 'run_parent' })
		json(join(childRun, 'run.json'), { id: 'run_child' })
		json(join(topRun, 'checkpoints', 'cp_parent.json'), { id: 'cp_parent' })
		const largeCheckpoint = join(childRun, 'checkpoints', 'cp_large.json')
		mkdirSync(join(largeCheckpoint, '..'), { recursive: true })
		writeFileSync(largeCheckpoint, '')
		truncateSync(largeCheckpoint, 8 * 1024 * 1024)
		json(join(nonempty, 'runs', 'emergency', 'run_parent.json'), {
			id: 'esave_one',
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
		expect(report.projectBinding).toMatchObject({ status: 'bound', projectId })
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
		expect(project?.inventory.checkpointFiles.logicalBytes).toBeGreaterThanOrEqual(8 * 1024 * 1024)
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
	})

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
			{ tenantId: UNKNOWN_TENANT_ID, name: 'central', rootPath: cwd },
			UNKNOWN_TENANT_ID,
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
		const sessionDir = join(cwd, '.namzu', 'projects', 'prj_large', 'sessions', 'ses_large')
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
		const dir = session(state, 'prj_large', 'ses_large')
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
		const projectId = 'prj_relative'
		json(join(state, 'cli.json'), { projectId })
		json(join(state, 'projects', projectId, 'project.json'), {
			id: projectId,
			rootPath: '.',
		})

		const report = await inspectNamzuState({ cwd, home })

		expect(report.projectBinding).toMatchObject({ status: 'corrupt-project', projectId })
	})
})
