import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { blobPath, manifestPath, parseManifest } from '../manifest.js'
import { FileCheckpointStore } from '../store.js'

// A file-history copy is a copy of the person's file (a `.env` among them):
// it is the owner's alone, while a restore still puts back the file's own mode.
let cwd: string
let historyRoot: string

const T1 = '019a0000-0000-7000-8000-000000000001'

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-history-mode-'))
	historyRoot = join(cwd, 'state', 'file-history')
})

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true })
})

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

describe.runIf(process.platform !== 'win32')('file-history copies', () => {
	it('are written owner-only in owner-only folders, and a restore keeps the file’s mode', async () => {
		const store = new FileCheckpointStore(historyRoot, cwd, { now: () => 1_000_000 })
		const file = join(cwd, '.env')
		await writeFile(file, 'TOKEN=before')
		await chmod(file, 0o644)
		store.beginTurn('change the token', T1)
		await store.snapshot(file, { turnId: T1, tool: 'edit', toolUseId: 'call-1' })
		await writeFile(file, 'TOKEN=after')
		await store.settle(file, { ok: true, first: true, turnId: T1 })

		const manifestFile = manifestPath(historyRoot, T1)
		const manifest = parseManifest(await readFile(manifestFile, 'utf8'))
		const before = manifest?.entries[0]?.before?.sha256 ?? ''
		expect(await modeOf(blobPath(historyRoot, before))).toBe(0o600)
		expect(await modeOf(manifestFile)).toBe(0o600)
		expect(await modeOf(dirname(blobPath(historyRoot, before)))).toBe(0o700)
		expect(await modeOf(dirname(manifestFile))).toBe(0o700)
		expect(await modeOf(historyRoot)).toBe(0o700)

		const preview = await store.previewUndo(T1)
		const out = await store.undo(T1, { planToken: preview.planToken })
		expect(out.kind).toBe('applied')
		expect(await readFile(file, 'utf8')).toBe('TOKEN=before')
		expect(await modeOf(file)).toBe(0o644)
	})
})
