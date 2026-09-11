import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generateProjectId, generateTenantId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { openSessions } from '../sessions/store.js'
import { loadIdentity } from '../state/identity.js'
import { type CliResident, createResident, lookupResident } from './storage.js'

let directory: string
let stateRoot: string
let workspace: string

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'namzu-resident-storage-'))
	stateRoot = join(directory, 'state')
	workspace = join(directory, 'workspace')
	mkdirSync(stateRoot)
	mkdirSync(workspace)
	vi.stubEnv('NAMZU_HOME', stateRoot)
})

afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(directory)
})

function bindingPath(resident: CliResident): string {
	return join(dirname(resident.artifactsRoot), 'binding.json')
}

function snapshot(path: string): unknown {
	return readdirSync(path, { recursive: true, encoding: 'utf8' })
		.sort()
		.map((entry) => {
			const fullPath = join(path, entry)
			const stat = lstatSync(fullPath)
			return {
				entry,
				mode: stat.mode,
				modified: stat.mtimeMs,
				...(stat.isFile() ? { content: readFileSync(fullPath, 'utf8') } : {}),
			}
		})
}

describe('CLI resident project storage', () => {
	it('reads an empty installation without minting identity, project or resident state', async () => {
		expect(await lookupResident(workspace, 'default')).toBeNull()
		expect(readdirSync(stateRoot)).toEqual([])
		expect(readdirSync(workspace)).toEqual([])
	})

	it('leaves an existing identity and project unchanged when no resident exists', async () => {
		loadIdentity(stateRoot)
		const identityOnly = snapshot(stateRoot)
		expect(await lookupResident(workspace, 'default')).toBeNull()
		expect(snapshot(stateRoot)).toEqual(identityOnly)

		await openSessions(workspace)
		const existingProject = snapshot(stateRoot)
		expect(await lookupResident(workspace, 'default')).toBeNull()
		expect(snapshot(stateRoot)).toEqual(existingProject)
	})

	it('creates private state with the existing project and tenant, without loading configuration', async () => {
		writeFileSync(join(stateRoot, 'config.yaml'), 'invalid: [configuration')
		const sessions = await openSessions(workspace)
		const resident = await createResident(workspace, 'default')

		expect(resident).toMatchObject({
			cwd: workspace,
			agentKey: 'default',
			root: stateRoot,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
			artifactsRoot: join(sessions.controlRoot, 'residents', 'default', 'attempts'),
		})
		expect(await resident.agenda.read()).toMatchObject({
			tenantId: sessions.tenantId,
			agentKey: 'default',
			identity:
				'Pursue only objectives explicitly added by this project’s operator. Respect project instructions and current tool permissions.',
			pursuits: [],
			revision: 1,
		})
		expect(JSON.parse(readFileSync(bindingPath(resident), 'utf8'))).toEqual({
			version: 1,
			tenantId: sessions.tenantId,
			projectId: sessions.projectId,
			agentKey: 'default',
			cwd: workspace,
		})
		expect(existsSync(join(workspace, '.namzu'))).toBe(false)
		if (process.platform !== 'win32') {
			for (const path of [
				join(sessions.controlRoot, 'residents'),
				dirname(resident.artifactsRoot),
				resident.artifactsRoot,
			]) {
				expect(statSync(path).mode & 0o777).toBe(0o700)
			}
			expect(statSync(bindingPath(resident)).mode & 0o777).toBe(0o600)
		}
		const before = snapshot(stateRoot)
		expect(await lookupResident(workspace, 'default')).toMatchObject({ cwd: workspace })
		expect(snapshot(stateRoot)).toEqual(before)
	})

	it('shares root, subdirectory and symlink lookups while retaining the first canonical cwd', async () => {
		mkdirSync(join(workspace, '.git'))
		const nested = join(workspace, 'packages', 'worker')
		mkdirSync(nested, { recursive: true })
		const alias = join(directory, 'alias')
		symlinkSync(nested, alias, process.platform === 'win32' ? 'junction' : 'dir')
		const first = await createResident(alias, 'default')
		const originalBinding = readFileSync(bindingPath(first), 'utf8')
		for (const cwd of [workspace, nested, alias]) {
			const found = await lookupResident(cwd, 'default')
			const created = await createResident(cwd, 'default')
			for (const resident of [found, created]) {
				expect(resident).toMatchObject({
					cwd: nested,
					projectId: first.projectId,
					tenantId: first.tenantId,
					artifactsRoot: first.artifactsRoot,
				})
			}
		}
		expect(readFileSync(bindingPath(first), 'utf8')).toBe(originalBinding)
	})

	it('concurrent creators return one immutable binding and one initialized agenda', async () => {
		mkdirSync(join(workspace, '.git'))
		const candidates = Array.from({ length: 8 }, (_, index) => join(workspace, `worker-${index}`))
		for (const candidate of candidates) mkdirSync(candidate)
		const residents = await Promise.all(candidates.map((cwd) => createResident(cwd, 'default')))
		const first = residents[0] as CliResident
		expect(candidates).toContain(first.cwd)
		for (const resident of residents) {
			expect(resident).toMatchObject({
				cwd: first.cwd,
				projectId: first.projectId,
				tenantId: first.tenantId,
			})
			expect(await resident.agenda.read()).toMatchObject({ revision: 1, pursuits: [] })
		}
		expect(JSON.parse(readFileSync(bindingPath(first), 'utf8')).cwd).toBe(first.cwd)
		expect(readdirSync(dirname(first.artifactsRoot)).sort()).toEqual(['attempts', 'binding.json'])
	})

	it('isolates agendas and artifacts by project and agent key', async () => {
		const otherWorkspace = join(directory, 'other-workspace')
		mkdirSync(otherWorkspace)
		const first = await createResident(workspace, 'default')
		const state = await first.agenda.read()
		if (!state) throw new Error('Fixture agenda was not initialized')
		await first.agenda.add(state, 'An objective only for the first resident')
		const otherKey = await createResident(workspace, 'reviewer')
		const otherProject = await createResident(otherWorkspace, 'default')
		expect(otherKey.projectId).toBe(first.projectId)
		expect(otherProject.projectId).not.toBe(first.projectId)
		for (const resident of [otherKey, otherProject]) {
			expect(resident.artifactsRoot).not.toBe(first.artifactsRoot)
			expect((await resident.agenda.read())?.pursuits).toEqual([])
		}
		expect((await first.agenda.read())?.pursuits).toHaveLength(1)
	})

	it('does not create missing attempts during lookup', async () => {
		const first = await createResident(workspace, 'default')
		renameSync(first.artifactsRoot, join(directory, 'old-attempts'))
		const before = snapshot(stateRoot)
		expect(await lookupResident(workspace, 'default')).toMatchObject({
			artifactsRoot: first.artifactsRoot,
		})
		expect(snapshot(stateRoot)).toEqual(before)
		expect(existsSync(first.artifactsRoot)).toBe(false)
	})

	it('reads a binding after execution cwd disappears without rebinding it', async () => {
		mkdirSync(join(workspace, '.git'))
		const nested = join(workspace, 'execution')
		mkdirSync(nested)
		const first = await createResident(nested, 'default')
		renameSync(nested, join(directory, 'moved-execution'))
		const before = snapshot(stateRoot)
		expect(await lookupResident(workspace, 'default')).toMatchObject({ cwd: nested })
		expect(snapshot(stateRoot)).toEqual(before)
		expect(await createResident(workspace, 'default')).toMatchObject({ cwd: nested })
		expect(JSON.parse(readFileSync(bindingPath(first), 'utf8')).cwd).toBe(nested)
	})

	it('returns a binding without an agenda read-only, and mutation finishes interrupted creation', async () => {
		const sessions = await openSessions(workspace)
		const agentRoot = join(sessions.controlRoot, 'residents', 'default')
		mkdirSync(agentRoot, { recursive: true })
		writeFileSync(
			join(agentRoot, 'binding.json'),
			JSON.stringify({
				version: 1,
				tenantId: sessions.tenantId,
				projectId: sessions.projectId,
				agentKey: 'default',
				cwd: workspace,
			}),
		)
		const before = snapshot(stateRoot)
		const found = await lookupResident(workspace, 'default')
		expect(found).not.toBeNull()
		expect(await found?.agenda.read()).toBeNull()
		expect(snapshot(stateRoot)).toEqual(before)
		const repaired = await createResident(workspace, 'default')
		expect((await repaired.agenda.read())?.revision).toBe(1)
		expect(existsSync(repaired.artifactsRoot)).toBe(true)
	})

	it.each(['', '../escape', 'Upper', '-bad', 'with space', 'a/b', 'a\\b', 'a\n', 'x'.repeat(65)])(
		'refuses unsafe agent keys before any filesystem work: %j',
		async (agentKey) => {
			vi.stubEnv('NAMZU_HOME', join(directory, 'missing-home'))
			await expect(lookupResident('/missing-cwd', agentKey)).rejects.toThrow(/agent key/)
			await expect(createResident('/missing-cwd', agentKey)).rejects.toThrow(/agent key/)
			expect(readdirSync(stateRoot)).toEqual([])
		},
	)

	it.each([
		'{broken',
		'null',
		'[]',
		'{}',
		{ version: 2 },
		{ tenantId: generateTenantId() },
		{ projectId: generateProjectId() },
		{ agentKey: 'another' },
		{ cwd: 'relative/directory' },
		{ cwd: null },
		{ cwd: '/contains\0nul' },
	])('refuses malformed or mismatched bindings without replacing them: %j', async (change) => {
		const first = await createResident(workspace, 'default')
		const path = bindingPath(first)
		const original = JSON.parse(readFileSync(path, 'utf8'))
		const corrupt = typeof change === 'string' ? change : JSON.stringify({ ...original, ...change })
		writeFileSync(path, corrupt)
		await expect(lookupResident(workspace, 'default')).rejects.toThrow(/resident binding/)
		await expect(createResident(workspace, 'default')).rejects.toThrow(/resident binding/)
		expect(readFileSync(path, 'utf8')).toBe(corrupt)
	})

	it('refuses execution cwd outside the bound project even when other metadata matches', async () => {
		const first = await createResident(workspace, 'default')
		const path = bindingPath(first)
		const original = JSON.parse(readFileSync(path, 'utf8'))
		writeFileSync(path, JSON.stringify({ ...original, cwd: directory }))
		await expect(lookupResident(workspace, 'default')).rejects.toThrow(/outside the bound project/)
		await expect(createResident(workspace, 'default')).rejects.toThrow(/outside the bound project/)
	})

	it('refuses a symbolic-link binding without following or replacing it', async () => {
		const first = await createResident(workspace, 'default')
		const path = bindingPath(first)
		const target = join(directory, 'binding-target.json')
		renameSync(path, target)
		symlinkSync(target, path, 'file')
		await expect(lookupResident(workspace, 'default')).rejects.toThrow(/regular file/)
		await expect(createResident(workspace, 'default')).rejects.toThrow(/regular file/)
		expect(lstatSync(path).isSymbolicLink()).toBe(true)
	})
})
