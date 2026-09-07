/** Check the unmodified baseline and private references without any model calls. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

if (!process.argv[2]) throw new Error('Usage: node preflight.mjs GENERATED_OUTPUT_DIRECTORY')
const root = resolve(process.argv[2])
const privateDir = join(root, 'private')
const results = []
for (const [name, phase, visiblePasses, hiddenPasses, expectedExit] of [
	['baseline-workspace', 'base', 8, 3, 1],
	['reference-base', 'base', 12, 8, 0],
	['reference-steered', 'steered', 12, 15, 0],
]) {
	const child = spawnSync(
		process.execPath,
		[join(privateDir, 'grade.mjs'), join(privateDir, name), phase],
		{ encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
	)
	assert.ifError(child.error)
	assert.equal(child.status, expectedExit, `${name}: ${child.stderr}\n${child.stdout}`)
	const report = JSON.parse(child.stdout)
	assert.equal(report.visible.tests, 12)
	assert.equal(report.visible.passed, visiblePasses)
	assert.equal(report.hidden.tests, 15)
	assert.equal(report.hidden.passed, hiddenPasses)
	assert.equal(report.hidden.skipped, phase === 'base' ? 7 : 0)
	assert.ok(report.preservation.every((item) => item.pass))
	assert.deepEqual(report.prohibitedSourcePatternFlags, [])
	results.push({
		name,
		phase,
		passed: report.passed,
		visible: { passed: report.visible.passed, failed: report.visible.failed },
		hidden: {
			passed: report.hidden.passed,
			failed: report.hidden.failed,
			skipped: report.hidden.skipped,
		},
	})
}
const report = { kind: 'offline-fixture-preflight', node: process.version, modelCalls: 0, results }
await writeFile(join(privateDir, 'preflight-result.json'), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
