/**
 * Persistent memory is useful only if the first search after process startup
 * can see it. The disk store deliberately loads its index asynchronously, so
 * composing its still-empty synchronous index into the search tool makes the
 * durable record unreachable until some unrelated store operation happens to
 * hydrate it.
 *
 * The second test protects the other public composition: callers may supply a
 * separate, already-populated index. That path must remain index-authoritative
 * and must not acquire a new dependency on the store's list/read behaviour.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DiskMemoryStore } from '../../../store/memory/disk.js'
import { InMemoryMemoryIndex } from '../../../store/memory/index.js'
import { InMemoryMemoryStore } from '../../../store/memory/memory.js'
import type { MemoryId, RunId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { buildMemoryTools } from '../index.js'

const roots: string[] = []

afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

function context(root: string): ToolContext {
	return {
		runId: 'run_memory_search' as RunId,
		workingDirectory: root,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

function registry(tools: ReturnType<typeof buildMemoryTools>): ToolRegistry {
	const result = new ToolRegistry()
	result.register(tools)
	return result
}

describe('persistent memory search composition', () => {
	it('finds a disk record on the first search from a fresh store instance', async () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-memory-search-'))
		roots.push(root)
		const writer = new DiskMemoryStore({ baseDir: root })
		await writer.create({
			title: 'cold-start durable fact',
			summary: 'visible without a warm-up call',
			content: 'the exact persisted body',
		})

		const freshReader = new DiskMemoryStore({ baseDir: root })
		const tools = registry(buildMemoryTools(freshReader))
		const result = await tools.execute(
			'search_memory',
			{ query: 'cold-start', limit: 10 },
			context(root),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('cold-start durable fact')
		expect(result.output).not.toBe('No memories found.')
	})

	it('keeps the existing two-argument form index-authoritative', async () => {
		const store = new InMemoryMemoryStore()
		const list = vi.spyOn(store, 'list').mockRejectedValue(new Error('store is offline'))
		const index = new InMemoryMemoryIndex()
		index.set({
			id: 'mem_independent' as MemoryId,
			title: 'independent index fact',
			summary: 'search does not need the unrelated store',
			tags: [],
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		})

		const tools = registry(buildMemoryTools(store, index))
		const result = await tools.execute(
			'search_memory',
			{ query: 'independent', limit: 10 },
			context(process.cwd()),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('independent index fact')
		expect(list).not.toHaveBeenCalled()
	})
})
