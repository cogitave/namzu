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
import { DiskMemoryStore } from '../../../store/memory/disk.js'
import { InMemoryMemoryIndex } from '../../../store/memory/index.js'
import { InMemoryMemoryStore } from '../../../store/memory/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { MemoryId, SessionId, TurnId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { buildMemoryTools } from '../index.js'

const roots: string[] = []

afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

function context(root: string): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: '7e69f32b-e28e-4a56-be95-7a6f206bd4b3' as TurnId,
		workingDirectory: root,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

function registry(tools: ReturnType<typeof buildMemoryTools>): ToolManager {
	return new ToolManager({ toolsets: [testToolset(...tools)], messages: () => [] })
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
			id: 'fc3881e3-52e9-4f25-ae0c-e0cc950de830' as MemoryId,
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

	it('says a zero-match page is incomplete and can find an older body-only match', async () => {
		const store = new InMemoryMemoryStore()
		let time = 1_000
		const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++time)
		try {
			await store.create({ title: 'Old fact', summary: '', content: 'ambermarker' })
			for (let index = 0; index < 256; index += 1) {
				await store.create({ title: `Recent ${index}`, summary: '', content: 'other fact' })
			}
		} finally {
			clock.mockRestore()
		}
		const tools = registry(buildMemoryTools(store))
		const first = await tools.execute(
			'search_memory',
			{ query: 'ambermarker', limit: 1 },
			context(process.cwd()),
		)
		expect(first.output).toContain('Search incomplete; continue with scan_offset 256')
		expect(first.output).not.toBe('No memories found.')
		expect(first.data).toMatchObject({ totalCount: 0, truncated: true, nextScanOffset: 256 })

		const second = await tools.execute(
			'search_memory',
			{ query: 'ambermarker', limit: 1, scan_offset: 256 },
			context(process.cwd()),
		)
		expect(second.output).toContain('Old fact')
		expect(second.data).toMatchObject({ totalCount: 1, truncated: false, scannedCount: 1 })
	})
})
