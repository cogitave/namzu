import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyToolOutputBudget } from '../../../runtime/query/tool-output-budget.js'
import { createDiskRunEvidenceSource } from '../disk.js'
import { EVIDENCE_CHUNK_BYTES, digest } from '../format.js'
import type { RunEvidenceSearchResult } from '../types.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(
	outputs: { text: string; truncated?: boolean; isError?: boolean; spill?: boolean }[],
) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-tool-evidence-'))
	roots.push(root)
	const runDir = join(root, 'run')
	const indexDir = join(root, 'index')
	await mkdir(runDir)
	await mkdir(indexDir)
	const scope = {
		tenantId: randomUUID(),
		projectId: randomUUID(),
		sessionId: randomUUID(),
		runId: randomUUID(),
	}
	await writeFile(
		join(runDir, 'run.json'),
		JSON.stringify({ id: scope.runId, metadata: { scope }, status: 'completed' }),
	)
	const events: object[] = [{ type: 'run_started', runId: scope.runId, seq: 1 }]
	for (const [index, output] of outputs.entries()) {
		const toolUseId = `call-${index}`
		const retained = output.spill
			? applyToolOutputBudget({
					toolUseId,
					toolName: 'observe',
					output: output.text,
					maxChars: 1000,
					spillDir: join(runDir, 'tool-output'),
				})
			: null
		events.push({
			type: 'tool_completed',
			runId: scope.runId,
			seq: index + 2,
			toolUseId,
			toolName: 'observe',
			isError: output.isError ?? false,
			result: retained?.output ?? output.text,
			outputTruncated: retained?.truncated ?? output.truncated ?? false,
			...(retained?.spillIntegrity ? { outputSpillIntegrity: retained.spillIntegrity } : {}),
			// A malicious path must never be followed; the identity derives the authorized file.
			outputSpillPath: '/outside/never-read',
		})
	}
	await writeFile(
		join(runDir, 'transcript.jsonl'),
		events.map((event) => JSON.stringify(event)).join('\n') + '\n',
	)
	const options = { scope, runDir, indexDir }
	return {
		...options,
		source: createDiskRunEvidenceSource(options),
		reopen: () => createDiskRunEvidenceSource(options),
	}
}

describe('bounded retained tool evidence', () => {
	it('rebuilds a damaged cache or a valid page copied into the wrong index position', async () => {
		const f = await fixture(
			Array.from({ length: 75 }, (_, i) => ({
				text: i === 0 ? 'EARLY RECEIPT' : 'ordinary output',
			})),
		)
		let page = await f.source.search({ query: 'absent' })
		while (page.nextCursor)
			page = await f.source.search({ query: 'absent', cursor: page.nextCursor })
		const directory = join(f.indexDir, (await readdir(f.indexDir))[0]!)
		const pages = await Promise.all(
			(await readdir(directory))
				.filter((name) => name.endsWith('.page'))
				.map(async (name) => {
					const path = join(directory, name)
					const text = await readFile(path, 'utf8')
					const body = JSON.parse(Buffer.from(text.split('.')[0]!, 'base64url').toString('utf8'))
					return { path, text, offset: body.start.offset }
				}),
		)
		pages.sort((a, b) => a.offset - b.offset)
		await writeFile(pages[0]!.path, pages[1]!.text)
		const rebuilt = await f.reopen().search({ query: 'EARLY' })
		expect(rebuilt.cacheHit).toBe(false)
		expect(rebuilt.matches[0]?.excerpt).toBe('EARLY RECEIPT')
		await writeFile(pages[0]!.path, 'damaged derived cache')
		expect((await f.reopen().search({ query: 'EARLY' })).matches[0]?.excerpt).toBe('EARLY RECEIPT')
	})

	it('pages a durable index across restart without collapsing equal tool results', async () => {
		const f = await fixture(
			Array.from({ length: 75 }, (_, i) => ({
				text: i > 63 ? 'late evidence' : 'same early evidence',
			})),
		)
		const first = await f.source.search({ query: 'late evidence' })
		expect(first.matches).toHaveLength(0)
		expect(first.nextCursor).not.toBeNull()
		expect(first.indexedRecords).toBe(64)
		const cached = await f.reopen().search({ query: 'late evidence' })
		expect(cached.cacheHit).toBe(true)
		expect(cached.indexedRecords).toBe(0)
		expect(cached.scannedBytes).toBeLessThan(200_000)
		const found: number[] = []
		let cursor = first.nextCursor
		while (cursor) {
			const page: RunEvidenceSearchResult = await f
				.reopen()
				.search({ query: 'late evidence', cursor })
			found.push(...page.matches.map((match) => match.seq))
			cursor = page.nextCursor
		}
		expect(found).toEqual(Array.from({ length: 11 }, (_, i) => 66 + i))
	})

	it('retrieves an original 10 MiB spill at a cross-chunk Unicode match without rereading it whole', async () => {
		const prefix = 'x'.repeat(EVIDENCE_CHUNK_BYTES * 80 - 8)
		const needle = 'DELIVERY 🦉 İstanbul'
		const full = prefix + needle + 'z'.repeat(5 * 1024 * 1024)
		const f = await fixture([{ text: full, spill: true }])
		const result = await f.source.search({ query: needle })
		expect(result.incomplete).toBe(false)
		expect(result.matches.length).toBeGreaterThan(0)
		expect(result.scannedBytes).toBeLessThan(1_000_000)
		const match = result.matches[0]!
		expect(match.retained).toBe('full')
		const read = await f.reopen().read({ address: match.address, byteOffset: match.byteOffset })
		expect(read.text).toContain(needle)
		expect(read.text).toBe(
			Buffer.from(full)
				.subarray(read.byteOffset, read.byteOffset + Buffer.byteLength(read.text))
				.toString('utf8'),
		)
		expect(read.scannedBytes).toBeLessThan(1_000_000)
		expect(read.text.length).toBeLessThanOrEqual(6000)
	})

	it('reads every UTF-8 byte once through exact continuation offsets, including chunk edges', async () => {
		const full = '\ufeff' + 'α🦉\r\n\ufeff\0'.repeat(12_000)
		const f = await fixture([{ text: full, spill: true }])
		const address = (await f.source.search()).matches[0]!.address
		let offset: number | null = 0
		let recovered = ''
		while (offset !== null) {
			const page = await f.reopen().read({ address, byteOffset: offset })
			recovered += page.text
			expect(page.text.length).toBeLessThanOrEqual(6000)
			offset = page.nextByteOffset
		}
		expect(recovered).toBe(full)
		await expect(f.source.read({ address, byteOffset: 1 })).rejects.toThrow()
	})

	it('refuses changed or missing spill bytes and does not silently return the preview', async () => {
		const f = await fixture([{ text: 'retained secret '.repeat(8000), spill: true }])
		const address = (await f.source.search()).matches[0]!.address
		const spill = join(f.runDir, 'tool-output', `${digest('call-0')}.txt`)
		const bytes = await readFile(spill)
		bytes[0] = 65
		await writeFile(spill, bytes)
		await expect(f.reopen().read({ address })).rejects.toThrow('changed')
		const search = await f.reopen().search({ query: 'secret' })
		expect(search.matches).toHaveLength(0)
		expect(search.incomplete).toBe(true)
		await rm(spill)
		await expect(f.source.read({ address })).rejects.toThrow()
	})

	it('distinguishes legacy partial text and error output, including a negative query', async () => {
		const f = await fixture([{ text: 'only preview', truncated: true, isError: true }])
		expect((await f.source.search({ query: 'missing' })).incomplete).toBe(true)
		const match = (await f.source.search()).matches[0]!
		expect(match).toMatchObject({ retained: 'preview', isError: true })
		expect(await f.source.read({ address: match.address })).toMatchObject({
			text: 'only preview',
			retained: 'preview',
			isError: true,
		})
	})

	it('binds addresses to the authorized invocation and refuses live or changed sources', async () => {
		const a = await fixture([{ text: 'private result' }])
		const b = await fixture([{ text: 'other result' }])
		const address = (await a.source.search()).matches[0]!.address
		await expect(b.source.read({ address })).rejects.toThrow('different scope')
		await expect(createDiskRunEvidenceSource({ ...a, scope: b.scope }).search()).rejects.toThrow(
			'authorized scope',
		)
		await writeFile(join(a.runDir, 'transcript.jsonl'), 'changed\n')
		await expect(a.source.read({ address })).rejects.toThrow('changed source')
		await writeFile(
			join(b.runDir, 'run.json'),
			JSON.stringify({ id: b.scope.runId, metadata: { scope: b.scope }, status: 'running' }),
		)
		await expect(b.source.search()).rejects.toThrow('not closed')
	})

	it('refuses altered cursors, symlinks, torn records and cancellation', async () => {
		const f = await fixture(Array.from({ length: 70 }, () => ({ text: 'ordinary' })))
		const cursor = (await f.source.search({ query: 'absent' })).nextCursor!
		await expect(f.reopen().search({ query: 'changed', cursor })).rejects.toThrow('query changed')
		await expect(f.reopen().search({ query: 'absent', cursor: `x${cursor}` })).rejects.toThrow()
		await expect(f.source.search({}, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow(
			'cancelled',
		)
		const transcript = join(f.runDir, 'transcript.jsonl')
		await writeFile(transcript, '{"type":"run_started"')
		await expect(f.source.search()).rejects.toThrow('torn')
		await rm(transcript)
		await symlink(join(f.runDir, 'run.json'), transcript)
		await expect(f.source.search()).rejects.toThrow()
	})
})
