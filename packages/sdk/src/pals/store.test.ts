import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PalRuntime } from './runtime.js'
import { DiskPalStore, PalConflictError } from './store.js'
import type { PalAppearance } from './types.js'

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
	it('persists a terminal deletion while retaining historical revisions and owned files', () => {
		const { root, store } = fresh()
		const first = store.create({ name: 'Retained history' })
		const current = store.update(first.id, 1, { name: 'Latest name' })
		const other = store.create({ name: 'Unaffected Pal' })
		const proof = join(current.workspace, 'retained.txt')
		writeFileSync(proof, 'Owned file remains')
		const firstBytes = readFileSync(join(store.root, first.id, 'revisions', '1.json'), 'utf8')
		store.delete(first.id, 2)
		const tombstone = join(store.root, first.id, 'revisions', '3.json')
		const deletedBytes = readFileSync(tombstone, 'utf8')
		const restarted = new DiskPalStore({
			root: join(root, 'registry'),
			workspaceRoot: join(root, 'workspaces'),
		})
		expect(restarted.get(first.id)).toBeNull()
		expect(restarted.list()).toEqual([other])
		expect(restarted.getRevision(first.id, 1)).toEqual(first)
		expect(restarted.getRevision(first.id, 2)).toEqual(current)
		expect(() => restarted.getRevision(first.id, 3)).toThrow('deletion')
		expect(readFileSync(proof, 'utf8')).toBe('Owned file remains')
		expect(readFileSync(join(store.root, first.id, 'revisions', '1.json'), 'utf8')).toBe(firstBytes)
		restarted.delete(first.id, 2)
		expect(readFileSync(tombstone, 'utf8')).toBe(deletedBytes)
		expect(readdirSync(join(store.root, first.id, 'revisions'))).toEqual([
			'1.json',
			'2.json',
			'3.json',
		])
		expect(() => restarted.delete(first.id, 1)).toThrow(PalConflictError)
		expect(() => restarted.update(first.id, 2, { paused: false })).toThrow('does not exist')
		expect(() => restarted.update(first.id, 3, { name: 'Resurrected' })).toThrow('does not exist')
		expect(() => restarted.atWorkspace(current.workspace)).toThrow('no matching definition')
		if (process.platform !== 'win32') {
			const alias = join(root, 'deleted-alias')
			symlinkSync(current.workspace, alias)
			expect(() => restarted.atWorkspace(alias)).toThrow('alias')
		}
	})
	it('refuses an outdated deletion after another store wins the next immutable revision', () => {
		const { root, store } = fresh()
		const pal = store.create({ name: 'Original' })
		const peer = new DiskPalStore({
			root: join(root, 'registry'),
			workspaceRoot: join(root, 'workspaces'),
		})
		const edited = peer.update(pal.id, 1, { name: 'Winning edit' })
		expect(() => store.delete(pal.id, 1)).toThrow(PalConflictError)
		expect(store.get(pal.id)).toEqual(edited)
		store.delete(pal.id, edited.revision)
		expect(peer.get(pal.id)).toBeNull()
		expect(() => peer.update(pal.id, edited.revision, { paused: false })).toThrow('does not exist')
	})
	it('revokes an existing conversation and refuses pinned historical admission after deletion', async () => {
		const { store } = fresh()
		const pal = store.create({ name: 'Admitted Pal' })
		const acquire = vi.fn(async () => {
			throw new Error('This test must not acquire a computer')
		})
		const runtime = new PalRuntime({ store, environments: { acquire } })
		const admission = await runtime.admitConversation({ palId: pal.id, conversationId: 'text' })
		try {
			store.delete(pal.id, pal.revision)
			expect(() => admission.assertActive()).toThrow('unavailable')
			await expect(admission.acquireComputer()).rejects.toThrow('unavailable')
			await expect(runtime.startComputer(pal.id)).rejects.toThrow('unavailable')
			await expect(
				runtime.admitConversation({
					palId: pal.id,
					revision: pal.revision,
					conversationId: 'historical',
				}),
			).rejects.toThrow('unavailable')
			expect(acquire).not.toHaveBeenCalled()
		} finally {
			await admission.release()
			await runtime.close()
		}
	})
	it.skipIf(process.platform === 'win32')('refuses deletion through a symlinked revision', () => {
		const { root, store } = fresh()
		const pal = store.create({ name: 'Owned' })
		const revision = join(store.root, pal.id, 'revisions', '1.json')
		const original = join(root, 'original.json')
		writeFileSync(original, readFileSync(revision))
		unlinkSync(revision)
		symlinkSync(original, revision)
		expect(() => store.delete(pal.id, 1)).toThrow('real file')
		expect(readdirSync(join(store.root, pal.id, 'revisions'))).toEqual(['1.json'])
	})
	it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER])(
		'refuses invalid deletion revision %s without changing availability',
		(revision) => {
			const { store } = fresh()
			const pal = store.create({ name: 'Valid' })
			expect(() => store.delete(pal.id, revision)).toThrow('revision')
			expect(store.get(pal.id)).toEqual(pal)
		},
	)
	it('persists character and color across restart without mutating earlier profile revisions', () => {
		const { root, store } = fresh()
		const input = { character: 'pixel', color: 'green' } as const
		const pal = store.create({ name: 'Research', appearance: input })
		const original = readFileSync(join(root, 'registry', pal.id, 'revisions', '1.json'), 'utf8')
		const updated = store.update(pal.id, 1, {
			appearance: { character: 'sprout', color: 'violet' },
		})
		const restarted = new DiskPalStore({
			root: join(root, 'registry'),
			workspaceRoot: join(root, 'workspaces'),
		})
		expect(updated.revision).toBe(2)
		expect(restarted.get(pal.id)?.appearance).toEqual({ character: 'sprout', color: 'violet' })
		expect(restarted.getRevision(pal.id, 1).appearance).toEqual(input)
		expect(readFileSync(join(root, 'registry', pal.id, 'revisions', '1.json'), 'utf8')).toBe(
			original,
		)
		expect(() =>
			restarted.update(pal.id, 1, { appearance: { character: 'spark', color: 'amber' } }),
		).toThrow(PalConflictError)
	})
	it('leaves appearance absent on old records and unrelated edits instead of assigning a host default', () => {
		const { store } = fresh()
		const pal = store.create({ name: 'Existing' })
		expect(pal).not.toHaveProperty('appearance')
		expect(store.getRevision(pal.id, 1)).not.toHaveProperty('appearance')
		expect(store.update(pal.id, 1, { name: 'Renamed' })).not.toHaveProperty('appearance')
	})
	it.each([
		['pixel', 'green'],
		['sprout', 'blue'],
		['spark', 'amber'],
		['pixel', 'violet'],
		['sprout', 'rose'],
	] as const)('accepts supported appearance %s/%s', (character, color) => {
		const { store } = fresh()
		const pal = store.create({ name: 'Chosen', appearance: { character, color } })
		expect(store.get(pal.id)?.appearance).toEqual({ character, color })
	})
	it.each([
		null,
		[],
		'pixel/green',
		{},
		{ character: 'pixel' },
		{ character: 'unknown', color: 'green' },
		{ character: 'pixel', color: 'red' },
		{ character: 'pixel', color: 'green', url: 'https://example.invalid' },
	])(
		'rejects invalid appearance on creation, update and stored reads without publishing a revision: %j',
		(appearance) => {
			const { root, store } = fresh()
			const invalid = appearance as unknown as PalAppearance
			expect(() => store.create({ name: 'Bad', appearance: invalid })).toThrow('appearance')
			expect(store.list()).toEqual([])
			const pal = store.create({ name: 'Good' })
			expect(() => store.update(pal.id, 1, { appearance: invalid })).toThrow('appearance')
			expect(store.get(pal.id)?.revision).toBe(1)
			expect(readdirSync(join(root, 'registry', pal.id, 'revisions'))).toEqual(['1.json'])
			const path = join(root, 'registry', pal.id, 'revisions', '1.json')
			writeFileSync(path, JSON.stringify({ ...pal, appearance }))
			expect(() => store.get(pal.id)).toThrow('appearance')
		},
	)
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
