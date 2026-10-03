import { mkdirSync, mkdtempSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskPalStore } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { restrictToOwner } from '../integrations/providers/credential-store.js'
import {
	cliPalStore,
	createPal,
	getCliPalStore,
	getPal,
	getPalRevision,
	listPals,
	palAtWorkspace,
} from './store.js'

vi.mock('../integrations/providers/credential-store.js', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('../integrations/providers/credential-store.js')>()
	return { ...original, restrictToOwner: vi.fn(original.restrictToOwner) }
})

let root: string
let home: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-pal-store-reuse-'))
	home = join(root, 'home')
	mkdirSync(home)
	vi.stubEnv('NAMZU_HOME', home)
	vi.mocked(restrictToOwner).mockClear()
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

it('initializes private roots once and avoids root ACL subprocess work on repeated input ownership reads', () => {
	const store = getCliPalStore()
	expect(restrictToOwner).toHaveBeenCalledTimes(2)
	const pal = createPal({ name: 'Owned computer fixture' })
	// Newly allocated Pal directories still receive their own privacy checks.
	expect(restrictToOwner).toHaveBeenCalledTimes(5)
	vi.mocked(restrictToOwner).mockClear()
	for (let index = 0; index < 3; index++) {
		expect(cliPalStore(home)).toBe(store)
		expect(getCliPalStore()).toBe(store)
		expect(palAtWorkspace(pal.workspace)?.id).toBe(pal.id)
		expect(getPal(pal.id)?.revision).toBe(1)
		expect(getPalRevision(pal.id, 1).name).toBe(pal.name)
		expect(listPals().map((item) => item.id)).toEqual([pal.id])
	}
	expect(restrictToOwner).not.toHaveBeenCalled()
})

it('refreshes live persisted profiles and immutable revisions written by an independent store', () => {
	const pal = createPal({ name: 'Original', purpose: 'Original instructions' })
	const store = getCliPalStore()
	const other = new DiskPalStore({ root: store.root, workspaceRoot: store.workspaceRoot })
	other.update(pal.id, 1, { name: 'Updated', purpose: 'Fresh instructions', paused: true })
	vi.mocked(restrictToOwner).mockClear()
	expect(getCliPalStore()).toBe(store)
	expect(getPal(pal.id)).toMatchObject({
		name: 'Updated',
		purpose: 'Fresh instructions',
		paused: true,
		revision: 2,
	})
	expect(palAtWorkspace(pal.workspace)).toMatchObject({ paused: true, revision: 2 })
	expect(listPals()[0]).toMatchObject({ name: 'Updated', revision: 2 })
	expect(getPalRevision(pal.id, 1)).toMatchObject({ name: 'Original', paused: false, revision: 1 })
	expect(restrictToOwner).not.toHaveBeenCalled()
})

it('isolates configured and explicit homes while reusing their exact normalized roots', () => {
	const first = getCliPalStore()
	const pal = createPal({ name: 'First home fixture' })
	const secondHome = join(root, 'second')
	mkdirSync(secondHome)
	vi.stubEnv('NAMZU_HOME', secondHome)
	const second = getCliPalStore()
	expect(second).not.toBe(first)
	expect(getPal(pal.id)).toBeNull()
	expect(cliPalStore(home)).toBe(first)
	expect(cliPalStore(join(home, '..', 'home'))).toBe(first)
	expect(getPal(pal.id, home)?.id).toBe(pal.id)
	vi.stubEnv('NAMZU_HOME', home)
	expect(getCliPalStore()).toBe(first)
	expect(restrictToOwner).toHaveBeenCalledTimes(7)
})

it.each(['root', 'workspaceRoot'] as const)(
	'reinitializes privacy when the %s directory allocation changes at the same path',
	(field) => {
		const previous = getCliPalStore()
		const path = previous[field]
		renameSync(path, `${path}-original`)
		mkdirSync(path, { mode: 0o700 })
		vi.mocked(restrictToOwner).mockClear()
		const replacement = getCliPalStore()
		expect(replacement).not.toBe(previous)
		expect(replacement[field]).toBe(path)
		expect(restrictToOwner).toHaveBeenCalledTimes(2)
		expect(getCliPalStore()).toBe(replacement)
		expect(restrictToOwner).toHaveBeenCalledTimes(2)
	},
)

it('rejects a swapped directory junction without securing or adopting the redirected target', () => {
	const store = getCliPalStore()
	const target = join(root, 'redirected')
	mkdirSync(target, { mode: 0o700 })
	renameSync(store.root, `${store.root}-original`)
	symlinkSync(target, store.root, 'junction')
	vi.mocked(restrictToOwner).mockClear()
	expect(() => getCliPalStore()).toThrow('directory identity changed')
	expect(restrictToOwner).not.toHaveBeenCalled()
	// A later call does not recover the deleted cache entry by following the junction.
	expect(() => getCliPalStore()).toThrow('real directory')
	expect(restrictToOwner).not.toHaveBeenCalled()
})

it('does not reuse a partially initialized store after startup privacy verification fails', () => {
	vi.mocked(restrictToOwner).mockImplementationOnce(() => {
		throw new Error('Fixture privacy verification refused')
	})
	expect(() => getCliPalStore()).toThrow('privacy verification refused')
	expect(restrictToOwner).toHaveBeenCalledTimes(1)
	const recovered = getCliPalStore()
	expect(restrictToOwner).toHaveBeenCalledTimes(3)
	expect(getCliPalStore()).toBe(recovered)
	expect(restrictToOwner).toHaveBeenCalledTimes(3)
})
