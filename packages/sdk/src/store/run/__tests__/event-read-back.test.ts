import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { RunEvent } from '../../../types/run/events.js'
import type { RunStore } from '../../../types/run/store.js'
import { RunDiskStore, readRunEventsIn } from '../disk.js'
import { InMemoryRunStore } from '../memory.js'

/**
 * The read-back is what a consumer that lost its connection catches up
 * through, so the two shipped backends have to answer it identically. A memory
 * store that diverges from disk is worse than none — a host tests against one
 * and ships the other.
 */

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
})

async function baseDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-events-'))
	dirs.push(dir)
	return dir
}

const numbered = (seq: number): RunEvent =>
	({
		type: 'iteration_started',
		runId: '37ddff8e-e13f-4e57-937f-d048fa323f5e',
		iteration: seq,
		seq,
	}) as never

/** Both shipped implementations, bound to the same run id. */
async function backends(): Promise<[string, RunStore][]> {
	const disk = new RunDiskStore({ baseDir: await baseDir(), logger: LOG })
	await disk.initRun('37ddff8e-e13f-4e57-937f-d048fa323f5e')
	const memory = new InMemoryRunStore()
	await memory.initRun('37ddff8e-e13f-4e57-937f-d048fa323f5e')
	return [
		['disk', disk],
		['memory', memory],
	]
}

describe('the two backends answer the same', () => {
	it('gives back everything appended, oldest first', async () => {
		for (const [name, store] of await backends()) {
			for (const seq of [1, 2, 3]) await store.appendEvent(numbered(seq))

			const events = await store.readEvents()

			expect(
				events.map((e) => e.seq),
				name,
			).toEqual([1, 2, 3])
			// Declared on the read-back type and stamped by both writers. It was
			// persisted by two implementations and typed by neither before this.
			expect(typeof events[0]?.timestamp, name).toBe('number')
		}
	})

	it('treats sinceSeq as exclusive, so nothing is delivered twice', async () => {
		for (const [name, store] of await backends()) {
			for (const seq of [1, 2, 3, 4]) await store.appendEvent(numbered(seq))

			// A consumer that last saw 2 must receive 3 and 4 — not 2 again, which
			// would duplicate, and not 4 alone, which would drop 3.
			expect(
				(await store.readEvents({ sinceSeq: 2 })).map((e) => e.seq),
				name,
			).toEqual([3, 4])
		}
	})

	it('returns nothing when the cursor is at the head', async () => {
		for (const [name, store] of await backends()) {
			await store.appendEvent(numbered(1))
			expect((await store.readEvents({ sinceSeq: 1 })).length, name).toBe(0)
		}
	})

	it('returns nothing for a run that has recorded nothing', async () => {
		for (const [name, store] of await backends()) {
			expect((await store.readEvents()).length, name).toBe(0)
		}
	})

	it('carries the payload through, not just the number', async () => {
		for (const [name, store] of await backends()) {
			await store.appendEvent({
				type: 'tool_completed',
				runId: '37ddff8e-e13f-4e57-937f-d048fa323f5e',
				toolUseId: 'call_1',
				toolName: 'echo',
				result: 'hi',
				isError: false,
				seq: 1,
			} as never)

			const [event] = await store.readEvents()

			expect(event, name).toMatchObject({
				type: 'tool_completed',
				toolUseId: 'call_1',
				result: 'hi',
				seq: 1,
			})
		}
	})
})

describe('the in-memory store starts a different run empty', () => {
	it('does not report the previous run’s events as the new one’s', async () => {
		const store = new InMemoryRunStore()
		await store.initRun('111b6f53-2d7f-4bfc-bbe1-56df51712736')
		await store.appendEvent(numbered(1))

		await store.initRun('3140f049-2def-4029-8534-4bcc8840fc38')

		// Evidence attributed to the wrong run is worse than none: it is wrong
		// and it looks right. The disk store gets this for free — a different id
		// is a different directory — and this one has to say it.
		expect(await store.readEvents()).toEqual([])
		expect(store.snapshot().meta).toBeNull()
	})

	it('keeps the log when rebound to the SAME run', async () => {
		const store = new InMemoryRunStore()
		await store.initRun('25badb60-e8f3-4710-aaed-95a83d506a9c')
		await store.appendEvent(numbered(1))

		await store.initRun('25badb60-e8f3-4710-aaed-95a83d506a9c')

		expect((await store.readEvents()).map((e) => e.seq)).toEqual([1])
	})
})

describe('a transcript written before events were numbered', () => {
	it('reads its lines back at their positions rather than losing them', async () => {
		const dir = await baseDir()
		const runDir = join(dir, '1e2cd7b1-df8e-4f19-9f3b-4f0281300ae7')
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('1e2cd7b1-df8e-4f19-9f3b-4f0281300ae7')
		// Exactly what the old emitter wrote: a timestamp, and no seq at all.
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${['run_started', 'iteration_started', 'run_completed']
				.map((type) =>
					JSON.stringify({ type, runId: '1e2cd7b1-df8e-4f19-9f3b-4f0281300ae7', timestamp: 1 }),
				)
				.join('\n')}\n`,
			'utf-8',
		)

		const events = await store.readEvents()

		// Dropping them would erase the run's whole history from a catch-up, and
		// leaving them unnumbered would put the emitter back at 1 on top of a log
		// that already has three entries.
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
		expect(events.map((e) => e.type)).toEqual(['run_started', 'iteration_started', 'run_completed'])
	})

	it('keeps the positions stable once sequenced events are appended after it', async () => {
		const dir = await baseDir()
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('2cff8233-1823-46cf-9028-b20b37044abe')
		await writeFile(
			join(dir, '2cff8233-1823-46cf-9028-b20b37044abe', 'transcript.jsonl'),
			`${JSON.stringify({ type: 'run_started', runId: '2cff8233-1823-46cf-9028-b20b37044abe' })}\n`,
			'utf-8',
		)

		await store.appendEvent(numbered(2))

		expect((await store.readEvents()).map((e) => e.seq)).toEqual([1, 2])
	})

	it('gives an unstamped line a timestamp that cannot be mistaken for a real one', async () => {
		const dir = await baseDir()
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('c51dc6e5-3efd-45d0-9d07-9901a6bd408a')
		await writeFile(
			join(dir, 'c51dc6e5-3efd-45d0-9d07-9901a6bd408a', 'transcript.jsonl'),
			`${JSON.stringify({ type: 'run_started', runId: 'c51dc6e5-3efd-45d0-9d07-9901a6bd408a' })}\n`,
			'utf-8',
		)

		expect((await store.readEvents())[0]?.timestamp).toBe(0)
	})
})

describe('a transcript cut off mid-write', () => {
	it('can refuse the torn record when a caller needs a completeness proof', async () => {
		const dir = await baseDir()
		const runDir = join(dir, '4b4f7e08-b889-4a47-95f6-ff7f4ad52d5e')
		await mkdir(runDir, { recursive: true })
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			'{"type":"run_started","runId":"4b4f7e08-b889-4a47-95f6-ff7f4ad52d5e","seq":1,"timestamp":1}',
			'utf-8',
		)

		await expect(readRunEventsIn(runDir, { integrity: 'strict' })).rejects.toThrow(
			/final record is not newline-terminated/,
		)
	})

	it('can refuse a malformed middle record instead of skipping it', async () => {
		const dir = await baseDir()
		const runDir = join(dir, 'dbe108b1-4f50-49a1-8b09-a8a21eb39aa8')
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('dbe108b1-4f50-49a1-8b09-a8a21eb39aa8')
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${JSON.stringify({ type: 'run_started', runId: 'dbe108b1-4f50-49a1-8b09-a8a21eb39aa8', seq: 1, timestamp: 1 })}\nnot-json\n${JSON.stringify({ type: 'run_completed', runId: 'dbe108b1-4f50-49a1-8b09-a8a21eb39aa8', seq: 3, timestamp: 3 })}\n`,
			'utf-8',
		)

		await expect(readRunEventsIn(runDir, { integrity: 'strict' })).rejects.toThrow(
			/record 2 is not valid JSON/,
		)
		// The reporting default remains intentionally tolerant.
		expect((await readRunEventsIn(runDir)).map((event) => event.seq)).toEqual([1, 3])
	})

	it('can refuse a sequence gap even when every line is valid JSON', async () => {
		const dir = await baseDir()
		const runDir = join(dir, '653fca2c-a330-4c1d-b779-80985af84556')
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('653fca2c-a330-4c1d-b779-80985af84556')
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${JSON.stringify({ type: 'run_started', runId: '653fca2c-a330-4c1d-b779-80985af84556', seq: 1, timestamp: 1 })}\n${JSON.stringify({ type: 'run_completed', runId: '653fca2c-a330-4c1d-b779-80985af84556', seq: 3, timestamp: 3 })}\n`,
			'utf-8',
		)

		await expect(readRunEventsIn(runDir, { integrity: 'strict' })).rejects.toThrow(
			/sequence 3, expected 2/,
		)
	})

	it('loses the fragment and nothing after it', async () => {
		const dir = await baseDir()
		const runDir = join(dir, '69f32250-b3d2-4f37-bda2-c9a58c1228e2')
		const first = new RunDiskStore({ baseDir: dir, logger: LOG })
		await first.initRun('69f32250-b3d2-4f37-bda2-c9a58c1228e2')
		await first.appendEvent(numbered(1))
		// The shape a hard kill during `appendFile` leaves: a line with no
		// newline on the end of it.
		await appendFile(join(runDir, 'transcript.jsonl'), '{"type":"iteration_st', 'utf-8')

		// A different process picks the run up and appends the next event.
		const second = new RunDiskStore({ baseDir: dir, logger: LOG })
		await second.initRun('69f32250-b3d2-4f37-bda2-c9a58c1228e2')
		await second.appendEvent(numbered(3))

		const events = await second.readEvents()

		// Without the heal in `initRun` the fragment and the WHOLE, correct
		// event 3 merge into one unparsable line, and 3 is skipped: the emitter
		// counted it durable and it is gone.
		expect(events.map((e) => e.seq)).toEqual([1, 3])
	})

	it('does not touch a transcript that ends properly', async () => {
		const dir = await baseDir()
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('33feff5e-98bc-4395-bc16-c06999204246')
		await store.appendEvent(numbered(1))
		const before = await readFile(
			join(dir, '33feff5e-98bc-4395-bc16-c06999204246', 'transcript.jsonl'),
			'utf-8',
		)

		await new RunDiskStore({ baseDir: dir, logger: LOG }).initRun(
			'33feff5e-98bc-4395-bc16-c06999204246',
		)

		expect(
			await readFile(
				join(dir, '33feff5e-98bc-4395-bc16-c06999204246', 'transcript.jsonl'),
				'utf-8',
			),
		).toBe(before)
	})
})

describe('reading a run without binding a store to it', () => {
	it('answers from the directory, and creates nothing', async () => {
		const dir = await baseDir()
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('05e9d03d-7c77-431c-bd06-8e2470b59f62')
		await store.appendEvent(numbered(1))

		// The point of the free function: binding a store to read would mkdir the
		// run directory, and a read that mints an empty run then reports it as
		// having no events is indistinguishable from a run that genuinely has
		// none.
		expect(
			(await readRunEventsIn(join(dir, '05e9d03d-7c77-431c-bd06-8e2470b59f62'))).map((e) => e.seq),
		).toEqual([1])
		expect(await readRunEventsIn(join(dir, 'c1ee7f19-d863-4dc8-9aba-aa9297044a35'))).toEqual([])
	})
})
