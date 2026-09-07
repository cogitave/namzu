/** Controlled mechanism ablations through the real SDK; the provider is scripted. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import {
	MockLLMProvider,
	ToolRegistry,
	DefaultPathBuilder,
	defineTool,
	drainQuery,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../packages/sdk/dist/index.js'
import { ExecutiveWorkspace } from './executive.mjs'
import { recallAssociations } from './association.mjs'

const { z } = createRequire(new URL('../../packages/sdk/package.json', import.meta.url))('zod')
const root = await mkdtemp(join(tmpdir(), 'namzu-cognitive-probe-'))
const externalFetch = globalThis.fetch
globalThis.fetch = () => {
	throw new Error('Network forbidden in the cognitive mechanism probe')
}

const goal = {
	id: 'healthy-fixture',
	description: 'Restore the synthetic gateway',
	constraints: ['Operate only on in-memory fixture state'],
	criteria: [{ key: 'healthy', value: true }],
}
const turns = [
	{ toolCalls: [{ name: 'cached_write', args: {} }] },
	{ text: 'Done.' },
	{ toolCalls: [{ name: 'cached_write', args: {} }] },
	{ text: 'Done.' },
	{ toolCalls: [{ name: 'fresh_write', args: {} }] },
	{ toolCalls: [{ name: 'verify_health', args: {} }] },
	{ text: 'Done.' },
]

async function trial(variant) {
	let healthy = false
	let calls = 0
	let sequence = 0
	const executed = []
	const decisions = []
	// Host-curated links describe an earlier related procedure, not evidence
	// that this current environment is healthy or permission to run new tools.
	const associations = recallAssociations({
		scope: variant,
		nodes: ['gateway', 'router_configuration', 'cached_write', 'fresh_write'].map((id) => ({
			id,
			scope: variant,
		})),
		edges:
			variant === 'without_association'
				? []
				: [
						{
							scope: variant,
							from: 'gateway',
							to: 'router_configuration',
							type: 'related',
							weight: 1,
						},
						{
							scope: variant,
							from: 'router_configuration',
							to: 'fresh_write',
							type: 'procedure_for',
							weight: 1,
						},
					],
		cues: [
			{ id: 'gateway', weight: 1 },
			{ id: 'cached_write', weight: 1 },
		],
	})
	const candidates = associations.ranking
		.filter((item) => item.activation > 0 && ['cached_write', 'fresh_write'].includes(item.id))
		.map((item) => item.id)
	const workspace = new ExecutiveWorkspace({ scope: variant, goal })
	workspace.observe({
		id: 'initial',
		scope: variant,
		revision: 1,
		key: 'healthy',
		value: false,
		origin: 'tool',
		source: 'fixture',
	})
	workspace.setPlan('cached_write')
	const tools = new ToolRegistry()
	for (const name of ['cached_write', 'fresh_write', 'verify_health']) {
		tools.register(
			defineTool({
				name,
				description: 'Local synthetic state operation',
				inputSchema: z.object({}),
				permissions: [],
				readOnly: name === 'verify_health',
				execute: async () => {
					executed.push(name)
					const actionId = `attempt-${++sequence}`
					const verifies = name === 'verify_health'
					workspace.setPlan(name)
					workspace.begin({
						actionId,
						mayChangeState: !verifies,
						requiresProgress: !verifies,
						expected: [{ key: verifies ? 'healthy' : 'installed', value: true }],
					})
					if (name === 'fresh_write') healthy = true
					const revision = workspace.inspect().environmentRevision
					workspace.observe({
						id: actionId,
						scope: variant,
						revision,
						key: verifies ? 'healthy' : 'installed',
						value: verifies ? healthy : name === 'fresh_write',
						origin: 'tool',
						source: 'fixture-sensor',
						actionId,
					})
					// The failing intervention has an observed unchanged health signal.
					if (name === 'cached_write')
						workspace.observe({
							id: `${actionId}-health`,
							scope: variant,
							revision,
							key: 'healthy',
							value: healthy,
							origin: 'tool',
							source: 'fixture-sensor',
							actionId,
						})
					workspace.settle({ actionId, evidenceIds: [actionId], transportSuccess: true })
					return {
						success: true,
						output: verifies ? `Health check: ${healthy}` : 'Operation accepted.',
					}
				},
			}),
		)
	}
	const controlled = variant !== 'baseline'
	const provider = new MockLLMProvider({
		turns,
		onRequest: () => {
			calls += 1
		},
	})
	const started = performance.now()
	const cpu = process.cpuUsage()
	const run = await drainQuery({
		provider,
		tools,
		agentId: 'cognitive-probe',
		agentName: 'Cognitive probe',
		messages: [{ role: 'user', content: goal.description }],
		workingDirectory: root,
		pathBuilder: new DefaultPathBuilder(join(root, variant)),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		runConfig: { model: 'mock', tokenBudget: 100000, maxIterations: 7, timeoutMs: 10000 },
		...(controlled
			? {
					beforeStep: ({ signal }) => {
						signal?.throwIfAborted()
					},
					prepareStep: () => {
						let state = workspace.inspect()
						if (state.mode === 'replan' && variant !== 'without_outcome_control') {
							workspace.setPlan(workspace.recommendStrategy(candidates))
							state = workspace.inspect()
						}
						const selected =
							state.mode === 'complete'
								? []
								: ['observe', 'verify'].includes(state.mode)
									? ['verify_health']
									: [state.plan]
						decisions.push({ mode: state.mode, selected })
						return {
							activeTools: selected,
							system: `Observed control state: ${JSON.stringify(state)}`,
						}
					},
				}
			: {}),
		...(controlled && variant !== 'without_completion_gate'
			? {
					reviewAnswer: () =>
						workspace.canConclude()
							? { accept: true }
							: {
									accept: false,
									feedback:
										'Current environment evidence does not satisfy the goal. Continue with an admitted action.',
								},
					maxAnswerReviews: 4,
				}
			: {}),
	})
	// Final authority is explicit. A completed SDK run alone does not establish
	// evidence-based completion (reviewAnswer is deliberately not a hard guard).
	const verified = workspace.canConclude()
	const used = process.cpuUsage(cpu)
	return {
		variant,
		verified,
		actualHealthy: healthy,
		runStatus: run.status,
		stopReason: run.stopReason,
		requests: calls,
		tools: executed,
		decisions,
		recalledStrategies: candidates,
		elapsedMs: performance.now() - started,
		cpuMs: (used.user + used.system) / 1000,
		snapshotBytes: Buffer.byteLength(JSON.stringify(workspace.snapshot())),
	}
}

try {
	const cases = []
	for (const variant of [
		'baseline',
		'without_association',
		'without_outcome_control',
		'without_completion_gate',
		'full',
	])
		cases.push(await trial(variant))
	assert.equal(cases.find((item) => item.variant === 'full').verified, true)
	assert.deepEqual(cases.find((item) => item.variant === 'full').tools, [
		'cached_write',
		'cached_write',
		'fresh_write',
		'verify_health',
	])
	for (const item of cases.filter((item) => item.variant !== 'full'))
		assert.equal(item.verified, false, item.variant)
	const result = {
		kind: 'scripted-mechanism-ablation',
		liveModelCalls: 0,
		maxRequestsPerVariant: 7,
		taskCount: 1,
		cases,
		limitations: [
			'Hand-authored task and outcomes',
			'Scripted provider; not model capability or benchmark evidence',
			'Same request cap, different actual requests',
			'Host-provided provenance; no authenticated event transport',
		],
	}
	if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(result, null, 2)}\n`)
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
	globalThis.fetch = externalFetch
	await rm(root, { recursive: true, force: true })
}
