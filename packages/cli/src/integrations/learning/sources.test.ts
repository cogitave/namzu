import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResidentLearningState } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { residentLearningSources } from './learning-sources.js'

const dirs: string[] = []
afterEach(async () => {
	for (const dir of dirs) await removeTempDir(dir)
	dirs.length = 0
})
const learning = (keys: string[]): ResidentLearningState => ({
	revision: 1,
	preferences: [],
	lastChange: { key: 'test', source: 'test', reason: 'fixture' },
	skills: [
		{
			name: 'test',
			description: 'fixture',
			body: 'fixture',
			hash: 'a'.repeat(64),
			evidence: { key: 'test', source: 'test', reason: 'fixture' },
			verification: {
				baselineHash: 'none',
				candidateHash: 'a'.repeat(64),
				evidenceDigest: 'b'.repeat(64),
				verificationTasks: 5,
				confirmationTasks: 5,
			},
			sources: keys.map((key) => ({ key, revision: 'old' })),
		},
	],
})
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
it('reobserves changed bytes, atomic replacement and deletion with the same resolver', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-learning-sources-'))
	dirs.push(root)
	const file = join(root, 'map.json')
	const key = 'workspace-file:map.json'
	await writeFile(file, 'one')
	const resolve = residentLearningSources(root, learning([key]))
	expect(resolve()).toEqual([{ key, revision: sha('one') }])
	await writeFile(file, 'two')
	expect(resolve()).toEqual([{ key, revision: sha('two') }])
	await writeFile(join(root, 'replacement'), 'new')
	await rename(join(root, 'replacement'), file)
	expect(resolve()).toEqual([{ key, revision: sha('new') }])
	await unlink(file)
	expect(resolve()).toEqual([])
	await writeFile(file, 'new')
	expect(resolve()).toEqual([{ key, revision: sha('new') }])
})
it('does not verify traversal, symlinks, unknown keys, directories or oversized sources', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-learning-sources-'))
	dirs.push(root)
	await writeFile(join(root, 'target'), 'value')
	try {
		await symlink(join(root, 'target'), join(root, 'link'))
	} catch (error) {
		if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM')
			throw error
		// Windows users without symlink privilege still exercise every other refusal below.
	}
	await mkdir(join(root, 'folder'))
	await writeFile(join(root, 'huge'), 'x'.repeat(256 * 1024 + 1))
	expect(
		residentLearningSources(
			root,
			learning([
				'host:policy',
				'workspace-file:../target',
				'workspace-file:link',
				'workspace-file:folder',
				'workspace-file:huge',
				'workspace-file:C:\\target',
			]),
		)(),
	).toEqual([])
})
