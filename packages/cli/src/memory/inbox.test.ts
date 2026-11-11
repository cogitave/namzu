import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionMemoryCandidate } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { INBOX_CLAIM_STALE_MS, INBOX_MAX_ATTEMPTS, MemoryInbox } from './inbox.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

let clock = 1_000
const tick = () => {
	clock += 1
	return clock
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-inbox-'))
	roots.push(root)
	const file = join(root, 'memory-inbox', 'proj.jsonl')
	let n = 0
	const make = () => new MemoryInbox({ file, now: tick, newId: () => `${++n}`.padStart(8, '0') })
	return { root, file, make, inbox: make() }
}

const candidate = (note: string): SessionMemoryCandidate => ({
	sessionId: 's' as never,
	turnId: 't' as never,
	task: 'Session notes',
	decisions: [],
	discoveries: [],
	userRequirements: [note],
	failures: [],
	environment: [],
	files: [],
	evicted: {},
})

const notes = (entries: readonly { candidate: SessionMemoryCandidate }[]) =>
	entries.map((entry) => entry.candidate.userRequirements[0])

describe('memory inbox', () => {
	it('appends one line per candidate in a private directory', async () => {
		const { file, inbox } = setup()
		await inbox.append(candidate('Always use pnpm'))
		await inbox.append(candidate('Never use tabs'))
		const lines = readFileSync(file, 'utf8').trim().split('\n')
		expect(lines).toHaveLength(2)
		if (process.platform !== 'win32') {
			expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700)
		}
		expect(notes(await inbox.pending())).toEqual(['Always use pnpm', 'Never use tabs'])
	})

	it('hands entries over in batches and removes them only after they were applied', async () => {
		const { file, inbox } = setup()
		for (const note of ['a', 'b', 'c']) await inbox.append(candidate(note))
		const seen: string[][] = []
		const result = await inbox.drain(
			async (entries) => {
				// Mid-drain, what is not yet applied is still on disk.
				seen.push(notes(entries) as string[])
				expect(notes(await inbox.pending()).sort()).toEqual(
					seen.length === 1 ? ['a', 'b', 'c'] : ['c'],
				)
			},
			{ batchSize: 2 },
		)
		expect(seen).toEqual([['a', 'b'], ['c']])
		expect(result).toEqual({ applied: 3, kept: 0, dropped: 0 })
		expect(existsSync(file)).toBe(false)
		expect(readdirSync(join(file, '..'))).toEqual([])
	})

	it('keeps what a batch failed to apply, and what lies past the batch limit', async () => {
		const { inbox } = setup()
		for (const note of ['a', 'b', 'c', 'd']) await inbox.append(candidate(note))
		let call = 0
		const result = await inbox.drain(
			async () => {
				call += 1
				if (call === 1) throw new Error('store down')
			},
			{ batchSize: 1, maxBatches: 2 },
		)
		expect(result).toEqual({ applied: 1, kept: 3, dropped: 0 })
		expect(notes(await inbox.pending()).sort()).toEqual(['a', 'c', 'd'])
	})

	it('gives up on an entry that failed too many drains', async () => {
		const { inbox } = setup()
		await inbox.append(candidate('poison'))
		let last = { applied: 0, kept: 0, dropped: 0 }
		for (let i = 0; i < INBOX_MAX_ATTEMPTS; i += 1) {
			last = await inbox.drain(async () => {
				throw new Error('refused')
			})
		}
		expect(last).toEqual({ applied: 0, kept: 0, dropped: 1 })
		expect(await inbox.pending()).toEqual([])
	})

	it('loses nothing when the process dies between the append and any drain', async () => {
		const { make, inbox } = setup()
		await inbox.append(candidate('survives'))
		// A new process: a new object over the same file.
		const next = make()
		const got: string[] = []
		await next.drain(async (entries) => {
			got.push(...(notes(entries) as string[]))
		})
		expect(got).toEqual(['survives'])
	})

	it('re-applies a batch a dead drain left in a claim, once the claim is old enough', async () => {
		const { make, file, inbox } = setup()
		await inbox.append(candidate('half done'))
		// The first drain claims the file and dies inside the handler. Wait for
		// the handler itself: only then has the claim been taken, whatever order
		// the file system answered in.
		let release = (): void => {}
		let entered = (): void => {}
		const inHandler = new Promise<void>((resolve) => {
			entered = resolve
		})
		const stuck = inbox.drain(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
					entered()
				}),
		)
		await inHandler
		const other = make()
		// Too young: another process's live drain is presumed to own it.
		expect(await other.drain(async () => {})).toEqual({ applied: 0, kept: 0, dropped: 0 })
		clock += INBOX_CLAIM_STALE_MS
		const got: string[] = []
		const adopted = await other.drain(async (entries) => {
			got.push(...(notes(entries) as string[]))
		})
		expect(got).toEqual(['half done'])
		expect(adopted.applied).toBe(1)
		release()
		await stuck
		expect(readdirSync(join(file, '..'))).toEqual([])
	})

	it('lets only one of two drains adopt the same stale claim', async () => {
		const { make, file, inbox } = setup()
		await inbox.append(candidate('seed'))
		const dir = join(file, '..')
		// A claim a crashed process left behind, older than the stale limit. The
		// clock moves past the limit here, so the claim's time is a real one
		// whichever tests ran before this.
		clock += INBOX_CLAIM_STALE_MS + 1
		const entry = { id: 'dead0001', at: 1, attempts: 0, candidate: candidate('crashed') }
		writeFileSync(
			join(dir, `proj.claim-${clock - INBOX_CLAIM_STALE_MS - 1}-dead.jsonl`),
			`${JSON.stringify(entry)}\n`,
		)
		const seen: string[] = []
		const handle = async (entries: readonly { candidate: SessionMemoryCandidate }[]) => {
			seen.push(...(notes(entries) as string[]))
		}
		await Promise.all([make().drain(handle), make().drain(handle)])
		expect(seen.filter((note) => note === 'crashed')).toEqual(['crashed'])
		expect(readdirSync(join(file, '..')).filter((name) => name.includes('claim'))).toEqual([])
	})

	it('keeps a line whose append straddled a drain', async () => {
		const { root, file, inbox: first } = setup()
		await first.append(candidate('already there'))
		let n = 100
		let hits = 0
		const racing = new MemoryInbox({
			file,
			now: tick,
			newId: () => `${++n}`.padStart(8, '0'),
			afterAppendWrite: async () => {
				hits += 1
				// A drain claims the file right after the line was written, reads it,
				// and replaces the claim, which loses the old file.
				if (hits === 1) await first.drain(async () => {})
			},
		})
		await racing.append(candidate('straddling'))
		expect(root).toBeTruthy()
		const got: string[] = []
		await first.drain(async (entries) => {
			got.push(...(notes(entries) as string[]))
		})
		expect(got).toContain('straddling')
	})

	it('is idempotent: a second drain over an empty inbox does nothing', async () => {
		const { inbox } = setup()
		await inbox.append(candidate('once'))
		let calls = 0
		const handle = async () => {
			calls += 1
		}
		await inbox.drain(handle)
		expect(await inbox.drain(handle)).toEqual({ applied: 0, kept: 0, dropped: 0 })
		expect(calls).toBe(1)
	})

	it('shares one drain between callers in a process', async () => {
		const { inbox } = setup()
		await inbox.append(candidate('x'))
		let calls = 0
		const handle = async () => {
			calls += 1
		}
		const [a, b] = await Promise.all([inbox.drain(handle), inbox.drain(handle)])
		expect(a).toBe(b)
		expect(calls).toBe(1)
	})

	it('an entry appended during a drain lands in a fresh file and is kept', async () => {
		const { inbox } = setup()
		await inbox.append(candidate('first'))
		await inbox.drain(async () => {
			await inbox.append(candidate('during'))
		})
		expect(notes(await inbox.pending())).toEqual(['during'])
	})

	it('ignores torn and foreign lines', async () => {
		const { file, inbox } = setup()
		await inbox.append(candidate('real'))
		writeFileSync(file, `{"torn":\nnot json\n${readFileSync(file, 'utf8')}`)
		expect(notes(await inbox.pending())).toEqual(['real'])
	})
})
