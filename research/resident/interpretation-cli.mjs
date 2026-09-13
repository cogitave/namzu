import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { cases, correction, objective, summaries, versions } from './interpretation-cases.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const executable = promisify(execFile)
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
const builtPaths = [
	'packages/sdk/dist/prompt/resident-step.js',
	'packages/sdk/dist/manager/resident/evidence-recall.js',
	'packages/sdk/dist/run/evidence-recall.js',
	'packages/sdk/dist/run/evidence-query.js',
	'packages/sdk/dist/manager/resident/history.js',
	'packages/sdk/dist/manager/resident/tool-evidence.js',
	'packages/sdk/dist/store/evidence/disk.js',
	'packages/sdk/dist/store/evidence/search-input.js',
	'packages/cli/dist/tui/agent.js',
	'packages/cli/dist/integrations/resident/tool-evidence.js',
	'packages/cli/dist/integrations/resident/session-step.js',
]
const fingerprints = async () =>
	Object.fromEntries(
		await Promise.all(
			builtPaths.map(async (path) => [
				path,
				sha(await readFile(new URL('../../' + path, import.meta.url))),
			]),
		),
	)

// Two settled admissions with genuine tool executions, each with a fresh CLI
// Session. The scripted model only establishes history, never judges the case.
if (process.argv[2] === '--seed') {
	const cwd = process.argv[3]
	const sdk = await import('../../packages/sdk/dist/index.js')
	const { lookupResident } = await import(
		'../../packages/cli/dist/integrations/resident/storage.js'
	)
	const { openSessions } = await import('../../packages/cli/dist/integrations/sessions/store.js')
	const { createResidentSessionStep } = await import(
		'../../packages/cli/dist/integrations/resident/session-step.js'
	)
	const { parseRunFlags } = await import('../../packages/cli/dist/commands/run-flags.js')
	const resident = await lookupResident(cwd, 'default')
	assert.ok(resident)
	const sessions = await openSessions(cwd)
	const pursuit = (await resident.agenda.read()).pursuits[0]
	const execution = resident.agenda.execution(pursuit.id)
	const receipts = []
	for (let version = 0; version < 2; version++) {
		if (version)
			await resident.agenda.wake(pursuit.id, await execution.read(), correction, Date.now())
		await writeFile(join(cwd, 'routing.txt'), versions[version])
		const provider = new sdk.MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: `observe-${version}`, name: 'read', args: { path: 'routing.txt' } }] },
				{ text: JSON.stringify({ kind: 'wait', summary: summaries[version], wakeAfterMs: null }) },
			],
		})
		sdk.ProviderRegistry.create = () => ({ provider })
		const claim = await execution.claim(await execution.read(), Date.now())
		const step = createResidentSessionStep({
			cwd,
			sessions,
			agenda: resident.agenda,
			artifactsRoot: resident.artifactsRoot,
			ctx: {
				config: { sandbox: { enabled: false }, web: { search: 'off' } },
				formatter: { name: 'text', print() {}, info() {}, error() {} },
			},
			flags: parseRunFlags([
				'--provider',
				'codex',
				'--model',
				'gpt-5.6-luna',
				'--effort',
				'low',
				'--max-iterations',
				'4',
				'--token-budget',
				'20000',
			]),
			toolLoading: 'deferred',
			contextProfile: 'resident',
		})
		const decision = await step({ ...pursuit, state: claim }, new AbortController().signal, {
			agendaRevision: (await resident.agenda.read()).revision,
		})
		await execution.settle(claim, decision, Date.now())
		const start = await json(join(resident.artifactsRoot, claim.claimId, 'start.json'))
		const finish = await json(join(resident.artifactsRoot, claim.claimId, 'finish.json'))
		assert.equal(finish.cleanup, 'confirmed')
		const events = (
			await readFile(
				join(sessions.root, 'sessions', start.sessionId, 'runs', start.runId, 'transcript.jsonl'),
				'utf8',
			)
		)
			.trim()
			.split('\n')
			.map(JSON.parse)
		const read = events.find(
			(event) => event.type === 'tool_completed' && event.toolUseId === `observe-${version}`,
		)
		assert.ok(read && !read.isError && read.result.includes(versions[version].split('\n')[0]))
		receipts.push({
			version,
			start,
			finish,
			revision: (await resident.agenda.read()).revision,
			observation: read.result,
		})
	}
	// The third content has never been observed by any model or historical tool.
	await writeFile(join(cwd, 'routing.txt'), versions[2])
	console.log(JSON.stringify(receipts))
} else {
	const live = process.argv.includes('--live')
	const scripted = process.argv.includes('--scripted')
	if (live === scripted)
		throw new Error(
			'Choose exactly one of --live or --scripted. Scripted only checks request delivery, not model judgement.',
		)
	const caseId = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7)
	const heldOut = process.argv.includes('--held-out')
	const selected = caseId
		? cases.filter((item) => item.id === caseId)
		: cases.filter((item) => !!item.heldOut === heldOut)
	if (!selected.length) throw new Error(`Unknown case: ${caseId}`)
	const root = await mkdtemp(join(tmpdir(), 'namzu-resident-interpretation-'))
	const report = {
		root,
		live,
		model: 'gpt-5.6-luna',
		provider: 'codex',
		effort: 'low',
		cases: [],
		datasetHash: sha(JSON.stringify({ objective, correction, summaries, versions, cases })),
		driverHash: sha(await readFile(fileURLToPath(import.meta.url))),
		...(process.env.NAMZU_INTERPRETATION_BASELINE_MANIFEST
			? { baseline: await json(process.env.NAMZU_INTERPRETATION_BASELINE_MANIFEST) }
			: {}),
	}
	console.log(JSON.stringify({ root, cases: selected.map((item) => item.id), live }))
	report.buildBefore = await fingerprints()
	for (const fixture of selected) {
		const caseRoot = join(root, fixture.id)
		const home = join(caseRoot, 'home')
		const cwd = join(caseRoot, 'workspace')
		await mkdir(home, { recursive: true })
		await mkdir(cwd)
		await writeFile(
			join(home, 'preferences.json'),
			JSON.stringify({
				version: 3,
				providers: [{ id: 'codex', model: 'gpt-5.6-luna' }],
				subagents: { active: [] },
			}),
		)
		await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
		const env = { ...process.env, NAMZU_HOME: home }
		const observedPath = join(caseRoot, 'requests.jsonl')
		const preload = join(caseRoot, 'observe.mjs')
		// Log only text needed for evidence/interpretation review. Never serialize
		// provider instances, credentials, transport headers, or reasoning blocks.
		await writeFile(
			preload,
			`
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ProviderRegistry, MockLLMProvider } from ${JSON.stringify(new URL('../../packages/sdk/dist/index.js', import.meta.url).href)};
if (${scripted}) ProviderRegistry.create=()=>({provider:new MockLLMProvider({turns:[{text:'{"kind":"blocked","summary":"Scripted request-delivery control; no interpretation was attempted."}'}]})});
const create=ProviderRegistry.create;
ProviderRegistry.create=function(...args){
 const result=create.apply(this,args); const provider=result.provider; const stream=provider.chatStream;
 provider.chatStream=function(params){
  const strings=value=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(strings):value&&typeof value==='object'?Object.entries(value).filter(([key])=>!['reasoning','providerMetadata','metadata'].includes(key)).flatMap(([,v])=>strings(v)):[];
  const texts=strings(params);
  const evidence=texts.filter(text=>text.includes('Retrieved resident evidence'));
  const continuation=texts.filter(text=>text.includes('## Resident continuation'));
  appendFileSync(${JSON.stringify(observedPath)},JSON.stringify({
    evidence,continuation,
    messages:params.messages.filter(message=>['user','tool'].includes(message.role)).map(message=>({role:message.role,toolCallId:message.toolCallId,content:message.content})),
    toolNames:params.tools?.map(tool=>tool.name??tool.function?.name),
    guidanceHashes:texts.filter(text=>text.includes('## Resident work')).map(text=>createHash('sha256').update(text).digest('hex')),
    contextChars:texts.reduce((sum,text)=>sum+text.length,0),
  })+'\\n');
  return stream.call(this,params);
 };return result;
};
`,
		)
		const row = {
			id: fixture.id,
			commands: [],
			expected: fixture.expected,
			seed: [],
			requests: [],
			runs: [],
			tools: [],
			finishes: [],
		}
		report.cases.push(row)
		const command = async (args, observe = false) => {
			try {
				const { stdout } = await executable(
					process.execPath,
					[
						...(observe ? ['--import', preload] : []),
						cli,
						'--quiet',
						'--format',
						'json',
						'resident',
						...args,
						'--cwd',
						cwd,
					],
					{ cwd, env, timeout: 180000, maxBuffer: 3000000 },
				)
				const result = JSON.parse(stdout)
				row.commands.push({ args, result, exit: 0 })
				return result
			} catch (error) {
				row.commands.push({
					args,
					exit: error.code,
					signal: error.signal,
					stdout: error.stdout?.slice(-16000),
					stderr: error.stderr?.slice(-4000),
				})
				throw error
			}
		}
		try {
			const added = await command(['add', '--trust', objective])
			const id = added.agenda.pursuits[0].id
			const seed = await executable(
				process.execPath,
				[fileURLToPath(import.meta.url), '--seed', cwd],
				{ cwd, env, timeout: 30000, maxBuffer: 1000000 },
			)
			row.seed = JSON.parse(seed.stdout)
			if (fixture.removeCurrent)
				await rename(join(cwd, 'routing.txt'), join(caseRoot, 'removed-routing.txt'))
			for (const wake of fixture.wakes) await command(['wake', id, wake])
			const result = await command(
				[
					'run',
					'--trust',
					'--max-steps',
					'1',
					'--provider',
					'codex',
					'--model',
					'gpt-5.6-luna',
					'--effort',
					'low',
					'--tool-loading',
					'deferred',
					'--max-iterations',
					'8',
					'--token-budget',
					'40000',
				],
				true,
			)
			row.state = result.agenda.pursuits[0].state
		} catch (error) {
			row.error = error instanceof Error ? error.message.slice(0, 2000) : String(error)
		} finally {
			// Usage and failures are recorded even when setup, model, parsing or
			// request assertions fail. Failed claims are not retried or reconciled.
			async function collect(directory) {
				let entries
				try {
					entries = await readdir(directory, { withFileTypes: true })
				} catch (error) {
					if (error.code === 'ENOENT') return
					throw error
				}
				for (const entry of entries) {
					const path = join(directory, entry.name)
					if (entry.isDirectory()) await collect(path)
					else if (entry.name === 'run.json') {
						const run = await json(path)
						row.runs.push({
							id: run.id,
							status: run.status,
							tokenUsage: run.tokenUsage,
							cost: run.cost,
						})
					} else if (entry.name === 'finish.json') row.finishes.push(await json(path))
					else if (entry.name === 'transcript.jsonl') {
						for (const line of (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean)) {
							const event = JSON.parse(line)
							if (['tool_executing', 'tool_completed'].includes(event.type)) row.tools.push(event)
						}
					}
				}
			}
			await collect(join(home, 'sessions'))
			await collect(join(home, 'residents'))
			try {
				row.requests = (await readFile(observedPath, 'utf8'))
					.trim()
					.split('\n')
					.filter(Boolean)
					.map(JSON.parse)
			} catch (error) {
				if (error.code !== 'ENOENT') throw error
			}
			row.providerTokens = row.runs.reduce(
				(sum, run) => sum + (run.tokenUsage?.totalTokens ?? 0),
				0,
			)
			const records =
				row.requests[0]?.evidence.flatMap((block) =>
					block
						.split('\n')
						.filter((line) => line.startsWith('{"sessionId":'))
						.map(JSON.parse),
				) ?? []
			const excerpts = records.map((record) => record.excerpt).join('\n')
			const historicIds = ['CD-1472', 'JP-6381', 'CD-2859', 'JP-7406']
			const historical = new Map(row.seed.map((seed) => [seed.start.sessionId, seed]))
			const contexts = row.requests.flatMap((request) => request.evidence)
			const searchReceipts = contexts.flatMap((block) =>
				block
					.split('\n')
					.filter((line) => line.startsWith('{"querySelection":'))
					.map(JSON.parse),
			)
			row.delivery = {
				originalIds: historicIds.map((id) => ({ id, present: excerpts.includes(id) })),
				currentLeakedBeforeRead:
					JSON.stringify(row.requests[0]).includes('CD-3964') ||
					JSON.stringify(row.requests[0]).includes('JP-8527'),
				historicalSessions: [...new Set(records.map((record) => record.sessionId))],
				revisions: [...new Set(records.map((record) => record.revision))],
				scopedProvenance: records.every((record) => {
					const seed = historical.get(record.sessionId)
					return (
						seed &&
						record.runId === seed.start.runId &&
						record.claimId === seed.start.claimId &&
						record.pursuitId === seed.start.pursuitId &&
						record.revision === seed.revision &&
						record.retained === 'full' &&
						!record.isError &&
						seed.observation.includes(record.excerpt)
					)
				}),
				bounded:
					contexts.length > 0 &&
					contexts.every(
						(block) => block.slice(block.indexOf('Retrieved resident evidence')).length <= 6000,
					) &&
					searchReceipts.length === contexts.length &&
					searchReceipts.every(
						(receipt) =>
							receipt.scannedBytes <= 8 * 1024 * 1024 &&
							receipt.querySelection.terms.length <= 16 &&
							records.every((record) => record.revision <= receipt.querySelection.throughRevision),
					),
			}
			const seededRuns = new Set(row.seed.map((seed) => seed.start.runId))
			row.answerTools = row.tools
				.filter((event) => !seededRuns.has(event.runId) && event.type === 'tool_executing')
				.map((event) => ({ name: event.toolName, input: event.input }))
			const answer = row.state?.summary ?? ''
			row.measurements = {
				requiredIdsPresent: fixture.expected.required?.every((id) => answer.includes(id)),
				forbiddenIdsAbsent: fixture.expected.forbidden?.every((id) => !answer.includes(id)),
				freshReadAttempted: row.answerTools.some((tool) => tool.name === 'read'),
				// Diagnostic lexical flags, not a semantic pass score. A contrast
				// mentioning a non-answer identifier need not be an incorrect answer.
				semanticVerdict: 'unreviewed',
			}
			row.integrity =
				!row.error &&
				row.delivery.originalIds.every((item) => item.present) &&
				!row.delivery.currentLeakedBeforeRead &&
				row.delivery.historicalSessions.length === 2 &&
				row.delivery.scopedProvenance &&
				row.delivery.bounded &&
				row.finishes.length === 3 &&
				new Set(row.finishes.map((finish) => finish.sessionId)).size === 3 &&
				row.answerTools.every((tool) =>
					[
						'read',
						'glob',
						'grep',
						'search_resident_tools',
						'read_resident_tool',
						'search_resident_history',
						'read_resident_history',
					].includes(tool.name),
				) &&
				row.finishes.every(
					(finish) => finish.cleanup === 'confirmed' && finish.stopReason === 'end_turn',
				)
			await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n')
			console.log(
				JSON.stringify({
					id: row.id,
					integrity: row.integrity,
					phase: row.state?.phase,
					summary: row.state?.summary,
					measurements: row.measurements,
					providerTokens: row.providerTokens,
					error: row.error,
				}),
			)
		}
	}
	report.buildAfter = await fingerprints()
	report.stableBuild = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter)
	report.providerTokens = report.cases.reduce((sum, item) => sum + item.providerTokens, 0)
	await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n')
	assert.ok(report.stableBuild, 'Production changed during the experiment.')
	assert.ok(
		report.cases.every((row) => row.integrity),
		'A request/receipt invariant failed; inspect result.json, do not claim model failure.',
	)
	if (scripted) assert.equal(report.providerTokens, 0)
}
