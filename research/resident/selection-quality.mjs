// Deterministic SDK preparation probe. The paged source below is simulated;
// this measures candidate/quote selection, not disk I/O or model judgement.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { evidenceTokens, evidenceTokenKey } from '../../packages/sdk/dist/utils/evidence-tokens.js'
import { reviewNotes } from './review-notes.mjs'
const adapterUrl =
	process.env.NAMZU_SELECTION_ADAPTER ??
	new URL('../../packages/sdk/dist/manager/resident/evidence-recall.js', import.meta.url).href
const { createResidentEvidenceRecallStep } = await import(adapterUrl)

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = { tenantId: uuid(1), projectId: uuid(2), sessionId: uuid(3), runId: uuid(4) }
const scope = {
	tenantId: owner.tenantId,
	projectId: owner.projectId,
	agentKey: 'reviewer',
	pursuitId: uuid(5),
	throughRevision: 50,
}
const common = {
	...scope,
	identity: 'Review release evidence.',
	objective: 'Compare Atlas deployment, Borealis receipts and Cygnus routing.',
	revision: 10,
	stepsAdmitted: 3,
	phase: 'running',
	wakeAt: null,
	reason: 'Reviewer input',
	claimId: uuid(6),
	summary: 'Deployment checks observed. Await reviewer input.',
	wakeEvidence: [{ reason: 'Compare Borealis receipt and Cygnus routing.', receivedAt: 3 }],
}
const record = (excerpt, revision = 4) => ({ excerpt, revision })
const distractors = Array.from({ length: 20 }, (_, i) =>
	record(`Atlas deployment checks observed: region ${i} ready.`),
)
export const cases = [
	{
		name: 'several-subjects',
		state: common,
		records: [
			record('Atlas deployment RELEASE_A'),
			record('Borealis receipt TRACK_B'),
			record('Cygnus routing DEPOT_C'),
		],
		expected: ['RELEASE_A', 'TRACK_B', 'DEPOT_C'],
	},
	{
		name: 'frequent-matches-before-rare-subjects',
		state: common,
		records: [...distractors, record('Borealis receipt TRACK_B'), record('Cygnus routing DEPOT_C')],
		expected: ['TRACK_B', 'DEPOT_C'],
	},
	{
		name: 'long-summary-forgotten-head',
		state: {
			...common,
			objective: 'Recover the original shipment reference.',
			summary: `Kestrel receipt was inspected. ${reviewNotes}`,
			wakeEvidence: [{ reason: 'Report that original shipment reference.', receivedAt: 3 }],
		},
		records: [record('Kestrel TRACK_K')],
		expected: ['TRACK_K'],
	},
	{
		name: 'long-objective-forgotten-head',
		state: {
			...common,
			objective: `Kestrel receipt is the subject of the final review. Use the following review notes as background, then report its original reference. ${reviewNotes}`,
			summary: 'Awaiting a final decision.',
			wakeEvidence: [{ reason: 'Report the original reference.', receivedAt: 3 }],
		},
		records: [record('Kestrel TRACK_K')],
		expected: ['TRACK_K'],
	},
	{
		name: 'accepted-correction-at-tail',
		state: {
			...common,
			objective: 'Compare original and corrected receipts.',
			summary: 'Delivery progress was reviewed.',
			wakeEvidence: [
				{
					reason:
						'Operations reviewed delivery progress across regions and checked outstanding paperwork before the final review. Correct Borealis.',
					receivedAt: 3,
				},
			],
		},
		records: [record('Borealis OLD_B', 4), record('Borealis NEW_B', 8)],
		expected: ['OLD_B', 'NEW_B'],
	},
	{
		name: 'ambiguous-reference',
		state: {
			...common,
			objective: 'Compare Atlas and Borealis receipts.',
			summary: 'Both receipts were reviewed; neither was selected.',
			wakeEvidence: [{ reason: 'What was its reference?', receivedAt: 3 }],
		},
		records: [record('Atlas TRACK_A'), record('Borealis TRACK_B')],
		expected: ['TRACK_A', 'TRACK_B'],
		ambiguous: true,
	},
]

export async function measure(test) {
	const calls = []
	const discovered = []
	const source = {
		scope,
		async search(options) {
			const scan = options.cursor
				? JSON.parse(Buffer.from(options.cursor, 'base64url'))
				: { terms: options.terms, offset: 0 }
			const terms = new Set(scan.terms.map((term) => evidenceTokenKey(term)))
			const matching = test.records
				.map((r, i) => ({ ...r, seq: i + 1 }))
				.filter((r) => evidenceTokens(r.excerpt).some((w) => terms.has(evidenceTokenKey(w))))
			// One source page belongs to one settled invocation, as in production.
			const revision = matching[scan.offset]?.revision
			const rows = matching
				.slice(scan.offset, scan.offset + 4)
				.filter((r) => r.revision === revision)
			const offset = scan.offset + rows.length
			const nextCursor =
				offset < matching.length
					? Buffer.from(JSON.stringify({ terms: scan.terms, offset })).toString('base64url')
					: null
			const chargedBytes = 200 + Buffer.byteLength(JSON.stringify(rows))
			assert.ok(chargedBytes <= options.maxReadBytes)
			calls.push({
				terms: scan.terms,
				cursorOnly: !!options.cursor,
				allowance: options.maxReadBytes,
				chargedBytes,
			})
			discovered.push(...rows.map((r) => r.excerpt))
			return {
				scope,
				revision: revision ?? null,
				claimId: revision ? uuid(100 + revision) : null,
				nextCursor,
				incomplete: !!nextCursor,
				unavailableRevisions: [],
				historyBytes: 100,
				chargedBytes,
				evidence: revision
					? {
							scope: { ...owner, sessionId: uuid(200 + revision), runId: uuid(300 + revision) },
							matches: rows.map((r) => ({
								...r,
								address: `fixture:${revision}:${r.seq}`,
								toolName: 'read',
								isError: false,
								retained: 'full',
								excerptComplete: true,
								byteOffset: 0,
							})),
							nextCursor: null,
							scannedBytes: chargedBytes - 100,
							indexedRecords: rows.length,
							cacheHit: true,
							incomplete: false,
							unavailable: [],
						}
					: null,
			}
		},
		async read() {
			throw new Error('Automatic recall must not execute a tool.')
		},
	}
	const prepare = createResidentEvidenceRecallStep({ source, state: test.state, scope: owner })
	const result = await prepare({
		runId: owner.runId,
		stepNumber: 1,
		messages: [],
		steps: [],
		prepared: {},
	})
	const context = result?.context ?? ''
	const rows = context
		.split('\n')
		.filter((s) => s.startsWith('{'))
		.map((s) => JSON.parse(s))
	const metadata = rows[0]
	const quotes = rows
		.slice(1)
		.map((r) => r.excerpt ?? '')
		.join('\n')
	assert.ok(context.length <= 6000)
	assert.ok(calls.length <= 4)
	const total = calls.reduce((s, c) => s + c.chargedBytes, 0)
	calls.forEach((c, i) =>
		assert.equal(
			c.allowance,
			8 * 1024 * 1024 - calls.slice(0, i).reduce((s, p) => s + p.chargedBytes, 0),
		),
	)
	return {
		name: test.name,
		expected: test.expected,
		discovered: test.expected.filter((s) => discovered.some((r) => r.includes(s))),
		quoted: test.expected.filter((s) => quotes.includes(s)),
		query: metadata?.querySelection,
		calls,
		simulatedChargedBytes: total,
		chars: context.length,
		incomplete: metadata?.incomplete,
		continuations: metadata?.continuations?.length ?? 0,
		ambiguityResolved: metadata?.queryResolution !== undefined,
		modelJudgement: 'not_measured',
		modelCalls: 0,
		tokens: 0,
		context,
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const modules = {
		adapter: adapterUrl,
		engine:
			process.env.NAMZU_SELECTION_ENGINE ??
			new URL('../../packages/sdk/dist/run/evidence-recall.js', import.meta.url).href,
	}
	const fingerprints = async () =>
		Object.fromEntries(
			await Promise.all(
				Object.entries(modules).map(async ([name, url]) => [
					name,
					createHash('sha256')
						.update(await readFile(new URL(url)))
						.digest('hex'),
				]),
			),
		)
	const before = await fingerprints()
	const results = []
	for (const test of cases) results.push(await measure(test))
	if (process.argv.includes('--verify'))
		for (const result of results) assert.deepEqual(result.quoted, result.expected, result.name)
	assert.deepEqual(await fingerprints(), before)
	const report = {
		label: process.argv[2] ?? 'unlabelled',
		stage: 'sdk_preparation_with_simulated_paged_source',
		sourceBytes: 'simulated, not measured disk reads',
		datasetHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
		adapterHash: createHash('sha256')
			.update(await readFile(new URL(adapterUrl)))
			.digest('hex'),
		fingerprints: before,
		results,
	}
	if (process.argv[3]) await writeFile(process.argv[3], `${JSON.stringify(report, null, 2)}\n`)
	console.log(
		JSON.stringify(
			results.map(({ name, expected, discovered, quoted, calls, chars }) => ({
				name,
				expected: expected.length,
				discovered: discovered.length,
				quoted: quoted.length,
				pages: calls.length,
				chars,
			})),
			null,
			2,
		),
	)
}
