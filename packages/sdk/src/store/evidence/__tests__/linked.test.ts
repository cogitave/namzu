import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { applyToolOutputBudget } from '../../../runtime/query/tool-output-budget.js'
import type { RunEvent } from '../../../types/run/events.js'
import { asRunId } from '../../../utils/id.js'
import { RunDiskStore } from '../../run/disk.js'
import { createDiskRunTextEvidenceSource } from '../disk.js'
import { EVIDENCE_CHUNK_BYTES, digest } from '../format.js'
import type { RunTextEvidenceSearchResult } from '../types.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-linked-evidence-'))
	roots.push(root)
	const scope = {
		tenantId: randomUUID(),
		projectId: randomUUID(),
		sessionId: randomUUID(),
		runId: asRunId(randomUUID()),
	}
	const store = new RunDiskStore({ baseDir: root })
	const runDir = await store.initRun(scope.runId)
	const meta = (owner = scope, status = 'running') =>
		writeFile(
			join(runDir, 'run.json'),
			JSON.stringify({ id: scope.runId, metadata: { scope: owner }, status }),
		)
	await meta()
	let seq = 0
	const append = async (event: Record<string, unknown>) => {
		await store.appendEvent({ ...event, runId: scope.runId, seq: ++seq } as RunEvent)
		return seq
	}
	await append({ type: 'run_started' })
	const source = async () => (await store.captureTextEvidence(scope))!
	return { root, runDir, scope, store, append, source, meta }
}

it('keeps an old search boundary and exact Unicode pages while concurrent appends continue', async () => {
	const f = await fixture()
	const text = '\ufeff' + 'α🦉\r\n'.repeat(20_000) + `UNIQUE ${randomUUID()}` + 'β'.repeat(20_000)
	const toolUseId = 'effect-once'
	const retained = applyToolOutputBudget({
		toolUseId,
		toolName: 'mutate',
		output: text,
		maxChars: 1000,
		spillDir: join(f.runDir, 'tool-output'),
	})
	await f.append({
		type: 'tool_completed',
		toolUseId,
		toolName: 'mutate',
		result: retained.output,
		isError: false,
		outputTruncated: true,
		outputSpillIntegrity: retained.spillIntegrity,
	})
	await Promise.all(
		Array.from({ length: 80 }, (_, i) =>
			f.append({ type: 'message_completed', content: `later ${i}` }),
		),
	)
	const initial = await f.source()
	let page = await initial.search({ query: 'UNIQUE' })
	expect(page.matches).toHaveLength(0)
	expect(page.nextCursor).not.toBeNull()
	// Each continuation is resolved through a fresh writer capture, as separate tool calls do.
	await f.append({ type: 'message_completed', content: 'UNIQUE added after search boundary' })
	page = await (await f.source()).search({ query: 'UNIQUE', cursor: page.nextCursor! })
	expect(page.matches).toHaveLength(1)
	const match = page.matches[0]!
	expect(match.seq).toBe(2)
	const near = await (await f.source()).read({
		address: match.address,
		byteOffset: match.byteOffset,
	})
	expect(text.slice(near.characterOffset, near.characterOffset! + near.text.length)).toBe(near.text)
	expect(near.text).toContain('UNIQUE')
	let offset: number | null = 0
	let recovered = ''
	while (offset !== null) {
		await f.append({ type: 'message_completed', content: 'append between reads' })
		const read = await (await f.source()).read({ address: match.address, byteOffset: offset })
		expect(read.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		expect(read.characterOffset).toBe(recovered.length)
		recovered += read.text
		offset = read.nextByteOffset
	}
	expect(recovered).toBe(text)
	await expect(initial.search({ query: 'changed', cursor: page.nextCursor! })).rejects.toThrow()
	const lines = (await readFile(join(f.runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n')
	expect(
		lines.map((line) => JSON.parse(line)).filter((event) => event.type === 'tool_completed'),
	).toHaveLength(1)
})

it('does not confuse appended records, altered earlier bytes, and altered spill bytes', async () => {
	const f = await fixture()
	const retained = applyToolOutputBudget({
		toolUseId: 'receipt',
		toolName: 'observe',
		output: 'original '.repeat(20_000),
		maxChars: 1000,
		spillDir: join(f.runDir, 'tool-output'),
	})
	await f.append({
		type: 'tool_completed',
		toolName: 'observe',
		toolUseId: 'receipt',
		result: retained.output,
		isError: false,
		outputTruncated: true,
		outputSpillIntegrity: retained.spillIntegrity,
	})
	const source = await f.source()
	const match = (await source.search()).matches[0]!
	await appendFile(join(f.runDir, 'transcript.jsonl'), '{"unfinished":')
	expect((await source.read({ address: match.address })).text).toContain('original')
	const spill = join(f.runDir, 'tool-output', `${digest('receipt')}.txt`)
	const full = await readFile(spill, 'utf8')
	await writeFile(spill, full.replace('original', 'altered!'))
	await expect(source.read({ address: match.address })).rejects.toThrow('bytes changed')
	await writeFile(spill, full)
	const log = join(f.runDir, 'transcript.jsonl')
	await writeFile(log, (await readFile(log, 'utf8')).replace('original', 'modified'))
	await expect(source.read({ address: match.address })).rejects.toThrow('changed')
	await expect(source.search()).rejects.toThrow('chain changed')
})

it('bounds shed-part pagination and refuses foreign scopes, stale owners and cancellation', async () => {
	const f = await fixture()
	await f.append({
		type: 'compaction_shed',
		messages: Array.from({ length: 130 }, (_, i) => ({ role: 'user', content: `shed ${i}` })),
	})
	let cursor: string | undefined
	const parts: number[] = []
	do {
		const page: RunTextEvidenceSearchResult = await (await f.source()).search({
			query: 'shed',
			cursor,
		})
		expect(page.indexedRecords).toBeLessThanOrEqual(64)
		expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		parts.push(...page.matches.map((match) => match.part))
		cursor = page.nextCursor ?? undefined
		await f.append({ type: 'message_completed', content: 'outside original boundary' })
		expect(parts.length).toBeLessThanOrEqual(130)
	} while (cursor)
	expect(parts).toEqual(Array.from({ length: 130 }, (_, i) => i))
	const source = await f.source()
	const hit = (await source.search({ seq: 2, part: 0 })).matches[0]!
	await expect(f.store.captureTextEvidence({ ...f.scope, runId: randomUUID() })).rejects.toThrow(
		'does not own',
	)
	const other = (await f.store.captureTextEvidence({ ...f.scope, sessionId: randomUUID() }))!
	await expect(other.read({ address: hit.address })).rejects.toThrow('authorized scope')
	await expect(source.search({}, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow(
		'cancelled',
	)
	await f.meta({ ...f.scope, sessionId: randomUUID() })
	await expect(source.search()).rejects.toThrow('authorized scope')
})

it('reopens a complete log and recovers earlier text, while writer cursors expire on restart', async () => {
	const f = await fixture()
	await f.append({ type: 'message_completed', content: 'before restart' })
	const old = await f.source()
	const match = (await old.search()).matches[0]!
	const reopened = new RunDiskStore({ baseDir: f.root })
	await reopened.initRun(f.scope.runId)
	await reopened.appendEvent({
		type: 'message_completed',
		runId: f.scope.runId,
		seq: 3,
		content: 'after restart',
	} as RunEvent)
	const current = (await reopened.captureTextEvidence(f.scope))!
	expect((await current.search({ query: 'before restart' })).matches[0]?.seq).toBe(2)
	await expect(current.read({ address: match.address })).rejects.toThrow(
		'different scope or changed source',
	)
	await f.meta(f.scope, 'completed')
	const closed = createDiskRunTextEvidenceSource({
		scope: f.scope,
		runDir: f.runDir,
		indexDir: join(f.runDir, 'evidence-index'),
	})
	expect((await closed.search({ query: 'before restart' })).matches[0]?.seq).toBe(2)
})

it('stops with explicit incomplete evidence at a torn or unlinked boundary', async () => {
	const f = await fixture()
	await f.append({ type: 'message_completed', content: 'older' })
	await appendFile(join(f.runDir, 'transcript.jsonl'), '{"torn')
	const reopened = new RunDiskStore({ baseDir: f.root })
	await reopened.initRun(f.scope.runId)
	await reopened.appendEvent({
		type: 'message_completed',
		runId: f.scope.runId,
		seq: 3,
		content: 'newer',
	} as RunEvent)
	const page = await (await reopened.captureTextEvidence(f.scope))!.search()
	expect(page.matches.map((match) => match.excerpt)).toEqual(['newer'])
	expect(page.incomplete).toBe(true)
	expect(page.nextCursor).toBeNull()
})

it('refuses a record that cannot fit the requested budget instead of returning a stuck cursor', async () => {
	const f = await fixture()
	await f.append({ type: 'message_completed', content: 'x'.repeat(2 * 1024 * 1024) })
	const source = (await f.store.captureTextEvidence(f.scope, 1024 * 1024))!
	await expect(source.search()).rejects.toThrow('page budget')
	const normal = await f.source()
	const page = await normal.search({ query: 'xxx', limit: 1 })
	expect(page.matches).toHaveLength(1)
	expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
})

it.each(['live', 'closed'] as const)(
	'pages distinct passages and preserves exact Unicode positions (%s)',
	async (mode) => {
		const f = await fixture()
		// Two hits in one 64 KiB chunk, one crossing its boundary and one owned by the next chunk.
		let text = `${'α🦉'.repeat(400)}DELTA tracking=TRACK-original${' '.repeat(1800)}Destination of DELTA: DEPOT-original`
		text += `${' '.repeat(EVIDENCE_CHUNK_BYTES - 3 - Buffer.byteLength(text))}dElTa boundary`
		text += `${' '.repeat(1200)}DELTA fourth${' '.repeat(600)}`
		const retained = applyToolOutputBudget({
			toolUseId: 'passages',
			toolName: 'read',
			output: text,
			maxChars: 1000,
			spillDir: join(f.runDir, 'tool-output'),
		})
		await f.append({
			type: 'tool_completed',
			toolUseId: 'passages',
			toolName: 'read',
			result: retained.output,
			isError: false,
			outputTruncated: true,
			outputSpillIntegrity: retained.spillIntegrity,
		})
		if (mode === 'closed') await f.meta(f.scope, 'completed')
		const source =
			mode === 'live'
				? await f.source()
				: createDiskRunTextEvidenceSource({
						scope: f.scope,
						runDir: f.runDir,
						indexDir: join(f.root, 'index'),
					})
		const query = 'delta'
		expect((await source.search({ query })).matches).toHaveLength(0) // SDK default stays case sensitive.
		const matches = []
		let cursor: string | undefined
		for (let count = 0; count < 10; count++) {
			const page = await source.search({ query, caseSensitive: false, limit: 1, cursor })
			expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
			expect(page.incomplete).toBe(false)
			expect(page.matches.length).toBeLessThanOrEqual(1)
			matches.push(...page.matches)
			if (page.nextCursor)
				await expect(
					source.search({ query, caseSensitive: true, cursor: page.nextCursor }),
				).rejects.toThrow('query changed')
			cursor = page.nextCursor ?? undefined
			if (!cursor) break
		}
		expect(cursor).toBeUndefined()
		expect(matches).toHaveLength(4)
		for (const [index, label] of [
			'TRACK-original',
			'DEPOT-original',
			'boundary',
			'fourth',
		].entries()) {
			const match = matches[index]!
			expect(match.excerpt).toContain(label)
			expect(text.slice(match.characterOffset, match.characterOffset! + match.excerpt.length)).toBe(
				match.excerpt,
			)
			expect(
				Buffer.from(text)
					.subarray(match.byteOffset, match.byteOffset + Buffer.byteLength(match.excerpt))
					.toString(),
			).toBe(match.excerpt)
			const read = await source.read({ address: match.address, byteOffset: match.byteOffset })
			expect(read.text).toContain(label)
			expect(read.text).toBe(
				text.slice(read.characterOffset, read.characterOffset! + read.text.length),
			)
		}
	},
)

it.each(['live', 'closed'] as const)(
	'matches literal Unicode case without changing inline text (%s)',
	async (mode) => {
		const f = await fixture()
		const text = 'İ α🦉 a.*[B] Σςσ K abc Ä end'
		await f.append({ type: 'message_completed', content: text })
		if (mode === 'closed') await f.meta(f.scope, 'completed')
		const source =
			mode === 'live'
				? await f.source()
				: createDiskRunTextEvidenceSource({
						scope: f.scope,
						runDir: f.runDir,
						indexDir: join(f.root, 'index'),
					})
		for (const query of ['A.*[b]', 'σΣΣ', 'k', 'ä']) {
			const page = await source.search({ query, caseSensitive: false })
			expect(page.matches).toHaveLength(1)
			expect(page.matches[0]!.excerpt).toBe(text)
			expect((await source.search({ query, caseSensitive: true })).matches).toHaveLength(0)
		}
		expect((await source.search({ query: 'a.*[c]', caseSensitive: false })).matches).toHaveLength(0)
	},
)
