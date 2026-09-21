import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MockLLMProvider } from '../../provider/mock.js'
import { SessionPaths, slugForCwd } from '../../session/paths.js'
import { InMemorySessionLog } from '../../store/session-log/index.js'
import type { ProjectId } from '../../types/session/ids.js'
import { asProjectId, generateSessionId, isEntityId } from '../../utils/id.js'
import { runAgent } from '../runAgent.js'

/**
 * Turns in one directory share a Project unless the caller says otherwise.
 *
 * `runAgent` once minted a Project per call, so a batch of runs in one
 * directory — an eval, a benchmark — left one Project tree per turn. The
 * project is now the one `~/.namzu/projects/<slug>/project.json` names,
 * minted once for the directory (spec §3.2).
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

async function pathsFor(home: string, workingDirectory: string): Promise<SessionPaths> {
	return new SessionPaths({ home, slug: slugForCwd(await realpath(workingDirectory)) })
}

async function run(workingDirectory: string, paths: SessionPaths, projectId?: ProjectId) {
	return runAgent({
		provider: new MockLLMProvider({ turns: [{ text: 'ok' }] }),
		model: 'mock-model',
		prompt: 'hi',
		workingDirectory,
		paths,
		...(projectId ? { projectId } : {}),
	})
}

describe('the Project a turn is filed under', () => {
	it('is the same for every turn in one directory, and is the one project.json names', async () => {
		const root = await scratch()
		const work = join(root, 'work')
		await mkdir(work)
		const home = join(root, 'home')
		const paths = await pathsFor(home, work)

		const first = await run(work, paths)
		const second = await run(work, paths)

		expect(second.identity.projectId).toBe(first.identity.projectId)
		expect(second.identity.sessionId).not.toBe(first.identity.sessionId)
		expect(await readdir(join(home, 'projects'))).toEqual([paths.slug])
		const document = JSON.parse(await readFile(paths.projectFile(), 'utf8'))
		expect(document).toMatchObject({ v: 1, kind: 'project', projectId: first.identity.projectId })
		expect(isEntityId(first.identity.projectId, 'project')).toBe(true)
	})

	it('differs between directories', async () => {
		const root = await scratch()
		await mkdir(join(root, 'a'))
		await mkdir(join(root, 'b'))
		const home = join(root, 'home')

		const a = await run(join(root, 'a'), await pathsFor(home, join(root, 'a')))
		const b = await run(join(root, 'b'), await pathsFor(home, join(root, 'b')))
		expect(a.identity.projectId).not.toBe(b.identity.projectId)
	})

	it('treats a symlinked spelling as the same directory', async () => {
		const root = await scratch()
		const real = join(root, 'real')
		await mkdir(real)
		await symlink(real, join(root, 'alias'))
		const home = join(root, 'home')
		const paths = await pathsFor(home, real)

		const viaReal = await run(real, paths)
		const viaAlias = await run(join(root, 'alias'), paths)
		expect(viaAlias.identity.projectId).toBe(viaReal.identity.projectId)
	})

	it('is the one the caller passed, when it passed one', async () => {
		const root = await scratch()
		const chosen = asProjectId('0b8a3f4e-6f3a-4c2b-9d1e-7a5b3c2d1e0f')
		const result = await run(
			root,
			new SessionPaths({ home: join(root, 'home'), slug: '-x' }),
			chosen,
		)
		expect(result.identity.projectId).toBe(chosen)
	})

	it('refuses paths that name another project than the working directory', async () => {
		const root = await scratch()
		await expect(
			run(root, new SessionPaths({ home: join(root, 'home'), slug: '-somewhere-else' })),
		).rejects.toThrow(/Pass projectId/)
	})

	it('writes nothing for a session held in memory', async () => {
		const root = await scratch()
		const sessionId = generateSessionId()
		const result = await runAgent({
			provider: new MockLLMProvider({ turns: [{ text: 'ok' }] }),
			model: 'mock-model',
			prompt: 'hi',
			workingDirectory: root,
			sessionId,
			sessionLog: new InMemorySessionLog({ sessionId }),
		})
		expect(isEntityId(result.identity.projectId, 'project')).toBe(true)
		expect(await readdir(root)).toEqual([])
	})
})
