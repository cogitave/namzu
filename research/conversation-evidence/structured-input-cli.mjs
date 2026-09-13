import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A real built CLI Session and kernel; model decisions alone are scripted.
const root = await mkdtemp(join(tmpdir(), 'namzu-structured-input-cli-'))
const home = join(root, 'home')
const cwd = join(root, 'workspace')
await mkdir(home)
await mkdir(cwd)
process.env.NAMZU_HOME = home
const base = new URL('../../', import.meta.url)
const sdk = await import(new URL('packages/sdk/dist/index.js', base))
await writeFile(
	join(home, 'preferences.json'),
	JSON.stringify({
		version: 3,
		providers: [{ id: 'codex', model: 'gpt-5.6-luna' }],
		subagents: { active: [] },
	}),
)
await writeFile(
	join(home, 'config.yaml'),
	'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n',
)
const { createAgentSession, probeAgentSession } = await import(
	new URL('packages/cli/dist/tui/agent.js', base)
)
const files = [
	'packages/sdk/dist/runtime/query/iteration/index.js',
	'packages/cli/dist/tui/agent.js',
]
const hashes = () =>
	Promise.all(
		files.map(async (path) => [
			path,
			createHash('sha256')
				.update(await readFile(new URL(path, base)))
				.digest('hex'),
		]),
	)
const report = { root, before: await hashes(), cases: [] }
const probe = await probeAgentSession()
for (const mode of ['prose', 'tool', 'native']) {
	for (const withReview of [false, true]) {
		const record = {
			mode,
			withReview,
			requests: [],
			reviewedInputs: [],
			events: [],
		}
		const pending = []
		let requestIndex = 0
		sdk.ProviderRegistry.create = () => ({
			provider: new sdk.MockLLMProvider({
				capabilities: {
					supportsNativeStructuredOutput: true,
					supportsTools: true,
					supportsFunctionCalling: true,
					supportsStreaming: true,
					supportsVision: true,
				},
				nextTurn: (params) => {
					const index = requestIndex++
					record.requests.push({
						model: params.model,
						effort: params.effort,
						hasNewInput: JSON.stringify(params.messages).includes(
							'Use B42 now.',
						),
					})
					if (index === 0) pending.push(sdk.createUserMessage('Use B42 now.'))
					assert.ok(
						index < 2,
						'The probe allows exactly two candidate requests',
					)
					const code = index === 0 ? 'A17' : 'B42'
					return mode === 'tool'
						? { toolCalls: [{ name: 'structured_output', args: { code } }] }
						: { text: mode === 'native' ? JSON.stringify({ code }) : code }
				},
			}),
		})
		const review = (_value, context) => {
			record.reviewedInputs.push(context.latestUserMessage?.content)
			return { accept: true }
		}
		const session = await createAgentSession(
			probe.preferences,
			probe.detected,
			{
				cwd,
				sandbox: { enabled: false },
				web: { search: 'off' },
				memory: { recall: false },
				limits: { tokenBudget: 1500, maxIterations: 3 },
				...(mode === 'prose'
					? withReview
						? { reviewAnswer: review }
						: {}
					: {
							structuredOutput: {
								schema: sdk.mcpJsonSchemaToZod({
									type: 'object',
									properties: { code: { type: 'string' } },
									required: ['code'],
									additionalProperties: false,
								}),
								mode,
								...(withReview ? { review } : {}),
							},
						}),
			},
		)
		assert.equal(session.hasProvider, true, session.errorHint)
		const controller = new AbortController()
		const timer = setTimeout(
			() => controller.abort(new Error('Probe deadline')),
			10000,
		)
		try {
			for await (const event of session.send(
				[sdk.createUserMessage('Use A17.')],
				{
					permissionMode: 'strict',
					effort: 'low',
					signal: controller.signal,
					inboundMessages: () => pending.splice(0),
				},
			))
				if (['done', 'error'].includes(event.kind) || event.budget)
					record.events.push(event)
			const done = record.events.findLast((e) => e.kind === 'done')
			const budget = record.events.findLast((e) => e.budget)?.budget
			record.passed =
				record.requests.length === 2 &&
				record.requests[1].hasNewInput &&
				done?.stopReason === 'end_turn' &&
				done.text.includes('B42') &&
				(!withReview ||
					JSON.stringify(record.reviewedInputs) ===
						JSON.stringify(['Use A17.', 'Use B42 now.'])) &&
				budget?.treeTokens === 0 &&
				budget.unresolvedRequests === 0
		} catch (error) {
			record.error = String(error.message)
			record.passed = false
		} finally {
			clearTimeout(timer)
			await session.close()
		}
		report.cases.push(record)
		console.log(
			JSON.stringify({
				mode,
				withReview,
				passed: record.passed,
				reviewedInputs: record.reviewedInputs,
				error: record.error,
			}),
		)
	}
}
report.after = await hashes()
report.buildStable =
	JSON.stringify(report.before) === JSON.stringify(report.after)
report.passed = report.buildStable && report.cases.every((c) => c.passed)
await writeFile(
	join(root, 'result.json'),
	JSON.stringify(report, null, 2) + '\n',
)
console.log(JSON.stringify({ root, passed: report.passed }))
if (!report.passed) process.exitCode = 1
