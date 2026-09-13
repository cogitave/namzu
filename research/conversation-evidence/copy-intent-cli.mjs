import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
	appendFile,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url)
const cli = fileURLToPath(
	new URL('../../packages/cli/dist/bin.js', import.meta.url),
)
const mode = process.env.NAMZU_COPY_INTENT_MODE
const exec = promisify(execFile)

if (mode === 'seed' || mode === 'observe') {
	const { ProviderRegistry, MockLLMProvider } = await import(sdkURL)
	const create = ProviderRegistry.create.bind(ProviderRegistry)
	ProviderRegistry.create = (...args) => {
		const created =
			mode === 'seed' || process.env.NAMZU_COPY_INTENT_LIVE !== '1'
				? {
						provider: new MockLLMProvider({
							turns:
								mode === 'seed'
									? [
											{
												toolCalls: [
													{ name: 'read', args: { path: 'manifest.txt' } },
												],
											},
											{
												text: 'DELTA siparişinin takip kodunu kayıtta gördüm.',
											},
										]
									: [{ text: process.env.NAMZU_COPY_INTENT_EXPECTED }],
						}),
					}
				: create(...args)
		if (mode === 'seed') return created
		const stream = created.provider.chatStream.bind(created.provider)
		created.provider.chatStream = async function* (params) {
			const context = params.messages.filter(
				(m) =>
					m.source?.type === 'runtime-context' &&
					m.source.kind === 'step-context',
			)
			const ordinary = params.messages.filter((m) => !context.includes(m))
			// The observation is diagnostic only. It does not alter provider input or output.
			const record = {
				model: params.model,
				effort: params.effort,
				context: context.map((m) => m.content),
				ordinaryHasIdentifier: ordinary.some(
					(m) =>
						typeof m.content === 'string' &&
						/TAKIP-[0-9a-f-]{36}/.test(m.content),
				),
			}
			for await (const chunk of stream(params)) {
				if (chunk.usage) record.usage = chunk.usage
				yield chunk
			}
			await appendFile(
				process.env.NAMZU_COPY_INTENT_OBSERVATIONS,
				JSON.stringify(record) + '\n',
			)
		}
		return created
	}
} else {
	const live = process.argv.includes('--live')
	const clarifyTransform = process.argv.includes('--clarify-transform')
	const sourceAt = process.argv.indexOf('--identifier-from')
	const priorIdentifier =
		sourceAt < 0
			? undefined
			: JSON.parse(await readFile(process.argv[sourceAt + 1], 'utf8'))
					.identifier
	const root = await mkdtemp(join(tmpdir(), 'namzu-copy-intent-cli-'))
	const home = join(root, 'seed-home')
	const cwd = join(root, 'workspace')
	await mkdir(home)
	await mkdir(cwd)
	const identifier = priorIdentifier ?? `TAKIP-${randomUUID()}`
	assert.match(
		identifier,
		/^TAKIP-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	)
	const source = Array.from({ length: 350 }, (_, i) =>
		i === 210
			? `DELTA siparişinin takip kodu: ${identifier}`
			: `row ${i}: ${'ordinary content; '.repeat(30)}`,
	).join('\n')
	await writeFile(join(cwd, 'manifest.txt'), source)
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
		'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: true\n  resolveEvidenceQueries: false\n',
	)
	let cases = [
		{
			id: 'copy-tr',
			prompt:
				'Önceki DELTA kaydındaki takip kodunu aynen yaz; başka bir şey ekleme.',
			expected: identifier,
		},
		{
			id: 'lowercase',
			prompt:
				'Önceki DELTA kaydındaki takip kodunu tamamen küçük harfe çevirip yaz; başka bir şey ekleme.',
			expected: identifier.toLowerCase(),
		},
		{
			id: 'explicit-unicode',
			prompt:
				'Önceki DELTA kaydındaki takip kodunun yalnızca TAKIP önekini TAKİP olarak değiştir. Geri kalanını aynen koru; yalnızca sonucu yaz.',
			expected: identifier.replace('TAKIP', 'TAKİP'),
		},
		{
			id: 'prefix',
			prompt:
				'Önceki DELTA kaydındaki takip kodunun başına test: ekle; yalnızca sonucu yaz.',
			expected: `test:${identifier}`,
		},
		{
			id: 'copy-en',
			prompt:
				'Return only the tracking identifier recorded for DELTA earlier. Copy it verbatim.',
			expected: identifier,
		},
		{
			id: 'new-example',
			prompt:
				'Önceki DELTA kodunu verme. Yeni bir örnek olarak yalnızca TEST-42 yaz.',
			expected: 'TEST-42',
		},
	]
	if (clarifyTransform)
		cases = [
			{
				id: 'explicit-unicode',
				prompt:
					'Önceki DELTA kaydındaki takip kodunu bu yanıtta TAKİP önekiyle yaz; sonrasını aynen koru. Yalnızca metin dönüştürme istiyorum; dosya okuma veya değiştirme. Başka bir şey ekleme.',
				expected: identifier.replace('TAKIP', 'TAKİP'),
			},
		]
	const files = [
		'packages/sdk/dist/runtime/query/iteration/index.js',
		'packages/sdk/dist/runtime/query/iteration/stream-turn.js',
		'packages/sdk/dist/run/evidence-recall.js',
		'packages/sdk/dist/run/evidence-query.js',
		'packages/cli/dist/tui/agent.js',
		'packages/cli/dist/integrations/sessions/conversation-search.js',
	]
	const hashes = () =>
		Promise.all(
			files.map(async (path) => [
				path,
				createHash('sha256')
					.update(await readFile(new URL('../../' + path, import.meta.url)))
					.digest('hex'),
			]),
		)
	const report = {
		root,
		live,
		clarifyTransform,
		identifier,
		before: await hashes(),
		cases: [],
	}
	const args = [
		'--import',
		fileURLToPath(import.meta.url),
		cli,
		'--quiet',
		'run-stream',
		'--session',
		'copy-intent',
		'--trust',
		'--cwd',
		cwd,
		'--provider',
		'codex',
		'--model',
		'gpt-5.6-luna',
		'--effort',
		'low',
		'--permission-mode',
		'strict',
		'--max-iterations',
		'3',
		'--token-budget',
		'12000',
	]
	try {
		const seed = await exec(
			process.execPath,
			[
				...args,
				'Read manifest.txt and summarize the kind of information in one sentence.',
			],
			{
				cwd,
				env: {
					...process.env,
					NAMZU_HOME: home,
					NAMZU_COPY_INTENT_MODE: 'seed',
				},
				timeout: 30000,
				maxBuffer: 1000000,
			},
		)
		const seedEvents = seed.stdout
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
		assert.equal(
			seedEvents.findLast((e) => e.kind === 'done')?.stopReason,
			'end_turn',
		)
		assert.ok(
			seedEvents.some(
				(e) => e.kind === 'tool-end' && e.toolName === 'read' && !e.isError,
			),
		)
		assert.ok(
			!seed.stdout.includes(identifier),
			'Seed must not expose the identifier in its visible preview or summary',
		)
		const replacement =
			'The original record is no longer in this workspace file.\n'
		await writeFile(join(cwd, 'manifest.txt'), replacement)
		for (const scenario of cases) {
			// Branch only synthetic Namzu state. Every process gets the same seed
			// conversation; one scenario cannot recall an earlier scenario's answer.
			const caseHome = join(root, scenario.id)
			await cp(home, caseHome, { recursive: true })
			const observations = join(root, `${scenario.id}.jsonl`)
			const result = { ...scenario }
			try {
				const execution = await exec(
					process.execPath,
					[...args, scenario.prompt],
					{
						cwd,
						env: {
							...process.env,
							NAMZU_HOME: caseHome,
							NAMZU_COPY_INTENT_MODE: 'observe',
							NAMZU_COPY_INTENT_LIVE: live ? '1' : '0',
							NAMZU_COPY_INTENT_OBSERVATIONS: observations,
							// Only the scripted control receives an expected-answer channel.
							NAMZU_COPY_INTENT_EXPECTED: live ? '' : scenario.expected,
						},
						timeout: 90000,
						maxBuffer: 1000000,
					},
				)
				const events = execution.stdout
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
				const done = events.findLast((e) => e.kind === 'done')
				result.answer = done?.text
				result.stopReason = done?.stopReason
				result.budget = events.findLast((e) => e.budget)?.budget
				result.totalTokens = result.budget?.treeTokens
				result.usageComplete =
					typeof result.totalTokens === 'number' &&
					result.budget.unresolvedRequests === 0
				result.errors = events.filter((e) => e.kind === 'error')
				result.tools = events
					.filter((e) => e.kind === 'tool-start')
					.map((e) => e.toolName)
				result.requests = (await readFile(observations, 'utf8'))
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
				result.contextHasSource = result.requests.some((r) =>
					r.context.some((text) => text.includes(identifier)),
				)
				result.taskPass =
					done?.stopReason === 'end_turn' && done.text === scenario.expected
				result.exactSourceValue = done?.text === identifier
				result.falseRejectionByUnconditionalCopyRule =
					result.taskPass && !result.exactSourceValue
			} catch (error) {
				result.taskPass = false
				result.error = String(error.message)
			}
			report.cases.push(result)
			console.log(
				JSON.stringify({
					id: result.id,
					taskPass: result.taskPass,
					contextHasSource: result.contextHasSource,
					totalTokens: result.totalTokens,
					error: result.error,
				}),
			)
			assert.equal(
				await readFile(join(cwd, 'manifest.txt'), 'utf8'),
				replacement,
			)
		}
		report.sourceUnchanged = true
	} catch (error) {
		report.error = String(error.message)
	}
	report.after = await hashes()
	report.buildStable =
		JSON.stringify(report.before) === JSON.stringify(report.after)
	report.taskPasses = report.cases.filter((c) => c.taskPass).length
	report.falseRejectionsByUnconditionalCopyRule = report.cases.filter(
		(c) => c.falseRejectionByUnconditionalCopyRule,
	).length
	report.totalTokens = report.cases.every((c) => c.usageComplete)
		? report.cases.reduce((sum, c) => sum + c.totalTokens, 0)
		: null
	report.completed =
		!report.error &&
		report.cases.length === cases.length &&
		report.buildStable &&
		report.sourceUnchanged
	await writeFile(
		join(root, 'result.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
	console.log(
		JSON.stringify({
			root,
			live,
			completed: report.completed,
			taskPasses: report.taskPasses,
			falseRejectionsByUnconditionalCopyRule:
				report.falseRejectionsByUnconditionalCopyRule,
			totalTokens: report.totalTokens,
		}),
	)
	if (!report.completed || report.taskPasses !== cases.length)
		process.exitCode = 1
}
