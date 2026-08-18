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
	({ type: 'iteration_started', runId: 'run_1', iteration: seq, seq }) as never

/** Both shipped implementations, bound to the same run id. */
async function backends(): Promise<[string, RunStore][]> {
	const disk = new RunDiskStore({ baseDir: await baseDir(), logger: LOG })
	await disk.initRun('run_1')
	const memory = new InMemoryRunStore()
	await memory.initRun('run_1')
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
				runId: 'run_1',
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
		await store.initRun('run_first')
		await store.appendEvent(numbered(1))

		await store.initRun('run_second')

		// Evidence attributed to the wrong run is worse than none: it is wrong
		// and it looks right. The disk store gets this for free — a different id
		// is a different directory — and this one has to say it.
		expect(await store.readEvents()).toEqual([])
		expect(store.snapshot().meta).toBeNull()
	})

	it('keeps the log when rebound to the SAME run', async () => {
		const store = new InMemoryRunStore()
		await store.initRun('run_same')
		await store.appendEvent(numbered(1))

		await store.initRun('run_same')

		expect((await store.readEvents()).map((e) => e.seq)).toEqual([1])
	})
})

describe('a transcript written before events were numbered', () => {
	it('reads its lines back at their positions rather than losing them', async () => {
		const dir = await baseDir()
		const runDir = join(dir, 'run_legacy')
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('run_legacy')
		// Exactly what the old emitter wrote: a timestamp, and no seq at all.
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${['run_started', 'iteration_started', 'run_completed']
				.map((type) => JSON.stringify({ type, runId: 'run_legacy', timestamp: 1 }))
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
		await store.initRun('run_mixed')
		await writeFile(
			join(dir, 'run_mixed', 'transcript.jsonl'),
			`${JSON.stringify({ type: 'run_started', runId: 'run_mixed' })}\n`,
			'utf-8',
		)

		await store.appendEvent(numbered(2))

		expect((await store.readEvents()).map((e) => e.seq)).toEqual([1, 2])
	})

	it('gives an unstamped line a timestamp that cannot be mistaken for a real one', async () => {
		const dir = await baseDir()
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('run_undated')
		await writeFile(
			join(dir, 'run_undated', 'transcript.jsonl'),
			`${JSON.stringify({ type: 'run_started', runId: 'run_undated' })}\n`,
			'utf-8',
		)

		expect((await store.readEvents())[0]?.timestamp).toBe(0)
	})
})

describe('a transcript cut off mid-write', () => {
	it('can refuse the torn record when a caller needs a completeness proof', async () => {
		const dir = await baseDir()
		const runDir = join(dir, 'run_torn_strict')
		await mkdir(runDir, { recursive: true })
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			'{"type":"run_started","runId":"run_torn_strict","seq":1,"timestamp":1}',
			'utf-8',
		)

		await expect(readRunEventsIn(runDir, { integrity: 'strict' })).rejects.toThrow(
			/final record is not newline-terminated/,
		)
	})

	it('can refuse a malformed middle record instead of skipping it', async () => {
		const dir = await baseDir()
		const runDir = join(dir, 'run_malformed_strict')
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('run_malformed_strict')
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${JSON.stringify({ type: 'run_started', runId: 'run_malformed_strict', seq: 1, timestamp: 1 })}\nnot-json\n${JSON.stringify({ type: 'run_completed', runId: 'run_malformed_strict', seq: 3, timestamp: 3 })}\n`,
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
		const runDir = join(dir, 'run_gap_strict')
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('run_gap_strict')
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${JSON.stringify({ type: 'run_started', runId: 'run_gap_strict', seq: 1, timestamp: 1 })}\n${JSON.stringify({ type: 'run_completed', runId: 'run_gap_strict', seq: 3, timestamp: 3 })}\n`,
			'utf-8',
		)

		await expect(readRunEventsIn(runDir, { integrity: 'strict' })).rejects.toThrow(
			/sequence 3, expected 2/,
		)
	})

	it('loses the fragment and nothing after it', async () => {
		const dir = await baseDir()
		const runDir = join(dir, 'run_torn')
		const first = new RunDiskStore({ baseDir: dir, logger: LOG })
		await first.initRun('run_torn')
		await first.appendEvent(numbered(1))
		// The shape a hard kill during `appendFile` leaves: a line with no
		// newline on the end of it.
		await appendFile(join(runDir, 'transcript.jsonl'), '{"type":"iteration_st', 'utf-8')

		// A different process picks the run up and appends the next event.
		const second = new RunDiskStore({ baseDir: dir, logger: LOG })
		await second.initRun('run_torn')
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
		await store.initRun('run_intact')
		await store.appendEvent(numbered(1))
		const before = await readFile(join(dir, 'run_intact', 'transcript.jsonl'), 'utf-8')

		await new RunDiskStore({ baseDir: dir, logger: LOG }).initRun('run_intact')

		expect(await readFile(join(dir, 'run_intact', 'transcript.jsonl'), 'utf-8')).toBe(before)
	})
})

describe('reading a run without binding a store to it', () => {
	it('answers from the directory, and creates nothing', async () => {
		const dir = await baseDir()
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('run_free')
		await store.appendEvent(numbered(1))

		// The point of the free function: binding a store to read would mkdir the
		// run directory, and a read that mints an empty run then reports it as
		// having no events is indistinguishable from a run that genuinely has
		// none.
		expect((await readRunEventsIn(join(dir, 'run_free'))).map((e) => e.seq)).toEqual([1])
		expect(await readRunEventsIn(join(dir, 'run_that_never_existed'))).toEqual([])
	})
})
