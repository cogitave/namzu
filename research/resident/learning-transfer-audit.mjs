// Recompute scores from retained answers, successful tools, final files and receipts.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { retainedUsageIsComplete } from './tool-learning-host.mjs'

const [root, output] = process.argv.slice(2)
if (!root) throw new Error('Usage: node learning-transfer-audit.mjs <study-root> [output.json]')
const report = JSON.parse(await readFile(join(root, 'report.json')))
const specBytes = await readFile(join(root, 'spec.json'))
const runsBytes = await readFile(join(root, 'runs.jsonl'))
const records = runsBytes.toString().trim().split('\n').map(JSON.parse)
assert.equal(records.length, report.spec.cases.length * report.spec.arms.length)
const seen = new Set()
for (const record of records) {
	const fixture = report.spec.cases.find((f) => f.id === record.case)
	assert.ok(fixture && report.spec.arms.includes(record.arm))
	const key = record.case + '/' + record.arm
	assert.ok(!seen.has(key))
	seen.add(key)
	if (record.executionError) {
		assert.equal(record.passed, false)
		continue
	}
	const cwd = join(root, record.case, record.arm)
	const read = record.tools.some(
		(t) =>
			t.name === 'read' &&
			t.success &&
			[fixture.requiredRead, join(cwd, fixture.requiredRead)].includes(t.input.path) &&
			typeof t.output === 'string' &&
			t.output.length > 0,
	)
	const exactFiles =
		JSON.stringify(Object.entries(record.after).sort()) ===
		JSON.stringify(Object.entries(fixture.after ?? fixture.files).sort())
	const correct = record.output?.trim() === fixture.expected
	assert.equal(record.filesCorrect, exactFiles)
	assert.equal(record.readEvidence, read)
	assert.equal(
		record.passed,
		correct &&
			exactFiles &&
			read &&
			record.stopReason === 'end_turn' &&
			retainedUsageIsComplete(record),
	)
}
const summary = Object.fromEntries(
	report.spec.arms.map((arm) => {
		const r = records.filter((r) => r.arm === arm)
		return [
			arm,
			{
				passes: r.filter((r) => r.passed).length,
				total: r.length,
				recordedTokens: r.reduce((n, r) => n + (r.tokens ?? 0), 0),
				unknownReceipts: r.filter((r) => !retainedUsageIsComplete(r)).length,
				toolCalls: r.reduce((n, r) => n + r.tools.length, 0),
				failedTools: r.reduce((n, r) => n + r.tools.filter((t) => !t.success).length, 0),
				skillReads: r.reduce(
					(n, r) => n + r.tools.filter((t) => t.name === 'read_resident_skill' && t.success).length,
					0,
				),
			},
		]
	}),
)
const sha = (b) => createHash('sha256').update(b).digest('hex')
const artifact = {
	study: root,
	live: report.live,
	spec: report.spec,
	specSha256: sha(specBytes),
	runsSha256: sha(runsBytes),
	summary,
	records,
	audited: true,
	limitation:
		'Small diagnostic, no significance or general transfer claim. Unknown receipts are not zero usage; unavailable prices are not zero billed cost. No failed trials were removed or retried.',
}
if (output) await writeFile(output, JSON.stringify(artifact, null, 2) + '\n')
console.log(JSON.stringify({ root, summary, audited: true }))
