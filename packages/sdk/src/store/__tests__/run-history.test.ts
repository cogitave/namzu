import { appendFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../__fixtures__/temp-dir.js'

import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { Run } from '../../types/run/index.js'
import { RunDiskStore, compactRunHistory } from '../run/disk.js'
import { RUN_HISTORY_DIR, runHistoryLogFile } from '../run/run-history.js'

const MAIN = runHistoryLogFile(0, 0)
const EDITS = runHistoryLogFile(0, 1)

/**
 * A checkpoint's history is stored once per run, not once per checkpoint.
 *
 * The inline format wrote the whole conversation into every checkpoint, and
 * a run takes one per iteration, so the bytes grew with the square of the
 * run's length: one measured run held 532 checkpoints of ~1.5 MB each. These
 * pin the three things the replacement has to keep while fixing that — the
 * same messages come back, a damaged history is refused rather than resumed
 * from, and checkpoints written the old way still read.
 */

const RID = '37ddff8e-e13f-4e57-937f-d048fa323f5e' as RunId

let sequence = 0
function cpId(): CheckpointId {
	sequence += 1
	return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}` as CheckpointId
}

function checkpoint(messages: Message[], overrides: Partial<IterationCheckpoint> = {}) {
	return {
		id: cpId(),
		runId: RID,
		iteration: messages.length,
		messages,
		tokenUsage: {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 0 } as never,
		guardState: { iterationCount: 1, elapsedMs: 1 },
		createdAt: Date.now() + sequence,
		...overrides,
	} satisfies IterationCheckpoint
}

function conversation(turns: number): Message[] {
	const messages: Message[] = [{ role: 'user', content: 'Inspect every region.' }]
	for (let i = 1; i <= turns; i++) {
		messages.push({
			role: 'assistant',
			content: `Checking region ${i}.`,
			toolCalls: [
				{ id: `call_${i}`, type: 'function', function: { name: 'inspect', arguments: '{}' } },
			],
		} as Message)
		messages.push({
			role: 'tool',
			toolCallId: `call_${i}`,
			content: `Region ${i}: ${'cell '.repeat(800)}`,
		} as Message)
	}
	return messages
}

describe('the run history log', () => {
	let dir: string
	let store: RunDiskStore
	const cpDir = () => join(dir, RID, 'checkpoints')
	const historyDir = () => join(dir, RID, RUN_HISTORY_DIR)

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-cphist-'))
		store = new RunDiskStore({ baseDir: dir })
		await store.initRun(RID)
	})

	afterEach(async () => {
		await removeTempDirAsync(dir)
	})

	it('writes each message once, however many checkpoints hold it', async () => {
		const written: IterationCheckpoint[] = []
		for (let turn = 1; turn <= 40; turn++) {
			const cp = checkpoint(conversation(turn))
			written.push(cp)
			await store.writeCheckpoint(cp)
		}

		const files = (await readdir(cpDir())).filter((f) => f.endsWith('.json'))
		const sizes = await Promise.all(files.map(async (f) => (await stat(join(cpDir(), f))).size))
		const history = (await stat(join(historyDir(), MAIN))).size
		const oneCopy = conversation(40).reduce(
			(n, m) => n + Buffer.byteLength(`${JSON.stringify(m)}\n`),
			0,
		)

		// One copy of the final conversation, not forty growing ones.
		expect(history).toBe(oneCopy)
		// A checkpoint's own size no longer depends on the conversation's.
		expect(Math.max(...sizes)).toBeLessThan(1_500)
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(64)

		for (const cp of written) {
			expect((await store.readCheckpoint(cp.id))?.messages).toEqual(cp.messages)
		}
		const listed = await store.listCheckpoints()
		expect(listed.map((cp) => cp.messages)).toEqual(written.map((cp) => cp.messages))
	})

	it('references a kept tail beside a new head after the history is rewritten', async () => {
		const before = conversation(10)
		await store.writeCheckpoint(checkpoint(before))
		const sizeBefore = (await stat(join(historyDir(), MAIN))).size

		// What a compaction does: the head becomes one summary, the tail stays.
		const summary: Message = { role: 'system', content: 'Summary of regions 1-7.' }
		const after = [summary, ...before.slice(-6)]
		const cp = checkpoint(after)
		await store.writeCheckpoint(cp)

		// The kept tail is referenced where it already is; the summary, an
		// edit rather than an extension, is the only new line anywhere.
		expect((await stat(join(historyDir(), MAIN))).size).toBe(sizeBefore)
		expect((await stat(join(historyDir(), EDITS))).size).toBe(
			Buffer.byteLength(`${JSON.stringify(summary)}\n`),
		)
		expect((await store.readCheckpoint(cp.id))?.messages).toEqual(after)
	})

	it('references a rewritten pin slot in a constant number of ranges', async () => {
		// The working-memory slot sits near the head and is rewritten every
		// iteration. In one log each rewrite landed between iterations, and
		// every later checkpoint needed one range per iteration to step
		// around them.
		let last: IterationCheckpoint | undefined
		for (let turn = 1; turn <= 30; turn++) {
			const [first, ...rest] = conversation(turn)
			last = checkpoint([
				first as Message,
				{ role: 'system', content: `## Pinned by tools\n- region: ${turn}` },
				...rest,
			])
			await store.writeCheckpoint(last)
		}
		const record = JSON.parse(
			await readFile(join(cpDir(), `${(last as IterationCheckpoint).id}.json`), 'utf-8'),
		)
		expect(record.history.segments.length).toBeLessThanOrEqual(3)
		expect((await store.readCheckpoint((last as IterationCheckpoint).id))?.messages).toEqual(
			last?.messages,
		)
	})

	it('adds nothing when a checkpoint is rewritten for a park or its answer', async () => {
		const cp = checkpoint(conversation(5))
		await store.writeCheckpoint(cp)
		const size = (await stat(join(historyDir(), MAIN))).size
		const read = (await store.readCheckpoint(cp.id)) as IterationCheckpoint
		await store.writeCheckpoint({
			...read,
			pending: { request: { type: 'iteration_checkpoint' } as never, parkedAt: 1 },
		})
		expect((await stat(join(historyDir(), MAIN))).size).toBe(size)
		expect((await store.readCheckpoint(cp.id))?.pending?.parkedAt).toBe(1)
	})

	it('keeps two equal messages in one history as two objects', async () => {
		const again: Message = { role: 'user', content: 'Continue.' }
		const cp = checkpoint([again, { role: 'assistant', content: 'ok' }, { ...again }])
		await store.writeCheckpoint(cp)
		const read = (await store.readCheckpoint(cp.id)) as IterationCheckpoint
		expect(read.messages).toEqual(cp.messages)
		expect(read.messages[0]).not.toBe(read.messages[2])
	})

	it('refuses a checkpoint whose history bytes were changed', async () => {
		const cp = checkpoint(conversation(3))
		await store.writeCheckpoint(cp)
		const path = join(historyDir(), MAIN)
		const raw = await readFile(path, 'utf-8')
		await writeFile(path, raw.replace('Region 2', 'Region 9'))

		await expect(store.readCheckpoint(cp.id)).rejects.toThrow(/does not match its digest/)
		await expect(store.listCheckpoints()).rejects.toThrow(/does not match its digest/)
	})

	it('refuses a checkpoint whose history was truncated or removed', async () => {
		const cp = checkpoint(conversation(3))
		await store.writeCheckpoint(cp)
		const path = join(historyDir(), MAIN)
		const raw = await readFile(path)
		await writeFile(path, raw.subarray(0, raw.length - 10))
		await expect(store.readCheckpoint(cp.id)).rejects.toThrow(/is shorter in messages\.0\.jsonl/)

		await writeFile(path, '')
		await expect(store.readCheckpoint(cp.id)).rejects.toThrow(/Refusing/)
		const { unlink } = await import('node:fs/promises')
		await unlink(path)
		await expect(store.readCheckpoint(cp.id)).rejects.toThrow(/cannot be read/)
	})

	it('survives a torn last line left by a writer that died mid-append', async () => {
		const first = checkpoint(conversation(2))
		await store.writeCheckpoint(first)
		await appendFile(join(historyDir(), MAIN), '{"role":"user","cont')

		const fresh = new RunDiskStore({ baseDir: dir })
		await fresh.initRun(RID)
		const second = checkpoint(conversation(4))
		await fresh.writeCheckpoint(second)

		expect((await fresh.readCheckpoint(first.id))?.messages).toEqual(first.messages)
		expect((await fresh.readCheckpoint(second.id))?.messages).toEqual(second.messages)
	})

	it('stays correct when two stores append to one run', async () => {
		const other = new RunDiskStore({ baseDir: dir })
		await other.initRun(RID)
		const written: IterationCheckpoint[] = []
		for (let turn = 1; turn <= 6; turn++) {
			const mine = checkpoint([...conversation(turn), { role: 'user', content: `mine ${turn}` }])
			const theirs = checkpoint([
				...conversation(turn),
				{ role: 'user', content: `theirs ${turn}` },
			])
			await Promise.all([store.writeCheckpoint(mine), other.writeCheckpoint(theirs)])
			written.push(mine, theirs)
		}
		for (const cp of written) {
			expect((await store.readCheckpoint(cp.id))?.messages).toEqual(cp.messages)
			expect((await other.readCheckpoint(cp.id))?.messages).toEqual(cp.messages)
		}
	})

	it('still reads checkpoints written with their messages inline', async () => {
		await mkdir(cpDir(), { recursive: true })
		const v2 = checkpoint(conversation(2))
		const v1 = checkpoint(conversation(1))
		await writeFile(join(cpDir(), `${v2.id}.json`), JSON.stringify({ ...v2, schemaVersion: 2 }))
		await writeFile(join(cpDir(), `${v1.id}.json`), JSON.stringify(v1))
		const v3 = checkpoint(conversation(3))
		await store.writeCheckpoint(v3)

		expect((await store.readCheckpoint(v2.id))?.messages).toEqual(v2.messages)
		expect((await store.readCheckpoint(v1.id))?.messages).toEqual(v1.messages)
		expect((await store.listCheckpoints()).map((cp) => cp.id)).toEqual([v2.id, v1.id, v3.id])
	})

	it('refuses a reference that does not add up', async () => {
		const cp = checkpoint(conversation(2))
		await store.writeCheckpoint(cp)
		const path = join(cpDir(), `${cp.id}.json`)
		const record = JSON.parse(await readFile(path, 'utf-8'))
		record.history.count += 1
		await writeFile(path, JSON.stringify(record))
		await expect(store.readCheckpoint(cp.id)).rejects.toThrow(/not a usable checkpoint/)
	})

	it('gives every checkpoint of a listing objects of its own', async () => {
		await store.writeCheckpoint(checkpoint(conversation(2)))
		await store.writeCheckpoint(checkpoint(conversation(3)))
		const [first, second] = await store.listCheckpoints()
		;(first as IterationCheckpoint).messages[0] = {
			role: 'user',
			content: 'MUTATED',
		}
		expect((second as IterationCheckpoint).messages[0]).toEqual(conversation(1)[0])
		expect((first as IterationCheckpoint).messages[1]).not.toBe(
			(second as IterationCheckpoint).messages[1],
		)
	})

	it('stores the settled history as a reference into the same log, not a second copy', async () => {
		const history = conversation(12)
		await store.writeCheckpoint(checkpoint(history.slice(0, -1)))
		const before = (await stat(join(historyDir(), MAIN))).size
		await store.writeMessages({ messages: history } as unknown as Run, 7)

		const last = history.at(-1) as Message
		expect((await stat(join(historyDir(), MAIN))).size).toBe(
			before + Buffer.byteLength(`${JSON.stringify(last)}\n`),
		)
		const snapshot = JSON.parse(await readFile(join(dir, RID, 'messages.json'), 'utf-8'))
		expect(snapshot.format).toBe('namzu.run-message-snapshot.v2')
		expect(snapshot.messages).toBeUndefined()
		expect(await store.readMessages()).toEqual({
			kind: 'available',
			throughEventSeq: 7,
			messages: history,
		})
	})

	it('collects history nothing references once retention prunes, and every record still reads', async () => {
		// A pinned run: the slot near the head is rewritten every iteration,
		// so every iteration leaves one dead line behind once pruned.
		let last: IterationCheckpoint | undefined
		for (let turn = 1; turn <= 60; turn++) {
			const [first, ...rest] = conversation(turn)
			last = checkpoint([
				first as Message,
				{
					role: 'system',
					content: `## Pinned by tools\n- region: ${turn} ${'x'.repeat(2_000)}`,
				},
				...rest.slice(-4),
			])
			await store.writeCheckpoint(last)
			await store.pruneCheckpoints(3, { minReclaimBytes: 1 })
		}
		await store.writeMessages({ messages: last?.messages } as unknown as Run, 1)
		await compactRunHistory(join(dir, RID), { minReclaimBytes: 1 })

		const files = await readdir(historyDir())
		// Only the newest generation is left.
		expect(new Set(files.map((f) => f.split('.')[1])).size).toBe(1)
		expect(files.some((f) => f.endsWith('.0.jsonl'))).toBe(false)

		let stored = 0
		for (const f of files) stored += (await stat(join(historyDir(), f))).size
		const live = (await store.listCheckpoints()).flatMap((cp) => cp.messages)
		const liveBytes = [...new Set(live.map((m) => JSON.stringify(m)))].reduce(
			(n, m) => n + Buffer.byteLength(`${m}\n`),
			0,
		)
		// Within twice what is still referenced, not the run's whole output.
		expect(stored).toBeLessThanOrEqual(2 * liveBytes)

		const listed = await store.listCheckpoints()
		expect(listed).toHaveLength(3)
		expect(listed.at(-1)?.messages).toEqual(last?.messages)
		expect((await store.readMessages()).kind).toBe('available')
	})

	it('prunes from the checkpoint files alone, so a damaged log does not stop it', async () => {
		for (let turn = 1; turn <= 5; turn++)
			await store.writeCheckpoint(checkpoint(conversation(turn)))
		// Damaged, and large enough that a compaction would want to run.
		const damaged = `${'damaged '.repeat(20_000)}\n`
		await writeFile(join(historyDir(), MAIN), damaged)

		await expect(store.listCheckpoints()).rejects.toThrow(/Refusing/)
		// The checkpoints are pruned: that reads only their own files. The
		// collection after it refuses to copy around the damage, and leaves it.
		await expect(store.pruneCheckpoints(2, { minReclaimBytes: 1 })).rejects.toThrow(/Refusing/)
		expect((await readdir(cpDir())).filter((f) => f.endsWith('.json'))).toHaveLength(2)
		expect(await readFile(join(historyDir(), MAIN), 'utf-8')).toBe(damaged)
		expect(await readdir(historyDir())).toEqual([MAIN])
	})

	it('never collects a line a concurrent write is about to reference', async () => {
		const other = new RunDiskStore({ baseDir: dir })
		await other.initRun(RID)
		const written: IterationCheckpoint[] = []
		for (let turn = 1; turn <= 20; turn++) {
			const cp = checkpoint([
				{ role: 'system', content: `slot ${turn} ${'y'.repeat(4_000)}` },
				...conversation(turn).slice(-3),
			])
			written.push(cp)
			await Promise.all([
				other.writeCheckpoint(cp),
				store.pruneCheckpoints(2, { minReclaimBytes: 1 }),
			])
		}
		const survivors = await store.listCheckpoints()
		for (const cp of survivors) {
			expect(cp.messages).toEqual(written.find((w) => w.id === cp.id)?.messages)
		}
		expect(survivors.at(-1)?.id).toBe(written.at(-1)?.id)
	})
})
