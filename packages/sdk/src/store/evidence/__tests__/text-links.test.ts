import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RunEvent } from '../../../types/run/events.js'
import { asRunId } from '../../../utils/id.js'
import { RunDiskStore } from '../../run/disk.js'
import { digest } from '../format.js'
import { type RecordPointer, recordPredecessors } from '../record-chain.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-text-links-'))
	roots.push(root)
	const scope = {
		tenantId: randomUUID(),
		projectId: randomUUID(),
		sessionId: randomUUID(),
		runId: asRunId(randomUUID()),
	}
	let store = new RunDiskStore({ baseDir: root })
	const runDir = await store.initRun(scope.runId)
	const path = join(runDir, 'transcript.jsonl')
	await writeFile(
		join(runDir, 'run.json'),
		JSON.stringify({ id: scope.runId, metadata: { scope } }),
	)
	let seq = 0
	const append = async (event: Record<string, unknown>) =>
		store.appendEvent({ ...event, seq: ++seq, runId: scope.runId } as RunEvent)
	const quiet = async (count = 256) => {
		for (let i = 0; i < count; i++) await append({ type: 'iteration_started', iteration: i })
	}
	const reopen = async () => {
		store = new RunDiskStore({ baseDir: root })
		await store.initRun(scope.runId)
	}
	const source = async () => (await store.captureTextEvidence(scope))!
	await append({ type: 'run_started' })
	return { scope, path, append, quiet, reopen, source, store }
}

it('finds older text through long operational stretches, including after writer restart', async () => {
	const f = await fixture()
	await f.append({ type: 'message_completed', content: 'DELTA 🦉 original' })
	await f.quiet(512)
	for (const restart of [false, true]) {
		if (restart) {
			await f.reopen()
			await f.quiet()
		}
		const source = await f.source()
		const page = await source.search({ terms: ['delta'], caseSensitive: false })
		expect(page).toMatchObject({ incomplete: false, nextCursor: null, indexedRecords: 3 })
		expect(page.matches).toHaveLength(1)
		expect(page.matches[0]).toMatchObject({ seq: 2, excerpt: 'DELTA 🦉 original' })
		expect((await source.read({ address: page.matches[0]!.address })).text).toBe(
			'DELTA 🦉 original',
		)
	}
	// Operational consumers still receive every event, with adjacent byte/hash links intact.
	const events = await f.store.readEvents()
	expect(events).toHaveLength(770)
	const lines = (await readFile(f.path, 'utf8')).trimEnd().split('\n')
	let offset = 0
	for (let i = 0; i < lines.length; i++) {
		const raw = Buffer.from(`${lines[i]}\n`)
		if (i > 0) {
			const previous = Buffer.from(`${lines[i - 1]}\n`)
			expect(events[i]!.previousRecord).toEqual({
				offset: offset - previous.length,
				length: previous.length,
				seq: i,
				sha256: digest(previous),
			})
		}
		offset += raw.length
	}
})

it('keeps page ordering and an older captured boundary across new text and operational appends', async () => {
	const f = await fixture()
	for (let i = 0; i < 6; i++) {
		await f.append({ type: 'message_completed', content: `receipt ${i}` })
		await f.quiet(70)
	}
	let page = await (await f.source()).search({ query: 'receipt', limit: 1 })
	const texts = page.matches.map((m) => m.excerpt)
	await f.append({ type: 'message_completed', content: 'receipt outside boundary' })
	await f.quiet()
	while (page.nextCursor) {
		page = await (await f.source()).search({ query: 'receipt', limit: 1, cursor: page.nextCursor })
		expect(page.incomplete).toBe(false)
		texts.push(...page.matches.map((m) => m.excerpt))
	}
	expect(texts).toEqual([
		'receipt 5',
		'receipt 4',
		'receipt 3',
		'receipt 2',
		'receipt 1',
		'receipt 0',
	])
})

it('ignores caller-supplied skip links and keeps torn/nontext chain boundaries visible', async () => {
	const f = await fixture()
	await f.append({ type: 'message_completed', content: 'older' })
	await f.append({ type: 'iteration_started', previousTextRecord: null })
	expect((await (await f.source()).search()).matches[0]?.excerpt).toBe('older')
	await appendFile(f.path, '{"torn')
	await f.reopen()
	await f.quiet()
	await f.append({ type: 'message_completed', content: 'newer', previousTextRecord: null })
	await f.quiet()
	const page = await (await f.source()).search()
	expect(page.matches.map((m) => m.excerpt)).toEqual(['newer'])
	expect(page.incomplete).toBe(true)
	expect(page.nextCursor).toBeNull()
})

it('uses adjacent traversal through an older writer tail without text links', async () => {
	const f = await fixture()
	await f.append({ type: 'message_completed', content: 'legacy text' })
	// Emulate an older writer by preserving its adjacent pointer and omitting only the new field.
	await f.quiet(1)
	const raw = await readFile(f.path, 'utf8')
	const split = raw.lastIndexOf('\n', raw.length - 2) + 1
	const tail = JSON.parse(raw.slice(split))
	tail.previousTextRecord = undefined
	await writeFile(f.path, `${raw.slice(0, split)}${JSON.stringify(tail)}\n`)
	await f.reopen()
	await f.quiet(2)
	const page = await (await f.source()).search({ query: 'legacy' })
	expect(page.matches[0]?.excerpt).toBe('legacy text')
	expect(page.incomplete).toBe(false)
	expect(page.indexedRecords).toBe(5)
	await f.append({ type: 'message_completed', content: 'new observation' })
	await f.quiet()
	expect((await (await f.source()).search({ query: 'legacy' })).matches[0]?.excerpt).toBe(
		'legacy text',
	)
})

it.each([
	{ type: 'tool_completed', result: 42 },
	{ type: 'message_completed', content: false },
	{ type: 'compaction_shed', messages: 'invalid' },
	{ type: 'compaction_shed', messages: [{ role: 'invalid', content: 'text' }] },
])('does not skip malformed content: %j', async (event) => {
	const f = await fixture()
	await f.append(event)
	await f.quiet()
	await f.reopen()
	await f.quiet()
	await expect((await f.source()).search()).rejects.toThrow(/Invalid (tool|message|shed)/)
})

it('skips valid nontext content while retaining shed and tool text', async () => {
	const f = await fixture()
	await f.append({
		type: 'tool_completed',
		toolName: 'read',
		toolUseId: 'read',
		result: 'tool receipt',
		isError: false,
	})
	await f.append({
		type: 'compaction_shed',
		messages: [{ role: 'assistant', content: 'shed receipt' }],
	})
	for (let i = 0; i < 80; i++) {
		await f.append({ type: 'message_completed' })
		await f.append({
			type: 'compaction_shed',
			messages: [{ role: 'user', content: [{ type: 'image' }] }],
		})
	}
	const page = await (await f.source()).search({ query: 'receipt' })
	expect(page.matches.map((m) => m.excerpt)).toEqual(['shed receipt', 'tool receipt'])
	expect(page).toMatchObject({ incomplete: false, nextCursor: null, indexedRecords: 4 })
})

it('authenticates a selected text record through its skip link and checks cancellation', async () => {
	const f = await fixture()
	await f.append({ type: 'message_completed', content: 'original' })
	await f.quiet()
	const source = await f.source()
	await expect(source.search({}, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow(
		'cancelled',
	)
	await writeFile(f.path, (await readFile(f.path, 'utf8')).replace('original', 'modified'))
	await expect(source.search()).rejects.toThrow('chain changed')
})

it('rejects malformed skip links without hiding them after reopening and further appends', async () => {
	const f = await fixture()
	await f.append({ type: 'message_completed', content: 'original' })
	await f.quiet(1)
	const raw = await readFile(f.path, 'utf8')
	const split = raw.lastIndexOf('\n', raw.length - 2) + 1
	const tail = JSON.parse(raw.slice(split))
	tail.previousTextRecord = null
	await writeFile(f.path, `${raw.slice(0, split)}${JSON.stringify(tail)}\n`)
	await f.reopen()
	await f.quiet()
	await expect((await f.source()).search()).rejects.toThrow('text predecessor link')
})

it('rejects cycles, forward, overlapping, contradictory, and disconnected predecessor pointers', () => {
	const pointer: RecordPointer = { offset: 200, length: 100, seq: 3, sha256: 'a'.repeat(64) }
	const previous: RecordPointer = { offset: 100, length: 100, seq: 2, sha256: 'b'.repeat(64) }
	for (const next of [
		null,
		pointer,
		{ ...previous, offset: 101 },
		{ ...previous, sha256: 'c'.repeat(64) },
		{ ...previous, seq: 4 },
		{},
	]) {
		expect(() =>
			recordPredecessors({ previousRecord: previous, previousTextRecord: next }, pointer),
		).toThrow()
	}
	expect(() =>
		recordPredecessors({ previousRecord: null, previousTextRecord: previous }, pointer),
	).toThrow('text predecessor link')
})
