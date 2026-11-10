import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MarkdownMemoryStore, SESSION_MEMORY_TAG } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { loadManagedMemories, memoryDescription, restoreManagedMemory } from './manage.js'
import { describeSweep, sweepMemory } from './sweep.js'
import { MemoryUsage } from './usage.js'

const DAY = 86_400_000
const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
	vi.useRealTimers()
})

const derived = { source: SESSION_MEMORY_TAG }

/** A store, a usage file that began counting at `since`, and a clock the test sets. */
async function setup(since: number | 'unknown' = 0) {
	const directory = mkdtempSync(join(tmpdir(), 'namzu-memory-sweep-'))
	roots.push(directory)
	const store = new MarkdownMemoryStore({ directory: join(directory, 'records') })
	const file = join(directory, 'usage.json')
	let now = since === 'unknown' ? 0 : since
	const usage = new MemoryUsage({ file, now: () => now })
	await usage.load()
	if (since !== 'unknown') {
		usage.recalled(['seed'])
		await usage.flush()
	}
	return {
		store,
		usage,
		directory,
		at: (value: number) => {
			now = value
		},
		sweep: (retireAfterDays = 21) => sweepMemory({ store, usage, now: () => now, retireAfterDays }),
	}
}

async function create(
	store: MarkdownMemoryStore,
	title: string,
	metadata: Record<string, unknown> | null = derived,
	content = `${title} body`,
) {
	// A fixed clock keeps createdAt under the test's control.
	return (await store.create({ title, summary: 's', content, ...(metadata ? { metadata } : {}) }))
		.entry
}

describe('the sweep', () => {
	it('archives a recorded memory unused for the whole window, and writes why', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup(1_000)
		const old = await create(t.store, 'Stale finding')
		t.at(1_000 + 20 * DAY)
		expect((await t.sweep()).archived).toEqual([])

		t.at(1_000 + 21 * DAY)
		const report = await t.sweep()
		expect(report.archived).toMatchObject([{ id: old.id, reason: 'unused' }])
		const record = await t.store.getRecord(old.id)
		expect(record?.entry.status).toBe('archived')
		expect(record?.content.metadata).toMatchObject({
			source: SESSION_MEMORY_TAG,
			retiredAt: 1_000 + 21 * DAY,
			retiredReason: 'unused',
		})
		// Archived, not deleted: the file is still listed as archived.
		expect((await t.store.list({ status: 'archived' })).entries).toHaveLength(1)
	})

	it('counts the window from the last recall', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup(1_000)
		const used = await create(t.store, 'Used now and then')
		t.at(1_000 + 15 * DAY)
		t.usage.recalled([used.id])
		t.at(1_000 + 30 * DAY)
		expect((await t.sweep()).archived).toEqual([])
		t.at(1_000 + 36 * DAY)
		expect((await t.sweep()).archived).toHaveLength(1)
	})

	it('counts the window from when the file began counting, not from an old creation', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup(1_000 + 100 * DAY)
		await create(t.store, 'Created long before counting began')
		t.at(1_000 + 110 * DAY)
		expect((await t.sweep()).archived).toEqual([])
	})

	it('retires nothing for being unused when the counts are unknown, and says so', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup('unknown')
		await create(t.store, 'Looks unused')
		t.at(1_000 + 400 * DAY)
		const report = await t.sweep()
		expect(report.archived).toEqual([])
		expect(report.unusedSkipped).toBe('unknown')
		expect(describeSweep(report, 21)).toMatch(/not known yet/u)
		expect((await t.store.list({ status: 'active' })).entries).toHaveLength(1)
	})

	it('retires nothing for being unused when the setting is 0', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup(1_000)
		await create(t.store, 'Kept for ever')
		t.at(1_000 + 900 * DAY)
		const report = await t.sweep(0)
		expect(report.archived).toEqual([])
		expect(report.unusedSkipped).toBe('off')
	})

	it('never changes a memory you or Namzu saved, and only flags it', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup(1_000)
		const mine = await create(t.store, 'Mine', null)
		const saved = await create(t.store, 'Saved by the model', { source: 'agent-memory' })
		const consolidated = await create(t.store, 'Consolidated', { kind: 'consolidation' })
		t.at(1_000 + 90 * DAY)
		const report = await t.sweep()
		expect(report.archived.map((item) => item.id)).toEqual([consolidated.id])
		expect([...report.possiblyStale].sort()).toEqual([mine.id, saved.id].sort())
		for (const entry of [mine, saved]) {
			const after = await t.store.getRecord(entry.id)
			expect(after?.entry.status).toBe('active')
			expect(after?.entry.updatedAt).toBe(entry.updatedAt)
			expect(after?.content.metadata?.retiredAt).toBeUndefined()
		}
	})

	it('archives exact copies among recorded memories and keeps the newest', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup(1_000)
		const first = await create(t.store, 'Prefers tabs', derived, 'Always use tabs.')
		vi.setSystemTime(2_000)
		const second = await create(t.store, 'prefers  TABS', derived, 'always use  tabs.')
		vi.setSystemTime(3_000)
		const third = await create(t.store, 'Prefers tabs', derived, 'Always use tabs.')
		const different = await create(t.store, 'Prefers tabs', derived, 'Always use tabs in Go.')
		const operatorCopy = await create(t.store, 'Prefers tabs', null, 'Always use tabs.')
		t.at(3_000)
		const report = await t.sweep()
		expect(report.archived.map((item) => [item.id, item.reason]).sort()).toEqual(
			[
				[first.id, 'duplicate'],
				[second.id, 'duplicate'],
			].sort(),
		)
		const survivors = (await t.store.list({ status: 'active' })).entries.map((e) => e.id)
		expect(survivors.sort()).toEqual([third.id, different.id, operatorCopy.id].sort())
		const archived = await t.store.getRecord(first.id)
		expect(archived?.content.metadata).toMatchObject({
			retiredReason: 'duplicate',
			supersededBy: third.id,
		})
	})

	it('archives copies even when counts are unknown or the setting is 0', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup('unknown')
		await create(t.store, 'Same', derived, 'one')
		vi.setSystemTime(2_000)
		await create(t.store, 'Same', derived, 'one')
		const report = await t.sweep(0)
		expect(report.archived).toHaveLength(1)
	})

	it('leaves a record that changed while it ran', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup(1_000)
		const entry = await create(t.store, 'Edited meanwhile')
		t.at(1_000 + 40 * DAY)
		const real = t.store.updateIfRevision.bind(t.store)
		const conflicting = vi
			.spyOn(t.store, 'updateIfRevision')
			.mockImplementationOnce(async (id, updates, revision) => {
				await t.store.update(id, { title: 'Edited by a person' })
				return real(id, updates, revision)
			})
		const report = await t.sweep()
		expect(conflicting).toHaveBeenCalled()
		expect(report.kept).toBe(1)
		expect(report.archived).toEqual([])
		expect((await t.store.getRecord(entry.id))?.entry.status).toBe('active')
	})

	it('says what it archived, one line each', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup(1_000)
		await create(t.store, 'Old claim')
		t.at(1_000 + 22 * DAY)
		const text = describeSweep(await t.sweep(), 21)
		expect(text).toBe(
			'Retired 1 memory. /memory restores them.\n  Old claim · not recalled for 21 days',
		)
		expect(describeSweep({ archived: [], possiblyStale: [], staleReasons: {}, kept: 0 }, 21)).toBe(
			'Nothing to tidy: no memory was set aside.',
		)
	})

	it('says a saved memory is stale because a file is gone, not because it was not recalled', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup(1_000)
		const mine = await create(t.store, 'Mine', null)
		t.at(1_000 + DAY)
		t.usage.anchorsBroken(mine.id)
		// Recalled recently, so it is not unused; the file has been gone for 15 days.
		t.at(1_000 + 16 * DAY)
		t.usage.recalled([mine.id])
		vi.setSystemTime(1_000 + 16 * DAY)
		const report = await t.sweep()
		expect(report.possiblyStale).toEqual([mine.id])
		expect(report.staleReasons).toEqual({ [mine.id]: 'anchors' })
		const text = describeSweep(report, 21)
		expect(text).toContain('a file that has been gone for 14 days')
		expect(text).not.toContain('not been recalled')
		const [item] = await loadManagedMemories(t.store, t.directory, {
			usage: t.usage,
			now: 1_000 + 16 * DAY,
			retireAfterDays: 21,
		})
		expect(item?.possiblyStale).toBe(true)
		expect(memoryDescription(item as never, 1_000 + 16 * DAY)).toMatch(
			/^possibly stale: a file it names is gone · /u,
		)
	})

	it('shows retired memories in /memory and restores them, without the sweep’s marks', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
		const t = await setup(1_000)
		const entry = await create(t.store, 'Come back')
		t.at(1_000 + 30 * DAY)
		await t.sweep()
		vi.setSystemTime(1_000 + 30 * DAY)

		const listed = await loadManagedMemories(t.store, t.directory, { usage: t.usage })
		expect(listed).toMatchObject([{ id: entry.id, state: 'retired', retiredReason: 'unused' }])
		const outcome = await restoreManagedMemory(t.store, listed[0] as never, async () => undefined)
		expect(outcome).toBe('restored')
		const after = await t.store.getRecord(entry.id)
		expect(after?.entry.status).toBe('active')
		expect(after?.content.metadata).toEqual(derived)
		// It does not fall straight back: its window starts at the restore.
		t.at(1_000 + 31 * DAY)
		expect((await t.sweep()).archived).toEqual([])
	})
})
