import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemoryMemoryStore } from '../../../store/memory/memory.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { generateRunId } from '../../../utils/id.js'
import { buildMemoryTools } from '../index.js'

const context: ToolContext = {
	runId: generateRunId(),
	workingDirectory: process.cwd(),
	abortSignal: new AbortController().signal,
	env: {},
	log() {},
}

describe('memory lifecycle tools', () => {
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
		const registry = new ToolRegistry()
		registry.register(buildMemoryTools(store))
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
		const registry = new ToolRegistry()
		registry.register(buildMemoryTools(store))
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
			runId: context.runId,
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
		const registry = new ToolRegistry()
		registry.register(definitions)
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
