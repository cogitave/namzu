import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MockLLMProvider } from '../../provider/mock.js'
import { DefaultPathBuilder } from '../../session/workspace/path-builder.js'
import type { ProjectId } from '../../types/session/ids.js'
import { asProjectId, isEntityId, projectIdForDirectory } from '../../utils/id.js'
import { runAgent } from '../runAgent.js'

/**
 * Runs in one directory share a Project unless the caller says otherwise.
 *
 * `runAgent` minted a Project per call. Every durable path is keyed by it
 * (`projects/<projectId>/sessions/…`), so a batch of runs in one directory —
 * an eval, a benchmark — left one Project tree per run: 79 of them, 250–500
 * MB each, on the machine where this was measured.
 */

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-project-identity-'))
	roots.push(root)
	return root
}

function run(workingDirectory: string, pathBuilder: DefaultPathBuilder, projectId?: ProjectId) {
	return runAgent({
		provider: new MockLLMProvider({ turns: [{ text: 'ok' }] }),
		model: 'mock-model',
		prompt: 'hi',
		workingDirectory,
		pathBuilder,
		...(projectId ? { projectId } : {}),
	})
}

describe('the Project a run is filed under', () => {
	it('is the same for every run in one directory', async () => {
		const root = await scratch()
		const work = join(root, 'work')
		await mkdir(work)
		const state = new DefaultPathBuilder(join(root, 'state'))

		const first = await run(work, state)
		const second = await run(work, state)

		expect(second.identity.projectId).toBe(first.identity.projectId)
		expect(second.identity.sessionId).not.toBe(first.identity.sessionId)
		expect(await readdir(join(root, 'state', 'projects'))).toEqual([first.identity.projectId])
	})

	it('differs between directories', async () => {
		const root = await scratch()
		await mkdir(join(root, 'a'))
		await mkdir(join(root, 'b'))
		const state = new DefaultPathBuilder(join(root, 'state'))

		const a = await run(join(root, 'a'), state)
		const b = await run(join(root, 'b'), state)
		expect(a.identity.projectId).not.toBe(b.identity.projectId)
	})

	it('is the one the caller passed, when it passed one', async () => {
		const root = await scratch()
		const chosen = asProjectId('0b8a3f4e-6f3a-4c2b-9d1e-7a5b3c2d1e0f')
		const result = await run(root, new DefaultPathBuilder(join(root, 'state')), chosen)
		expect(result.identity.projectId).toBe(chosen)
	})
})

describe('projectIdForDirectory', () => {
	it('is a valid, stable id that does not spell the path', async () => {
		const root = await scratch()
		const id = projectIdForDirectory(root)
		expect(isEntityId(id, 'project')).toBe(true)
		expect(projectIdForDirectory(root)).toBe(id)
		expect(projectIdForDirectory(`${root}/`)).toBe(id)
		expect(id).not.toContain('namzu')
	})

	it('treats a symlinked spelling as the same directory', async () => {
		const root = await scratch()
		const real = join(root, 'real')
		await mkdir(real)
		await symlink(real, join(root, 'alias'))
		expect(projectIdForDirectory(join(root, 'alias'))).toBe(projectIdForDirectory(real))
	})
})
