import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FolderFingerprint } from './folder-fingerprint.js'
import { TrustedFolderStore, createFolderTrustGuard } from './trusted-folders.js'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const file = async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-trusted-folders-'))
	roots.push(root)
	return join(root, 'trusted-folders.json')
}
const print = (parts: Record<string, string>): FolderFingerprint => ({
	algo: 'sha256',
	digest: JSON.stringify(parts),
	parts,
})

describe('TrustedFolderStore', () => {
	it('persists records and reads them back in a new instance', async () => {
		const path = await file()
		const now = () => new Date('2026-10-08T10:00:00.000Z')
		new TrustedFolderStore(path, { now }).set('/a', print({ 'config:hooks': 'x' }))
		const read = new TrustedFolderStore(path).get('/a')
		expect(read?.parts).toEqual({ 'config:hooks': 'x' })
		expect(read?.at).toBe('2026-10-08T10:00:00.000Z')
	})
	it('reads a damaged or hand-edited file as empty and reports it', async () => {
		const path = await file()
		await writeFile(path, '{broken')
		const errors: string[] = []
		const store = new TrustedFolderStore(path, { onError: (_e, op) => errors.push(op) })
		expect(store.get('/a')).toBeUndefined()
		expect(errors).toEqual(['read'])
		await writeFile(path, JSON.stringify({ folders: { '/a': { digest: 1 }, '/b': null } }))
		expect(new TrustedFolderStore(path).get('/a')).toBeUndefined()
	})
	it('writes atomically with no leftover temporary file', async () => {
		const path = await file()
		new TrustedFolderStore(path).set('/a', print({}))
		expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1)
		await expect(readFile(`${path}.tmp`)).rejects.toThrow()
	})
})

describe('folder trust guard', () => {
	const setup = async (initial = true) => {
		let enabled = initial
		const store = new TrustedFolderStore(await file(), { now: () => new Date(0) })
		let current = print({ 'config:hooks': '1' })
		const guard = createFolderTrustGuard({
			store,
			enabled: () => enabled,
			fingerprint: async () => current,
		})
		return {
			store,
			guard,
			change: (parts: Record<string, string>) => {
				current = print(parts)
			},
			setEnabled: (value: boolean) => {
				enabled = value
			},
		}
	}
	it('baselines a folder with no record and reports nothing (trust on first use)', async () => {
		const { guard, store } = await setup()
		expect(await guard.check('/a')).toEqual([])
		expect(store.get('/a')?.parts).toEqual({ 'config:hooks': '1' })
	})
	it('reports what changed, and keeps reporting until trust is recorded again', async () => {
		const { guard, change } = await setup()
		await guard.check('/a')
		change({ 'config:hooks': '2', 'config:mcpServers': 'm' })
		expect(await guard.check('/a')).toEqual(['hooks changed', 'MCP servers added'])
		expect(await guard.check('/a')).toEqual(['hooks changed', 'MCP servers added'])
		await guard.record('/a')
		expect(await guard.check('/a')).toEqual([])
	})
	it('with the setting off, reports nothing but keeps the record current', async () => {
		const { guard, change, setEnabled } = await setup(false)
		await guard.check('/a')
		change({ 'config:hooks': '2' })
		expect(await guard.check('/a')).toEqual([])
		setEnabled(true)
		expect(await guard.check('/a')).toEqual([])
	})
	it('uses the canonical path as the key', async () => {
		const store = new TrustedFolderStore(await file())
		const guard = createFolderTrustGuard({
			store,
			enabled: () => true,
			canonical: (path) => path.toLowerCase(),
			fingerprint: async () => print({}),
		})
		await guard.record('/ABC')
		expect(store.get('/abc')).toBeDefined()
	})
})
