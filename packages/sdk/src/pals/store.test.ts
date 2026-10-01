import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiskPalStore, PalConflictError } from './store.js'

const temporary: string[] = []
function fresh() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-pal-store-'))
	temporary.push(root)
	return {
		root,
		store: new DiskPalStore({
			root: join(root, 'registry'),
			workspaceRoot: join(root, 'workspaces'),
		}),
	}
}
afterEach(() => {
	for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe('persistent Pal identity and revision ownership', () => {
	it('survives restart with multiline purpose and independent empty workspaces', () => {
		const { root, store } = fresh()
		const one = store.create({
			name: 'Research',
			purpose: 'Read primary sources.\nSummarize clearly.',
			model: { provider: 'zen', model: 'space-bunny-free' },
		})
		const two = store.create({ name: 'Review' })
		const restarted = new DiskPalStore({
			root: join(root, 'registry'),
			workspaceRoot: join(root, 'workspaces'),
		})
		expect(restarted.get(one.id)).toEqual(one)
		expect(restarted.list()).toHaveLength(2)
		expect(one.workspace).not.toEqual(two.workspace)
		expect(restarted.atWorkspace(one.workspace)?.id).toBe(one.id)
		expect(restarted.atWorkspace(root)).toBeNull()
	})
	it('publishes immutable revisions with compare-and-update across store instances', () => {
		const { root, store } = fresh()
		const pal = store.create({ name: 'First' })
		const peer = new DiskPalStore({
			root: join(root, 'registry'),
			workspaceRoot: join(root, 'workspaces'),
		})
		const before = readFileSync(join(root, 'registry', pal.id, 'revisions', '1.json'), 'utf8')
		expect(peer.update(pal.id, 1, { name: 'Second', paused: true }).revision).toBe(2)
		expect(() => store.update(pal.id, 1, { name: 'Lost' })).toThrow(PalConflictError)
		expect(readFileSync(join(root, 'registry', pal.id, 'revisions', '1.json'), 'utf8')).toBe(before)
		expect(store.getRevision(pal.id, 1).name).toBe('First')
		expect(store.get(pal.id)?.paused).toBe(true)
	})
	it('rejects overlapping roots, path traversal, invalid text and invalid revisions', () => {
		const { root, store } = fresh()
		expect(() => new DiskPalStore({ root, workspaceRoot: join(root, 'child') })).toThrow('overlap')
		expect(() => store.get('../escape')).toThrow('id')
		expect(() => store.create({ name: '\u0000' })).toThrow('name')
		const pal = store.create({ name: 'Valid' })
		expect(() => store.update(pal.id, 1.5, { name: 'Bad' })).toThrow('revision')
	})
	it.skipIf(process.platform === 'win32')(
		'refuses symlinked revisions and workspace aliases',
		() => {
			const { root, store } = fresh()
			const pal = store.create({ name: 'Owned' })
			const revision = join(root, 'registry', pal.id, 'revisions', '1.json')
			const source = join(root, 'registry', pal.id, 'revisions', 'copy.json')
			symlinkSync(revision, source)
			unlinkSync(revision)
			symlinkSync(source, revision)
			expect(() => store.get(pal.id)).toThrow('real file')
			const alias = join(root, 'alias')
			symlinkSync(pal.workspace, alias)
			expect(() => store.atWorkspace(alias)).toThrow('alias')
		},
	)
})

it('rejects reserved control roots and descendants instead of classifying them as ordinary sessions', () => {
	const { root, store } = fresh()
	const pal = store.create({ name: 'Owned' })
	const child = join(pal.workspace, 'child')
	mkdirSync(child)
	expect(store.atWorkspace(pal.workspace)?.id).toBe(pal.id)
	expect(() => store.atWorkspace(store.workspaceRoot)).toThrow('Reserved Pal')
	expect(() => store.atWorkspace(child)).toThrow('Reserved Pal')
	expect(() => store.atWorkspace(join(child, 'missing'))).toThrow()
	expect(store.atWorkspace(root)).toBeNull()
	if (process.platform !== 'win32') {
		const alias = join(root, 'alias-child')
		symlinkSync(child, alias)
		expect(() => store.atWorkspace(alias)).toThrow('alias')
	}
})
