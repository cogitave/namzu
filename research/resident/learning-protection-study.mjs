// Fixed-candidate requalification through the actual CLI learning gate; opt-in Muse low.
// The host selects existing content deterministically. No claim of new candidate generation.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as sdk from '../../packages/sdk/dist/index.js'
import { model, usageIsComplete } from './tool-learning-host.mjs'

const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const cli = join(repo, 'packages/cli/dist/bin.js')
const instructions =
	"Complete the requested task using available tools. Follow the user's scope. Verify claims from successful tool results, preserve unrelated file content, and return only the requested answer."

function fixtures(phase) {
	const cases = []
	for (let trial = 0; trial < 2; trial++) {
		const salt = phase === 'verification' ? 0 : 20
		const who = ['Mina', 'Can', 'Lale', 'Ali'][(salt ? 2 : 0) + trial]
		const port = 7501 + salt + trial,
			amount = 31 + salt + trial
		const source = `records/current-${salt + trial}.txt`,
			expected = `active-protection-${salt + trial}`
		const rows = [
			{
				family: 'source',
				files: {
					'README.md': 'See docs/settings.txt for the current release_channel.\n',
					'docs/settings.txt': `release_channel=retired-${phase}-${trial}\n`,
					'.meta/authority.json': JSON.stringify({
						release_channel: { path: source, key: 'release_channel' },
					}),
					[source]: `release_channel=${expected}\n`,
				},
				prompt: 'What is the current release_channel for this workspace? Return only its value.',
				expected,
				reads: [source],
				stale: `retired-${phase}-${trial}`,
			},
			{
				family: 'document',
				files: {
					'docs/oncall.md': `# On-call\nHistorical primary: Robin (last month).\nCurrent primary this week: ${who}.\n`,
				},
				prompt: "Read docs/oncall.md and return only the name of this week's primary contact.",
				expected: who,
				reads: ['docs/oncall.md'],
			},
			{
				family: 'config',
				files: {
					'defaults.json': '{"port":3000,"retries":3}',
					'local.json': JSON.stringify({ port }),
				},
				prompt:
					'Read defaults.json and local.json. Local values override defaults; absent local keys retain defaults. Return the effective port as digits only.',
				expected: String(port),
				reads: ['defaults.json', 'local.json'],
			},
			{
				family: 'ledger',
				files: {
					'ledger.csv': `id,status,currency,amount\na,paid,EUR,${amount}\nb,pending,EUR,900\nc,paid,USD,800\nd,paid,EUR,-3\ne,paid,EUR,7\n`,
				},
				prompt:
					'Read ledger.csv. Sum amount for rows with status paid and currency EUR, including negative amounts. Return the integer only.',
				expected: String(amount + 4),
				reads: ['ledger.csv'],
			},
			{
				family: 'edit',
				files: {
					'notes.txt': 'Welcome.\nManual note: preserve this exact sentence.\n',
					'unrelated.txt': 'Unrelated content.\n',
				},
				prompt: `Append exactly one line "Check ${salt + trial} complete." to notes.txt; preserve all existing text and the unrelated file. Return only done.`,
				expected: 'done',
				reads: ['notes.txt'],
				after: {
					'notes.txt': `Welcome.\nManual note: preserve this exact sentence.\nCheck ${salt + trial} complete.\n`,
					'unrelated.txt': 'Unrelated content.\n',
				},
			},
		]
		for (const row of rows)
			cases.push({
				...row,
				taskId: `${phase}-${row.family}`,
				id: `${phase}-${row.family}-${trial}`,
				trial,
			})
	}
	return cases
}

async function runCase(root, spec, fixture, arm, context, store) {
	const cwd = join(root, 'cases', fixture.id, arm),
		calls = []
	await mkdir(cwd, { recursive: true })
	for (const [path, body] of Object.entries(fixture.files)) {
		await mkdir(join(cwd, path, '..'), { recursive: true })
		await writeFile(join(cwd, path), body)
	}
	const runId = sdk.generateRunId(),
		tenantId = sdk.generateTenantId()
	const registry = new sdk.ToolRegistry()
	const register = (tool) =>
		registry.register({
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
		})
	for (const tool of sdk
		.getBuiltinTools()
		.filter((t) => ['read', 'glob', 'grep', 'write', 'edit'].includes(t.name)))
		register(tool)
	const bundle = sdk.createResidentStepContext({
		state: {
			tenantId,
			agentKey: 'protection-study',
			pursuitId: randomUUID(),
			identity: 'Complete the authorized task.',
			objective: fixture.prompt,
			revision: 1,
			stepsAdmitted: 1,
			phase: 'running',
			wakeAt: null,
			reason: 'New task',
			summary: '',
			claimId: randomUUID(),
		},
		learning:
			arm === 'candidate'
				? {
						revision: 1,
						preferences: [],
						skills: [spec.acceptedSkill],
						lastChange: spec.acceptedSkill.evidence,
					}
				: undefined,
		outputInstructions: 'Return only the answer requested by the user.',
		authorizeLearningRead: (ctx) => ctx.runId === runId,
	})
	bundle.tools.forEach(register)
	const promptContributions = new sdk.PromptContributionRegistry()
	bundle.contributions.forEach((c) => promptContributions.register(c))
	const scriptedAnswer =
		fixture.family === 'source' && arm === 'baseline' ? fixture.stale : fixture.expected
	const scriptReads =
		fixture.family === 'source' && arm === 'baseline' ? ['docs/settings.txt'] : fixture.reads
	const turns = [
		...(fixture.family === 'source' && arm === 'candidate'
			? [
					{
						toolCalls: [
							{ id: 'load', name: 'read_resident_skill', args: { name: spec.candidate.name } },
						],
					},
				]
			: []),
		{ toolCalls: scriptReads.map((path, i) => ({ id: `read${i}`, name: 'read', args: { path } })) },
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
		{
			text:
				spec.fault === 'regression' &&
				arm === 'candidate' &&
				fixture.family === 'document' &&
				fixture.trial === 0
					? 'wrong'
					: scriptedAnswer,
		},
	]
	const provider = spec.live
		? new (await import('../../packages/providers/zen/dist/index.js')).ZenProvider({ model })
		: new sdk.MockLLMProvider({ turns })
	const started = Date.now()
	await appendFile(
		join(root, 'attempts.jsonl'),
		JSON.stringify({ runId, case: fixture.id, arm, started }) + '\n',
	)
	const run = await sdk.drainQuery({
		provider,
		runId,
		tenantId,
		projectId: sdk.generateProjectId(),
		sessionId: sdk.generateSessionId(),
		topicId: sdk.generateTopicId(),
		agentId: 'protection-study',
		agentName: 'Protection study',
		tools: registry,
		workingDirectory: cwd,
		pathBuilder: new sdk.DefaultPathBuilder(join(root, 'state', fixture.id, arm)),
		systemPrompt: instructions,
		promptContributions,
		messages: [sdk.createUserMessage(fixture.prompt)],
		runConfig: {
			model: spec.live ? model : 'mock-model',
			effort: 'low',
			maxIterations: spec.limits.iterations,
			tokenBudget: spec.limits.tokens,
			timeoutMs: spec.limits.timeoutMs,
		},
		signal: context.signal,
	})
	const after = {}
	for (const path of await readdir(cwd, { recursive: true })) {
		try {
			after[path] = await readFile(join(cwd, path), 'utf8')
		} catch (error) {
			if (error.code !== 'EISDIR') throw error
		}
	}
	const filesCorrect =
		sha(Object.entries(after).sort()) === sha(Object.entries(fixture.after ?? fixture.files).sort())
	const readEvidence = fixture.reads.every((path) =>
		calls.some(
			(c) => c.name === 'read' && c.success && [path, join(cwd, path)].includes(c.input.path),
		),
	)
	const record = {
		case: fixture.id,
		taskId: fixture.taskId,
		trial: fixture.trial,
		arm,
		runId,
		output: run.result,
		stopReason: run.stopReason,
		lastError: run.lastError,
		lastProviderError: run.lastProviderError,
		tokens: run.tokenUsage.totalTokens,
		usageComplete: usageIsComplete(run),
		budget: run.budget,
		cost: run.costInfo,
		tools: calls,
		after,
		filesCorrect,
		readEvidence,
		durationMs: Date.now() - started,
	}
	record.passed =
		record.stopReason === 'end_turn' &&
		record.usageComplete &&
		String(record.output ?? '').trim() === fixture.expected &&
		filesCorrect &&
		readEvidence
	await appendFile(join(root, 'runs.jsonl'), JSON.stringify(record) + '\n')
	await store.putArtifact(context.cycleId, `run-${runId}`, record)
	await context.recordUsage({
		runId,
		tokens: record.usageComplete ? record.tokens : null,
		costUsd:
			record.usageComplete && run.costInfo?.unpricedTokens === 0 ? run.costInfo.totalCost : null,
	})
	console.log(
		`${fixture.id} · ${arm} · ${record.passed ? 'passed' : 'failed'} · ${record.tokens} recorded tokens`,
	)
	return record
}

export default async function createHost(host, root) {
	const spec = JSON.parse(await readFile(join(root, 'spec.json'), 'utf8'))
	assert.equal(sdk.hashResidentSkill(spec.candidate), spec.acceptedSkill.hash)
	return {
		skillName: spec.candidate.name,
		failure: {
			evidence: {
				key: 'transfer-diagnostic',
				source: 'research/resident/results/2026-09-14-learning-transfer-before.json',
				reason:
					'Prior fixed-candidate experiment observed unrelated-task failure and extra tool use.',
			},
			trace:
				'Requalify the unchanged prior candidate under on-demand disclosure and predeclared unrelated preservation tasks. No new candidate generation.',
		},
		protection: spec.protection,
		resources: { unit: 'tokens', maxUnits: 1000000 },
		generate: async (context) => {
			await host.store.putArtifact(context.cycleId, 'specification', spec)
			const receipt = { runId: randomUUID(), tokens: 0, costUsd: 0 }
			await host.store.putArtifact(context.cycleId, 'candidate-selection', {
				kind: 'deterministic-host-operation',
				receipt,
				candidateHash: spec.acceptedSkill.hash,
			})
			await context.recordUsage(receipt)
			return { candidate: spec.candidate, usageComplete: true }
		},
		evaluate: async (context) => {
			const records = []
			const cases = spec[context.stage]
			for (const [index, fixture] of cases.entries())
				for (const arm of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
					records.push(await runCase(root, spec, fixture, arm, context, host.store))
			const trials = (arm) =>
				records
					.filter((r) => r.arm === arm)
					.map((r) => {
						const fixture = cases.find((f) => f.id === r.case)
						return {
							taskId: r.taskId,
							trial: r.trial,
							conditions: sha({
								fixture,
								model: spec.live ? model : 'mock-model',
								effort: 'low',
								limits: spec.limits,
								instructions,
								disclosure: 'on-demand',
								scorer: spec.scorer,
							}),
							trajectoryId: r.runId,
							result: {
								case: r.case,
								passed: r.passed,
								status: r.passed ? 'passed' : 'failed',
								mean: Number(r.passed),
								scores: {
									exact: {
										score: Number(r.passed),
										reason:
											'Exact output, successful required reads and full preserved file manifest.',
									},
								},
								run: {
									output: r.output,
									steps: [],
									toolCalls: r.tools,
									totalTokens: r.tokens,
									totalCostUsd: r.cost?.totalCost ?? 0,
									durationMs: r.durationMs,
									...(r.stopReason !== 'end_turn' || !r.usageComplete
										? { error: r.lastError ?? `Unsettled run: ${r.stopReason}` }
										: {}),
								},
							},
						}
					})
			const baseline = trials('baseline'),
				candidate = trials('candidate')
			// Host-owned trace check: source value/path is fixed outside model context. No model judges itself.
			const taskId = `${context.stage}-source`
			const before = records.filter((r) => r.taskId === taskId && r.arm === 'baseline'),
				after = records.filter((r) => r.taskId === taskId && r.arm === 'candidate')
			const improvement =
				after.filter((r) => r.passed).length > before.filter((r) => r.passed).length &&
				after.every((r) => !r.passed || r.readEvidence)
			const attributions = improvement
				? [
						{
							taskId,
							effect: 'improvement',
							reason:
								'Retained source trials show the candidate reading the designated current file and returning its value where baseline returned a different value or lacked that read; exact host source and final manifest checked.',
							baselineTrajectories: before.map((r) => r.runId),
							candidateTrajectories: after.map((r) => r.runId),
						},
					]
				: []
			return {
				batch: {
					baselineRevision: context.baselineRevision,
					candidateRevision: context.candidateRevision,
					baseline,
					candidate,
					attributions,
				},
				usageComplete: records.every((r) => r.usageComplete),
			}
		},
	}
}

async function inspect(root) {
	const home = join(root, 'home'),
		[projectId] = await readdir(join(home, 'residents'))
	const binding = JSON.parse(
		await readFile(join(home, 'residents', projectId, 'default/binding.json')),
	)
	const store = new sdk.SqliteResidentLearningStore({
		databasePath: join(home, 'state/learning.sqlite'),
		artifactsPath: join(home, 'learning/artifacts'),
		scope: { ...binding, projectId },
		readOnly: true,
	})
	const cycles = await store.list()
	const records = (await readFile(join(root, 'runs.jsonl'), 'utf8').catch(() => ''))
		.trim()
		.split('\n')
		.filter(Boolean)
		.map(JSON.parse)
	const spec = JSON.parse(await readFile(join(root, 'spec.json'), 'utf8'))
	for (const r of records) {
		const f = spec[r.taskId.startsWith('confirmation') ? 'confirmation' : 'verification'].find(
			(f) => f.id === r.case,
		)
		const readEvidence = f.reads.every((path) =>
			r.tools.some(
				(c) =>
					c.name === 'read' &&
					c.success &&
					[path, join(root, 'cases', f.id, r.arm, path)].includes(c.input.path),
			),
		)
		const filesCorrect =
			sha(Object.entries(r.after).sort()) === sha(Object.entries(f.after ?? f.files).sort())
		assert.equal(
			r.passed,
			r.stopReason === 'end_turn' &&
				r.usageComplete &&
				String(r.output ?? '').trim() === f.expected &&
				readEvidence &&
				filesCorrect,
		)
	}
	const agenda = await new sdk.DiskResidentAgenda(
		join(home, 'residents', projectId),
		binding,
	).read()
	const report = {
		root,
		spec,
		cycles,
		events: cycles[0] ? await store.events(cycles[0].cycleId) : [],
		records,
		active: agenda.learning?.skills ?? [],
		totalRecordedTokens: records.reduce((n, r) => n + r.tokens, 0),
		unknownReceipts: records.filter((r) => !r.usageComplete).length,
		dataHash: sha(records),
		limitations:
			'Small synthetic requalification of a fixed historical candidate under on-demand disclosure. Deterministic candidate selection costs zero model tokens; no new learned candidate. All attempts retained, no retry or answer tuning. Unknown prices/receipts remain unknown. Attributions are host source/output checks, not an external model review. Parent TUI consumption is separate.',
	}
	await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
	console.log(
		JSON.stringify({
			root,
			status: cycles[0]?.status,
			calls: records.length,
			tokens: report.totalRecordedTokens,
			unknown: report.unknownReceipts,
			review: cycles[0]?.result?.review,
		}),
	)
	return report
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.includes('--inspect'))
		await inspect(process.argv[process.argv.indexOf('--inspect') + 1])
	else {
		const root = await mkdtemp(join(tmpdir(), 'namzu-protection-')),
			home = join(root, 'home'),
			cwd = join(root, 'workspace')
		await mkdir(home, { mode: 0o700 })
		await mkdir(cwd)
		const source = JSON.parse(
			await readFile(new URL('./results/2026-09-14-learning-discovery-muse.json', import.meta.url)),
		)
		const protection = Object.fromEntries(
			['verification', 'confirmation'].map((phase) => [
				phase,
				['document', 'config', 'ledger', 'edit'].map((f) => `${phase}-${f}`),
			]),
		)
		const spec = {
			version: 1,
			live: process.argv.includes('--live'),
			fault: process.argv.includes('--regression') ? 'regression' : null,
			model,
			effort: 'low',
			candidate: source.candidate,
			acceptedSkill: source.acceptedSkill,
			protection,
			verification: fixtures('verification'),
			confirmation: fixtures('confirmation'),
			limits: { iterations: 8, tokens: 24000, timeoutMs: 120000 },
			scorer: 'exact+required-reads+full-manifest+end-turn+settled-usage/v1',
			order: 'sequential, rotating arms by case; no retries',
			preparedAt: new Date().toISOString(),
		}
		assert.ok(!spec.live || !spec.fault, 'Fault injection is a scripted control only.')
		await writeFile(join(root, 'spec.json'), JSON.stringify(spec, null, 2))
		await writeFile(
			join(home, 'preferences.json'),
			JSON.stringify({ version: 3, providers: [{ id: 'zen', model }], subagents: { active: [] } }),
		)
		await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
		const modulePath = join(cwd, 'protection.learning.mjs')
		await writeFile(
			modulePath,
			`import factory from ${JSON.stringify(import.meta.url)};\nexport default host => factory(host, ${JSON.stringify(root)});\n`,
		)
		const command = async (args) => {
			try {
				return await promisify(execFile)(
					process.execPath,
					[cli, 'resident', ...args, '--cwd', cwd],
					{ cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 1200000, maxBuffer: 3000000 },
				)
			} catch (e) {
				if (typeof e.code !== 'number') throw e
				return e
			}
		}
		const added = await command([
			'add',
			'--trust',
			'Requalify current-source guidance without degrading unrelated file tasks.',
		])
		assert.ok(!added.code, added.stderr)
		await writeFile(
			join(root, 'setup.json'),
			JSON.stringify({ root, home, cwd, modulePath, cli }, null, 2),
		)
		console.log(JSON.stringify({ root, home, cwd, modulePath, live: spec.live }))
		if (!process.argv.includes('--prepare')) {
			const result = await command(['learn', modulePath, '--trust'])
			await writeFile(join(root, 'cli.txt'), result.stdout + '\n' + result.stderr)
			console.log(result.stdout)
			await inspect(root)
		}
	}
}
