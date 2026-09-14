// Fixed-candidate transfer diagnostic, opt-in live Muse low; no learning or promotion.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as sdk from '../../packages/sdk/dist/index.js'
import { model, usageIsComplete } from './tool-learning-host.mjs'

const live = process.argv.includes('--live')
const disclosure = process.argv.includes('--disclosure')
const source = JSON.parse(
	await readFile(new URL('./results/2026-09-14-learning-discovery-muse.json', import.meta.url)),
)
assert.equal(sdk.hashResidentSkill(source.candidate), source.activated[0].hash)
const root = await mkdtemp(join(tmpdir(), 'namzu-learning-transfer-'))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const instructions =
	"Complete the requested task using available tools. Follow the user's scope. Verify claims from successful tool results, preserve unrelated file content, and return only the requested answer."
let cases = []
for (let trial = 0; trial < 2; trial++) {
	const who = (disclosure ? ['Deniz', 'Ada'] : ['Mira', 'Eren'])[trial],
		port = (disclosure ? [7351, 6279] : [8317, 9429])[trial],
		amount = (disclosure ? [23, 29] : [13, 17])[trial]
	cases.push({
		id: `document-${trial}`,
		family: 'document',
		files: {
			'docs/oncall.md': `# On-call rotation\n\nHistorical contact: Robin (ended last month).\n\n| Week | Current primary |\n| --- | --- |\n| This week | ${who} |\n`,
		},
		prompt: "Read docs/oncall.md and return only the name of this week's primary contact.",
		expected: who,
		requiredRead: 'docs/oncall.md',
	})
	cases.push({
		id: `config-${trial}`,
		family: 'config',
		files: {
			'defaults.json': JSON.stringify({ port: 3000, logLevel: 'info', retries: 3 }),
			'local.json': JSON.stringify({ port, logLevel: 'debug' }),
		},
		prompt:
			'Read defaults.json and local.json. Local values override defaults; absent local keys retain defaults. Return the effective port as digits only.',
		expected: String(port),
		requiredRead: 'local.json',
	})
	cases.push({
		id: `ledger-${trial}`,
		family: 'ledger',
		files: {
			'ledger.csv': `id,status,currency,amount\na,paid,EUR,${amount}\nb,pending,EUR,900\nc,paid,USD,800\nd,paid,EUR,-3\ne,paid,EUR,7\n`,
		},
		prompt:
			'Read ledger.csv. Sum amount for rows with status paid and currency EUR, including negative amounts. Return the integer only.',
		expected: String(amount + 4),
		requiredRead: 'ledger.csv',
	})
	const before = 'Welcome.\nManual note: keep this exact sentence.\n',
		addition = `Check ${trial + 1} complete.`
	cases.push({
		id: `edit-${trial}`,
		family: 'edit',
		files: { 'notes.txt': before, 'unrelated.txt': 'Do not change this file.\n' },
		prompt: `Append exactly one line "${addition}" to notes.txt; preserve all existing text and the unrelated file. Return only done.`,
		expected: 'done',
		requiredRead: 'notes.txt',
		after: { 'notes.txt': before + addition + '\n', 'unrelated.txt': 'Do not change this file.\n' },
	})
}
if (disclosure) {
	cases = cases.slice(0, 4)
	for (let trial = 0; trial < 2; trial++) {
		const expected = `current-transfer-${trial}`,
			source = `records/active-${trial}.txt`
		cases.push({
			id: `source-${trial}`,
			family: 'source',
			files: {
				'README.md': 'See docs/settings.txt for the current release_channel.\n',
				'docs/settings.txt': `release_channel=retired-transfer-${trial}\n`,
				'.meta/authority.json': JSON.stringify({
					release_channel: { path: source, key: 'release_channel' },
				}),
				[source]: `release_channel=${expected}\n`,
			},
			prompt: 'What is the current release_channel for this workspace? Return only its value.',
			expected,
			requiredRead: source,
		})
	}
}
const spec = {
	version: disclosure ? 2 : 1,
	model,
	effort: 'low',
	candidate: source.candidate,
	candidateRevision: source.activated[0].hash,
	arms: disclosure ? ['baseline', 'eager', 'on-demand'] : ['baseline', 'eager'],
	cases,
	instructions,
	limits: { iterations: 8, tokens: 24000, timeoutMs: 120000 },
	order: 'rotate arm order by case index; sequential requests; no retries',
	criteria:
		'end_turn + settled usage + exact answer + successful required read + exact complete file manifest',
	limitations:
		'Small isolated fixtures; diagnostic only. Fixed prior accepted candidate, no tuning, no new activation. Provider noise and simple-task ceiling limit generalization.',
}
await writeFile(join(root, 'spec.json'), JSON.stringify(spec, null, 2))
console.log(
	JSON.stringify({
		root,
		live,
		cases: cases.length,
		arms: spec.arms,
		specHash: sha(JSON.stringify(spec)),
	}),
)
const records = []
for (const [index, fixture] of cases.entries())
	for (const arm of [
		...spec.arms.slice(index % spec.arms.length),
		...spec.arms.slice(0, index % spec.arms.length),
	]) {
		const cwd = join(root, fixture.id, arm),
			calls = []
		await mkdir(cwd, { recursive: true })
		for (const [path, body] of Object.entries(fixture.files)) {
			await mkdir(join(cwd, path, '..'), { recursive: true })
			await writeFile(join(cwd, path), body)
		}
		const registry = new sdk.ToolRegistry()
		registry.register(
			sdk
				.getBuiltinTools()
				.filter((t) => ['read', 'glob', 'grep', 'write', 'edit'].includes(t.name))
				.map((tool) => ({
					...tool,
					execute: async (input, ctx) => {
						try {
							const result = await tool.execute(input, ctx)
							calls.push({ name: tool.name, input, ...result })
							return result
						} catch (error) {
							calls.push({ name: tool.name, input, success: false, error: String(error) })
							throw error
						}
					},
				})),
		)
		const { ZenProvider } = live ? await import('../../packages/providers/zen/dist/index.js') : {}
		const turns = [
			...(arm === 'on-demand' && fixture.family === 'source'
				? [
						{
							toolCalls: [
								{ id: 'load', name: 'read_resident_skill', args: { name: source.candidate.name } },
							],
						},
					]
				: []),
			...(arm === 'eager'
				? [
						{
							toolCalls: [
								{ id: 'irrelevant', name: 'read', args: { path: '.meta/authority.json' } },
							],
						},
					]
				: []),
			{ toolCalls: [{ id: 'required', name: 'read', args: { path: fixture.requiredRead } }] },
			...(fixture.after
				? [
						{
							toolCalls: [
								{
									id: 'edit',
									name: 'write',
									args: { path: 'notes.txt', content: fixture.after['notes.txt'] },
								},
							],
						},
					]
				: []),
			{ text: fixture.expected },
		]
		const start = Date.now()
		try {
			const provider = live ? new ZenProvider({ model }) : new sdk.MockLLMProvider({ turns })
			let result
			if (disclosure) {
				const tenantId = sdk.generateTenantId(),
					runId = sdk.generateRunId()
				const state = {
					tenantId,
					agentKey: 'transfer',
					pursuitId: crypto.randomUUID(),
					identity: 'Complete the authorized task.',
					objective: fixture.prompt,
					revision: 1,
					stepsAdmitted: 1,
					phase: 'running',
					wakeAt: null,
					reason: 'New task',
					summary: '',
					claimId: crypto.randomUUID(),
				}
				const learning = {
					revision: 1,
					preferences: [],
					skills: [source.acceptedSkill],
					lastChange: source.acceptedSkill.evidence,
				}
				const options = {
					state,
					learning: arm === 'baseline' ? undefined : learning,
					outputInstructions: 'Return only the answer requested by the user.',
				}
				const bundle =
					arm === 'on-demand'
						? sdk.createResidentStepContext({
								...options,
								authorizeLearningRead: (ctx) => ctx.runId === runId,
							})
						: { contributions: sdk.createResidentStepContributions(options), tools: [] }
				for (const tool of bundle.tools)
					registry.register({
						...tool,
						execute: async (input, ctx) => {
							const r = await tool.execute(input, ctx)
							calls.push({ name: tool.name, input, ...r })
							return r
						},
					})
				const promptContributions = new sdk.PromptContributionRegistry()
				for (const c of bundle.contributions) promptContributions.register(c)
				const run = await sdk.drainQuery({
					provider,
					runId,
					tenantId,
					sessionId: sdk.generateSessionId(),
					projectId: sdk.generateProjectId(),
					topicId: sdk.generateTopicId(),
					agentId: 'transfer',
					agentName: 'Transfer study',
					tools: registry,
					workingDirectory: cwd,
					pathBuilder: new sdk.DefaultPathBuilder(join(root, 'state', fixture.id, arm)),
					systemPrompt: instructions,
					promptContributions,
					messages: [sdk.createUserMessage(fixture.prompt)],
					runConfig: {
						model: live ? model : 'mock-model',
						effort: 'low',
						maxIterations: spec.limits.iterations,
						tokenBudget: spec.limits.tokens,
						timeoutMs: spec.limits.timeoutMs,
					},
				})
				result = { run, output: run.result }
			} else
				result = await sdk.runAgent({
					provider,
					model: live ? model : 'mock-model',
					effort: 'low',
					workingDirectory: cwd,
					pathBuilder: new sdk.DefaultPathBuilder(join(root, 'state', fixture.id, arm)),
					tools: registry,
					instructions:
						instructions +
						(arm === 'eager' ? '\nRetained evaluated guidance:\n' + source.candidate.body : ''),
					prompt: fixture.prompt,
					maxIterations: spec.limits.iterations,
					tokenBudget: spec.limits.tokens,
					timeoutMs: spec.limits.timeoutMs,
				})
			const { run } = result,
				after = {}
			// Read the complete final file manifest, including unexpected newly created files.
			const { readdir } = await import('node:fs/promises')
			for (const path of await readdir(cwd, { recursive: true })) {
				try {
					after[path] = await readFile(join(cwd, path), 'utf8')
				} catch (e) {
					if (e.code !== 'EISDIR') throw e
				}
			}
			const expected = fixture.after ?? fixture.files
			const filesCorrect =
				JSON.stringify(Object.entries(after).sort()) ===
				JSON.stringify(Object.entries(expected).sort())
			const readEvidence = calls.some(
				(c) =>
					c.name === 'read' &&
					c.success &&
					[fixture.requiredRead, join(cwd, fixture.requiredRead)].includes(c.input.path),
			)
			const record = {
				case: fixture.id,
				family: fixture.family,
				arm,
				runId: run.id,
				output: result.output,
				stopReason: run.stopReason,
				lastError: run.lastError,
				lastProviderError: run.lastProviderError,
				tokens: run.tokenUsage.totalTokens,
				budget: run.budget,
				usageComplete: usageIsComplete(run),
				cost: run.costInfo,
				durationMs: Date.now() - start,
				tools: calls,
				after,
				filesCorrect,
				readEvidence,
			}
			record.passed =
				record.stopReason === 'end_turn' &&
				record.usageComplete &&
				(result.output ?? '').trim() === fixture.expected &&
				filesCorrect &&
				readEvidence
			records.push(record)
			await appendFile(join(root, 'runs.jsonl'), JSON.stringify(record) + '\n')
			console.log(
				JSON.stringify({
					case: record.case,
					arm,
					passed: record.passed,
					stop: record.stopReason,
					tokens: record.tokens,
					calls: calls.length,
					failures: calls.filter((c) => !c.success).length,
				}),
			)
		} catch (error) {
			const record = {
				case: fixture.id,
				family: fixture.family,
				arm,
				passed: false,
				executionError: String(error),
				usageComplete: false,
				durationMs: Date.now() - start,
				tools: calls,
			}
			records.push(record)
			await appendFile(join(root, 'runs.jsonl'), JSON.stringify(record) + '\n')
			console.log(JSON.stringify(record))
		}
	}
const report = {
	root,
	live,
	spec,
	records,
	summary: Object.fromEntries(
		spec.arms.map((arm) => {
			const r = records.filter((r) => r.arm === arm)
			return [
				arm,
				{
					passed: r.filter((r) => r.passed).length,
					total: r.length,
					tokens: r.reduce((n, r) => n + (r.tokens ?? 0), 0),
					unknownReceipts: r.filter((r) => !r.usageComplete).length,
					toolCalls: r.reduce((n, r) => n + r.tools.length, 0),
					failedTools: r.reduce((n, r) => n + r.tools.filter((t) => !t.success).length, 0),
				},
			]
		}),
	),
}
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ root, summary: report.summary }))
