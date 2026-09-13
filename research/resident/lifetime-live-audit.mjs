// Re-audit already closed live fixtures; never constructs a provider or executes a resident.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { digestProbeState, inspectionBuild, readProbeFile } from './lifetime-audit.mjs'

const exec = promisify(execFile)
const [currentRoot, repairRoot, output] = process.argv.slice(2)
assert.ok(
	currentRoot?.startsWith('/tmp/namzu-claim-live-') &&
		repairRoot?.startsWith('/tmp/namzu-claim-live-') &&
		output,
)
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
const buildBefore = await inspectionBuild()
const cases = []
for (const [id, root, seededRequests] of [
	['current', currentRoot, 0],
	['repair', repairRoot, 1],
]) {
	const rawBytes = await readProbeFile(join(root, 'result.json'), 8 * 1024 * 1024)
	const raw = JSON.parse(rawBytes)
	assert.equal(raw.root, root)
	assert.equal(raw.live, true)
	assert.equal(raw.model, 'codex/gpt-5.6-luna')
	assert.equal(raw.effort, 'low')
	assert.equal(raw.failure, undefined)
	assert.equal(raw.buildStable, true)
	assert.deepEqual(raw.buildBefore, raw.buildAfter)
	assert.equal(raw.cases.length, 1)
	const row = raw.cases[0]
	assert.equal(row.id, id)
	assert.equal(row.phase, 'complete')
	assert.ok(row.commands.every((c) => c.exit === 0))
	assert.equal(row.finishes.length, 1)
	assert.equal(row.runs.length, 1)
	const finish = row.finishes[0]
	assert.equal(finish.decision.kind, 'complete')
	assert.equal(finish.error, null)
	assert.equal(finish.cleanup, 'confirmed')
	assert.equal(finish.runId, row.runs[0].id)
	assert.equal(finish.usage.totalTokens, row.runs[0].tokenUsage.totalTokens)
	assert.equal(finish.usage.totalTokens, row.providerTokens)
	assert.equal(finish.budget.ownTokens, row.providerTokens)
	assert.equal(finish.budget.treeTokens, row.providerTokens)
	assert.equal(finish.usage.cost.unpricedTokens, row.providerTokens)
	assert.deepEqual(finish.verification.receipt.claims, { version: '3.0.0' })
	const verifiedScope = JSON.parse(finish.verification.receipt.scope)
	assert.equal(verifiedScope.runId, finish.runId)
	assert.equal(verifiedScope.claimId, finish.claimId)
	assert.equal(finish.verification.receipt.runId, finish.runId)
	const workspace = join(root, id, 'workspace')
	const sourceBytes = await readProbeFile(join(workspace, 'package.json'), 4096)
	assert.equal(
		finish.verification.receipt.observations[0].sha256,
		createHash('sha256').update(sourceBytes).digest('hex'),
	)
	assert.ok(
		row.tools.some((t) => t.type === 'tool_completed' && t.toolName === 'read' && !t.isError),
	)
	assert.ok(row.tools.every((t) => t.toolName === 'read'))
	if (seededRequests) assert.ok(row.requests.slice(1).every((r) => r.feedback.length > 0))
	assert.equal(row.requests.length - seededRequests, 2)

	const home = join(root, id, 'home')
	const before = await digestProbeState(home)
	const { stdout } = await exec(
		process.execPath,
		[cli, '--quiet', '--format', 'json', 'resident', 'inspect', '--cwd', workspace],
		{ env: { ...process.env, NAMZU_HOME: home }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
	)
	assert.deepEqual(await digestProbeState(home), before, 'Inspector modified closed live evidence.')
	const { inspection } = JSON.parse(stdout)
	assert.equal(inspection.historyComplete, true)
	assert.equal(inspection.usageComplete, true)
	assert.equal(inspection.attempts.length, 1)
	assert.equal(inspection.attempts[0].receipt.verification, 'recorded')
	assert.equal(inspection.attempts[0].settlement.outcome, 'complete')
	assert.equal(inspection.recorded.ownTokens, row.providerTokens)
	assert.equal(inspection.recorded.treeTokens, row.providerTokens)
	assert.equal(inspection.recorded.unpricedOwnTokens, row.providerTokens)
	assert.deepEqual(inspection.unknown, {
		ownUsageAttempts: 0,
		treeUsageAttempts: 0,
		ownPriceAttempts: 1,
	})
	cases.push({
		id,
		root,
		sourceSha256: createHash('sha256').update(rawBytes).digest('hex'),
		model: raw.model,
		effort: raw.effort,
		buildBefore: raw.buildBefore,
		buildAfter: raw.buildAfter,
		realRequests: row.requests.length - seededRequests,
		scriptedReplies: seededRequests,
		modelReceivedRejection: row.requests.slice(seededRequests).some((r) => r.feedback.length > 0),
		phase: row.phase,
		recordedTokens: row.providerTokens,
		toolEvents: row.tools.map((t) => ({
			type: t.type,
			toolName: t.toolName,
			isError: t.isError ?? null,
		})),
		verification: finish.verification,
		usage: finish.usage,
		budget: finish.budget,
		inspection,
		inspectionReadOnly: true,
		inspectedStateFiles: Object.keys(before).length,
	})
}
assert.deepEqual(await inspectionBuild(), buildBefore, 'Inspector changed during audit.')
const result = {
	version: 1,
	auditedAt: Date.now(),
	inspectionBuild: buildBefore,
	cases,
	totalRealRequests: cases.reduce((n, c) => n + c.realRequests, 0),
	totalScriptedReplies: cases.reduce((n, c) => n + c.scriptedReplies, 0),
	totalRecordedTokens: cases.reduce((n, c) => n + c.recordedTokens, 0),
	note: 'The repair seed is scripted, not a model error. Token usage is retained; prices are unknown. This small supplement is not a model performance benchmark.',
	passed: true,
}
await writeFile(output, JSON.stringify(result, null, 2) + '\n')
console.log(
	JSON.stringify({
		passed: true,
		realRequests: result.totalRealRequests,
		scriptedReplies: result.totalScriptedReplies,
		tokens: result.totalRecordedTokens,
	}),
)
