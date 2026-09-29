import { describe, expect, it, vi } from 'vitest'
import { InMemoryMemoryStore } from '../../../store/memory/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { MemoryStore } from '../../../types/memory/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { buildMemoryTools } from '../index.js'

const context: ToolContext = {
	sessionId: generateSessionId(),
	turnId: generateTurnId(),
	workingDirectory: process.cwd(),
	abortSignal: new AbortController().signal,
	env: {},
	log() {},
}

function revisionIn(data: unknown): string {
	if (
		data === null ||
		typeof data !== 'object' ||
		!('revision' in data) ||
		typeof data.revision !== 'string'
	) {
		throw new Error('Expected a memory revision')
	}
	return data.revision
}

describe('memory lifecycle tools', () => {
	it('offers revision use in both mutating tool descriptions and optional input schemas', () => {
		const tools = buildMemoryTools(new InMemoryMemoryStore())
		for (const name of ['update_memory', 'delete_memory']) {
			const tool = tools.find((candidate) => candidate.name === name)
			expect(tool?.description).toContain('Pass the revision from read_memory when available')
			const schema = tool?.inputSchema as unknown as {
				shape: { revision: { description?: string; isOptional(): boolean } }
			}
			expect(schema.shape.revision.description).toContain('Opaque revision from read_memory')
			expect(schema.shape.revision.isOptional()).toBe(true)
		}
	})

	it('returns a revision and reports a stale update or deletion without mutating memory', async () => {
		const store = new InMemoryMemoryStore()
		const { entry } = await store.create({
			title: 'Cache',
			summary: 'Expiry',
			content: '14 hours',
		})
		const registry = new ToolManager({
			toolsets: [testToolset(...buildMemoryTools(store))],
			messages: () => [],
		})
		const first = await registry.execute('read_memory', { id: entry.id }, context)
		expect(first.success).toBe(true)
		expect(first.data).toMatchObject({ revision: expect.stringMatching(/^m1:[a-f0-9]{64}$/) })
		const staleRevision = revisionIn(first.data)

		await store.update(entry.id, { content: '28 hours' })
		const current = await store.getVersionedRecord(entry.id)
		const failedUpdate = await registry.execute(
			'update_memory',
			{ id: entry.id, content: 'Stale change', revision: staleRevision },
			context,
		)
		expect(failedUpdate).toMatchObject({
			success: false,
			error: 'Memory changed since read',
			data: { reason: 'revision_conflict' },
		})
		expect(failedUpdate.output).toContain('Read it again before changing it')
		const failedDelete = await registry.execute(
			'delete_memory',
			{ id: entry.id, revision: staleRevision },
			context,
		)
		expect(failedDelete).toMatchObject({
			success: false,
			error: 'Memory changed since read',
			data: { reason: 'revision_conflict' },
		})
		expect(await store.getVersionedRecord(entry.id)).toEqual(current)

		const freshRevision = revisionIn(
			(await registry.execute('read_memory', { id: entry.id }, context)).data,
		)
		expect(
			(
				await registry.execute(
					'update_memory',
					{ id: entry.id, content: '32 hours', revision: freshRevision },
					context,
				)
			).success,
		).toBe(true)
		const afterUpdate = revisionIn(
			(await registry.execute('read_memory', { id: entry.id }, context)).data,
		)
		expect(
			(await registry.execute('delete_memory', { id: entry.id, revision: afterUpdate }, context))
				.success,
		).toBe(true)
		expect(await store.getRecord(entry.id)).toBeUndefined()
	})

	it('refuses a supplied revision on a custom store without the full conditional contract', async () => {
		const delegate = new InMemoryMemoryStore()
		const { entry } = await delegate.create({
			title: 'Cache',
			summary: 'Expiry',
			content: '14 hours',
		})
		const update = vi.fn(delegate.update.bind(delegate))
		const remove = vi.fn(delegate.delete.bind(delegate))
		const store: MemoryStore = {
			create: delegate.create.bind(delegate),
			get: delegate.get.bind(delegate),
			getRecord: delegate.getRecord.bind(delegate),
			getVersionedRecord: delegate.getVersionedRecord.bind(delegate),
			update,
			delete: remove,
			list: delegate.list.bind(delegate),
		} as MemoryStore
		const registry = new ToolManager({
			toolsets: [testToolset(...buildMemoryTools(store))],
			messages: () => [],
		})
		const read = await registry.execute('read_memory', { id: entry.id }, context)
		expect(read.data).not.toHaveProperty('revision')
		expect(
			(
				await registry.execute(
					'update_memory',
					{ id: entry.id, content: 'bad', revision: 'r' },
					context,
				)
			).error,
		).toBe('Conditional memory update unavailable')
		expect(
			(await registry.execute('delete_memory', { id: entry.id, revision: 'r' }, context)).error,
		).toBe('Conditional memory deletion unavailable')
		expect(update).not.toHaveBeenCalled()
		expect(remove).not.toHaveBeenCalled()
		expect((await delegate.get(entry.id))?.content).toBe('14 hours')
	})

	it('preserves host metadata committed while a content correction is entering the store', async () => {
		const store = new InMemoryMemoryStore()
		const { entry } = await store.create({
			title: 'Cache',
			summary: 'Expiry',
			content: '14 hours',
			metadata: { version: 'old' },
		})
		const update = store.update.bind(store)
		vi.spyOn(store, 'update').mockImplementation(async (id, patch) => {
			await update(id, { metadata: { version: 'new', externalReceipt: 'preserve' } })
			return update(id, patch)
		})
		const registry = new ToolManager({
			toolsets: [testToolset(...buildMemoryTools(store))],
			messages: () => [],
		})
		expect(
			(await registry.execute('update_memory', { id: entry.id, content: '28 hours' }, context))
				.success,
		).toBe(true)
		expect(await store.get(entry.id)).toMatchObject({
			content: '28 hours',
			metadata: { version: 'new', externalReceipt: 'preserve' },
		})
	})

	it('corrects a record in place, supports explicit archived inspection and permanent deletion', async () => {
		const store = new InMemoryMemoryStore()
		const registry = new ToolManager({
			toolsets: [testToolset(...buildMemoryTools(store))],
			messages: () => [],
		})
		await registry.execute(
			'save_memory',
			{ title: 'paymentdb port', summary: 'Port 5432', content: 'Use 5432' },
			context,
		)
		const id = (await store.list()).entries[0]?.id
		expect(id).toBeDefined()
		if (!id) throw new Error('Expected a saved record')
		const update = await registry.execute(
			'update_memory',
			{ id, summary: 'Port 6432', content: 'Use 6432' },
			context,
		)
		expect(update.success).toBe(true)
		expect((await store.list()).totalCount).toBe(1)
		expect((await store.get(id))?.metadata).toMatchObject({
			sessionId: context.sessionId,
			turnId: context.turnId,
			source: 'agent-memory',
		})
		await registry.execute('update_memory', { id, status: 'archived' }, context)
		expect((await registry.execute('search_memory', { query: 'paymentdb' }, context)).output).toBe(
			'No memories found.',
		)
		expect(
			(await registry.execute('search_memory', { query: 'paymentdb', status: 'archived' }, context))
				.output,
		).toContain('6432')
		expect((await registry.execute('delete_memory', { id }, context)).success).toBe(true)
		expect(await store.get(id)).toBeUndefined()
	})

	it('does not mutate on empty correction or invalid identity; deletion requires destructive classification', async () => {
		const store = new InMemoryMemoryStore()
		const definitions = buildMemoryTools(store)
		const deletion = definitions.find((tool) => tool.name === 'delete_memory')
		expect(deletion?.isReadOnly?.({})).toBe(false)
		expect(deletion?.isDestructive?.({})).toBe(true)
		const registry = new ToolManager({
			toolsets: [testToolset(...buildMemoryTools(store))],
			messages: () => [],
		})
		const { entry } = await store.create({
			title: 'one',
			summary: 'one',
			content: 'one',
		})
		expect((await registry.execute('update_memory', { id: entry.id }, context)).success).toBe(false)
		expect(
			(await registry.execute('update_memory', { id: '../escape', content: 'bad' }, context))
				.success,
		).toBe(false)
		expect((await registry.execute('delete_memory', { id: '../escape' }, context)).success).toBe(
			false,
		)
		expect((await store.get(entry.id))?.content).toBe('one')
	})
})
