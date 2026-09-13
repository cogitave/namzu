import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, expect, it } from 'vitest'
import { applyToolOutputBudget } from '../../../runtime/query/tool-output-budget.js'
import { evidenceTokenEntries } from '../../../utils/evidence-tokens.js'
import { asRunId } from '../../../utils/id.js'
import { RunDiskStore } from '../../run/disk.js'
import { createDiskRunTextEvidenceSource } from '../disk.js'
import {
	EVIDENCE_CHUNK_BYTES,
	digest,
	encodeSpillManifest,
	mayContainToken,
	spillManifest,
	textFilter,
	tokenFilter,
} from '../format.js'
import { RECORD_BYTES } from '../io.js'
import { passageMatcher } from '../passages.js'
import type { RunTextEvidenceSource } from '../types.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('never rules out inserted token keys, including contextual lowercase and Unicode expansions', () => {
	const words = [
		'DELTA',
		'delta',
		'ΟΣ',
		'ος',
		'οσ',
		'ΟΣΑ',
		'İZMİR',
		'i',
		'I',
		'ı',
		'K',
		'k',
		'ſ',
		's',
		'𐐀',
		'𐐨',
		'文档',
		'id_1',
		'3',
		'13',
	]
	fc.assert(
		fc.property(fc.array(fc.constantFrom(...words), { minLength: 1, maxLength: 200 }), (parts) => {
			const text = parts.join(' \u0301 ')
			const filter = tokenFilter(text)
			for (const query of words)
				if (passageMatcher(query, false, 'token')(text, 0))
					expect(mayContainToken(filter, query)).toBe(true)
		}),
		{ numRuns: 100 },
	)
	expect(mayContainToken(undefined, 'unknown')).toBe(true)
	expect(() => mayContainToken(tokenFilter('').replace(/[^:]+$/, 'invalid'), 'delta')).toThrow(
		'Invalid evidence token filter',
	)
	expect(mayContainToken(tokenFilter(''), 'delta')).toBe(false)
})

it('covers complete token matches at UTF-8 chunk boundaries', () => {
	const pairs = [
		['ORCHID', 'orchid'],
		['ΟΣ', 'ος'],
		['İZMİR', 'İZMİR'],
		['𐐀𐐀', '𐐨𐐨'],
		['文'.repeat(256), '文'.repeat(256)],
	]
	for (const [text, query] of pairs) {
		for (let delta = -4; delta <= 4; delta++) {
			const original = `${' '.repeat(EVIDENCE_CHUNK_BYTES + delta)}${text!} suffix`
			const manifest = JSON.parse(spillManifest(Buffer.from(original)))
			const hit = passageMatcher(query!, false, 'token')(original, 0)!
			expect(hit).toBeDefined()
			const chunk = Math.floor(Buffer.byteLength(original.slice(0, hit.hit)) / EVIDENCE_CHUNK_BYTES)
			expect(mayContainToken(manifest.chunks[chunk].tokenFilter, query!)).toBe(true)
		}
	}
	const text = 'ΟΣ\u0301Α'
	for (const token of evidenceTokenEntries(text))
		expect(mayContainToken(tokenFilter(text), token[0])).toBe(true)
})

it('drops optional acceleration rather than shrinking the existing manifest retention ceiling', () => {
	const chunk = {
		sha256: digest('original'),
		filter: textFilter('original'),
		tokenFilter: tokenFilter('original '.repeat(1024)),
		characterOffset: 0,
	}
	const manifest = {
		version: 1 as const,
		bytes: 2000 * EVIDENCE_CHUNK_BYTES,
		chunkBytes: EVIDENCE_CHUNK_BYTES,
		chunks: Array.from({ length: 2000 }, () => ({ ...chunk })),
	}
	expect(Buffer.byteLength(JSON.stringify(manifest))).toBeGreaterThan(RECORD_BYTES)
	const encoded = encodeSpillManifest(manifest)
	expect(Buffer.byteLength(encoded)).toBeLessThan(RECORD_BYTES)
	const restored = JSON.parse(encoded)
	expect(restored.chunks).toHaveLength(2000)
	expect(restored.chunks.every((part: typeof chunk) => part.tokenFilter === undefined)).toBe(true)
	expect(restored.chunks[0]).toEqual({
		sha256: chunk.sha256,
		filter: chunk.filter,
		characterOffset: 0,
	})
	expect(manifest.chunks[0]?.tokenFilter).toBe(chunk.tokenFilter)
})

async function fixture(
	mode: 'live' | 'closed' | 'snapshot',
	filterStyle: 'normal' | 'absent' | 'foreign' | 'saturated' = 'normal',
) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-token-filter-'))
	roots.push(root)
	const scope = {
		tenantId: randomUUID(),
		projectId: randomUUID(),
		sessionId: randomUUID(),
		runId: asRunId(randomUUID()),
	}
	const store = new RunDiskStore({ baseDir: root })
	const runDir = await store.initRun(scope.runId)
	await writeFile(
		join(runDir, 'run.json'),
		JSON.stringify({
			id: scope.runId,
			status: mode === 'closed' ? 'completed' : 'running',
			metadata: { scope },
		}),
	)
	const sourceText = `${' '.repeat((filterStyle === 'normal' ? 80 : 2) * EVIDENCE_CHUNK_BYTES - 3)}oRcHiD original receipt ${randomUUID()} ${' '.repeat(EVIDENCE_CHUNK_BYTES)}`
	const spillDir = join(runDir, 'tool-output')
	const retained = applyToolOutputBudget({
		toolName: 'read',
		toolUseId: 'original',
		output: sourceText,
		maxChars: 1000,
		spillDir,
	})
	const path = join(spillDir, `${digest('original')}.txt`)
	let integrity = retained.spillIntegrity
	if (filterStyle !== 'normal') {
		const manifest = JSON.parse(await readFile(`${path}.manifest.json`, 'utf8'))
		for (const part of manifest.chunks)
			part.tokenFilter =
				filterStyle === 'absent'
					? undefined
					: filterStyle === 'foreign'
						? 'tokens-v1:unknown:AAAA'
						: tokenFilter('').replace(/[^:]+$/, Buffer.alloc(128, 255).toString('base64'))
		const raw = JSON.stringify(manifest)
		await writeFile(`${path}.manifest.json`, raw)
		integrity = digest(raw)
	}
	await store.appendEvent({ type: 'run_started', runId: scope.runId, seq: 1 })
	await store.appendEvent({
		type: 'tool_completed',
		runId: scope.runId,
		seq: 2,
		toolName: 'read',
		toolUseId: 'original',
		result: retained.output,
		isError: false,
		outputTruncated: true,
		outputSpillIntegrity: integrity,
	})
	const source =
		mode === 'live'
			? (await store.captureTextEvidence(scope, 1024 * 1024))!
			: createDiskRunTextEvidenceSource({
					scope,
					runDir,
					indexDir: join(root, 'index'),
					maxReadBytes: 1024 * 1024,
					...(mode === 'snapshot' ? { consistency: 'snapshot' as const } : {}),
				})
	return { source, sourceText, path }
}

async function search(source: RunTextEvidenceSource) {
	let cursor: string | undefined
	const matches = []
	const unavailable = []
	let bytes = 0
	let pages = 0
	do {
		const page = await source.search({
			terms: ['absent', 'ORCHID'],
			matchMode: 'token',
			caseSensitive: false,
			cursor,
		})
		matches.push(...page.matches)
		unavailable.push(...page.unavailable)
		bytes += page.scannedBytes
		expect(page.scannedBytes).toBeLessThanOrEqual(1024 * 1024)
		cursor = page.nextCursor ?? undefined
		expect(++pages).toBeLessThanOrEqual(3)
	} while (cursor)
	return { matches, bytes, unavailable }
}

it.each(['live', 'closed', 'snapshot'] as const)(
	'reaches a distant token under the existing I/O bound and authenticates positives (%s)',
	async (mode) => {
		const { source, sourceText, path } = await fixture(mode)
		const result = await search(source)
		expect(result.matches).toHaveLength(1)
		expect(result.unavailable).toEqual([])
		expect(result.bytes).toBeLessThan(1024 * 1024)
		const match = result.matches[0]!
		expect(match.excerpt).toContain('oRcHiD original receipt')
		const page = await source.read({ address: match.address, byteOffset: match.byteOffset })
		expect(page.text).toContain('oRcHiD original receipt')
		expect(sourceText.slice(page.characterOffset!, page.characterOffset! + page.text.length)).toBe(
			page.text,
		)
		await writeFile(path, sourceText.replace('oRcHiD', 'forged'))
		await expect(
			source.read({ address: match.address, byteOffset: match.byteOffset }),
		).rejects.toThrow('bytes changed')
		expect((await search(source)).unavailable.length).toBeGreaterThan(0)
	},
)

it.each(['live', 'closed', 'snapshot'] as const)(
	'searches old manifests without treating a missing token index as absence (%s)',
	async (mode) => {
		const { source } = await fixture(mode, 'absent')
		expect((await search(source)).matches[0]?.excerpt).toContain('oRcHiD original receipt')
	},
)

it('rechecks false positives against exact text rather than returning a filter hit', async () => {
	const { source } = await fixture('closed', 'saturated')
	const result = await source.search({
		query: 'ABSENTKEY',
		matchMode: 'token',
		caseSensitive: false,
	})
	expect(result.matches).toEqual([])
	expect(result.unavailable).toEqual([])
	expect(result.nextCursor).toBeNull()
	expect(result.scannedBytes).toBeGreaterThan(100_000)
})

it('uses exact scanning when the stored tokenizer/Unicode version is unknown', async () => {
	expect(mayContainToken('tokens-v1:unknown:AAAA', 'ORCHID')).toBe(true)
	const { source } = await fixture('closed', 'foreign')
	const result = await search(source)
	expect(result.matches[0]?.excerpt).toContain('oRcHiD original receipt')
	expect(result.bytes).toBeGreaterThan(100_000)
})
