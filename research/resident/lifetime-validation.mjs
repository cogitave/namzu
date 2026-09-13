// Curate existing local validation evidence. This command does not rerun checks or infer their exit codes.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { readProbeFile } from './lifetime-audit.mjs'

const checks = [
	['workspace typecheck', '/tmp/namzu-resident-mean-typecheck.log', '> tsc --build'],
	['workspace lint', '/tmp/namzu-resident-mean-lint.log', 'packages/cli lint: Done'],
	['workspace build', '/tmp/namzu-consumption-uuid-build.log', 'packages/cli build: Done'],
	[
		'workspace tests before SDK follow-up corrections',
		'/tmp/namzu-consumption-workspace-tests-final.log',
		'packages/cli test: Done',
	],
	['final SDK tests', '/tmp/namzu-resident-mean-sdk.log', '6825 passed'],
	['CLI tests', '/tmp/namzu-consumption-uuid-cli.log', '3052 passed | 5 skipped'],
	['final SDK process tests', '/tmp/namzu-resident-final-process.log', '266 passed'],
	['SDK coverage', '/tmp/namzu-resident-final-coverage.log', '6825 passed'],
	[
		'SDK coverage floors',
		'/tmp/namzu-resident-final-coverage-gate.log',
		'per-module coverage floor gate passed',
	],
	['documentation conformance', '/tmp/namzu-resident-mean-docs.log', 'passed'],
	[
		'TypeScript documentation fences',
		'/tmp/namzu-resident-mean-fences.log',
		'50 fence(s) compiled',
	],
	['evaluations', '/tmp/namzu-consumption-evals.log', 'Wrote /tmp/namzu-consumption-evals.json'],
	[
		'consumer package installation at 0a0baf25',
		'/tmp/namzu-consumer-check.log',
		'span-smoke both green',
	],
	[
		'publint at 0a0baf25',
		'/tmp/namzu-consumption-publint-fixed-build.log',
		'Running publint v0.3.24 for @namzu/zen',
	],
	['source name audit', '/tmp/namzu-consumption-external.log', ''],
	['log standard', '/tmp/namzu-consumption-log-standard.log', ''],
	['model prices', '/tmp/namzu-consumption-prices.log', ''],
	['signature exports', '/tmp/namzu-consumption-uuid-signature.log', ''],
	['lifecycle audit regressions', '/tmp/namzu-lifetime-audit-final.log', 'pass 8'],
]
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const logs = []
for (const [check, path, marker] of checks) {
	const bytes = await readProbeFile(path, 32 * 1024 * 1024)
	const text = bytes.toString('utf8')
	assert.ok(!marker || text.includes(marker), `Expected validation marker missing: ${check}`)
	logs.push({
		check,
		path,
		bytes: bytes.length,
		sha256: sha256(bytes),
		expectedMarker: marker || null,
		tail: text
			.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
			.trim()
			.split('\n')
			.slice(-8)
			.join('\n'),
	})
}
const failures = []
for (const [kind, path] of [
	[
		'short-soak assertion selected a completion in the wait-input check',
		'/tmp/namzu-lifetime-soak-O4Ljlz/result.json',
	],
	['scale fixture supplied a nonfuture wake time', '/tmp/namzu-lifetime-scale-Q8Xv9C/result.json'],
]) {
	const bytes = await readProbeFile(path, 8 * 1024 * 1024)
	const value = JSON.parse(bytes)
	assert.ok(value.failure && !value.passed)
	failures.push({ kind, path, sha256: sha256(bytes), failure: value.failure })
}
for (const [kind, path] of [
	['UUID alias regression before the fix', '/tmp/namzu-consumption-uuid-repro.log'],
	['finite-mean regression before the fix', '/tmp/namzu-resident-mean-repro.log'],
	['wrong root formatter configuration', '/tmp/namzu-consumption-uuid-lint.log'],
	['publint overlapped build output cleanup', '/tmp/namzu-consumption-publint.log'],
]) {
	const bytes = await readProbeFile(path, 1024 * 1024)
	failures.push({
		kind,
		path,
		sha256: sha256(bytes),
		tail: bytes.toString('utf8').trim().split('\n').slice(-20).join('\n'),
	})
}
await writeFile(
	new URL('./lifetime-validation.json', import.meta.url),
	JSON.stringify(
		{
			version: 1,
			curatedAt: Date.now(),
			sourceCommits: ['0a0baf25', '830f81eb', '9a4877ac'],
			note: 'These are retained command logs and observed outcomes, not a substitute for rerunning release gates before a push. Packaging checks used the feature commit; later SDK fixes changed no metadata. Lint has 15 existing CLI warnings and the CLI suite has five existing skips.',
			logs,
			failures,
		},
		null,
		2,
	) + '\n',
)
console.log(JSON.stringify({ logs: logs.length, retainedFailures: failures.length }))
