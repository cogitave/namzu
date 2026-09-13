// Actual CLI admissions. Default: scripted regression; --live: Luna/low only.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const live = process.argv.includes('--live')
const selected = process.argv.includes('--case')
	? process.argv[process.argv.indexOf('--case') + 1]
	: null
const root = await mkdtemp(join(tmpdir(), `namzu-claim-${live ? 'live' : 'scripted'}-`))
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
const sdk = new URL('../../packages/sdk/dist/index.js', import.meta.url).href
const modules = [
	'sdk/dist/run/json-claim-verifier.js',
	'sdk/dist/prompt/resident-step.js',
	'cli/dist/integrations/resident/session-step.js',
	'cli/dist/integrations/resident/verification.js',
	'cli/dist/commands/resident.js',
	'cli/dist/integrations/resident/runner-launch.js',
	'cli/dist/integrations/resident/runner-worker.js',
]
const hashes = async () =>
	Object.fromEntries(
		await Promise.all(
			modules.map(async (path) => [
				path,
				createHash('sha256')
					.update(await readFile(new URL(`../../packages/${path}`, import.meta.url)))
					.digest('hex'),
			]),
		),
	)
const report = {
	root,
	live,
	model: live ? 'codex/gpt-5.6-luna' : 'scripted',
	effort: 'low',
	buildBefore: await hashes(),
	cases: [],
}
const persist = () => writeFile(join(root, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ root, live }))
await persist()
const complete = (value) => ({
	kind: 'complete',
	summary: `The observed package version is ${value}.`,
	claims: { version: value },
})
const blocked = {
	kind: 'blocked',
	summary: 'The source is unavailable; current version and completion cannot be established.',
}

try {
	for (const id of (live
		? ['current', 'repair', 'missing']
		: ['repair', 'changed', 'missing', 'exhausted']
	).filter((id) => !selected || selected === id)) {
		const home = join(root, id, 'home')
		const cwd = join(root, id, 'workspace')
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
		if (id !== 'missing')
			await writeFile(join(cwd, 'package.json'), '{"name":"claim-fixture","version":"3.0.0"}\n')
		await writeFile(
			join(cwd, 'checks.json'),
			JSON.stringify({
				version: 1,
				claims: [{ id: 'version', source: 'package.json', pointer: '/version' }],
			}),
		)
		const requestsPath = join(root, id, 'requests.jsonl')
		const preload = join(root, id, 'provider.mjs')
		const turns =
			id === 'changed'
				? [complete('3.0.0'), complete('4.0.0')]
				: id === 'missing'
					? [complete('1.0.0'), blocked]
					: id === 'exhausted'
						? Array(6).fill(complete('1.0.0'))
						: [complete('1.0.0'), complete('3.0.0')]
		await writeFile(
			preload,
			`
import { appendFileSync, writeFileSync } from 'node:fs';
import { ProviderRegistry, MockLLMProvider } from ${JSON.stringify(sdk)};
const create = ProviderRegistry.create;
ProviderRegistry.create = function(...args) {
 const result = ${live} ? create.apply(this, args) : {provider: new MockLLMProvider({turns:${JSON.stringify(turns.map((value) => ({ text: JSON.stringify(value) })))}})};
 const provider = result.provider; const stream = provider.chatStream; let count = 0;
 provider.chatStream = async function* (params) {
  count++;
  const text = (v) => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(text) : v && typeof v === 'object' ? Object.entries(v).filter(([k]) => !['reasoning','metadata','providerMetadata'].includes(k)).flatMap(([,value]) => text(value)) : [];
  appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify({count, feedback: text(params.messages).filter(t => t.includes('Claim verification failed:')), toolNames: params.tools?.map(t=>t.name??t.function?.name)})+'\\n');
  if (${live && id === 'repair'} && count === 1) {
   const synthetic = new MockLLMProvider({turns:[{text:${JSON.stringify(JSON.stringify(complete('1.0.0')))}}]});
   yield* synthetic.chatStream(params); return;
  }
  yield* stream.call(this, params);
  if (${!live && id === 'changed'} && count === 1) writeFileSync(${JSON.stringify(join(cwd, 'package.json'))}, '{"name":"claim-fixture","version":"4.0.0"}\\n');
 }; return result;
};
`,
		)
		const row = { id, commands: [], runs: [], finishes: [], requests: [], tools: [] }
		report.cases.push(row)
		const command = async (args) => {
			try {
				const result = await exec(
					process.execPath,
					[
						'--import',
						preload,
						cli,
						'--quiet',
						'--format',
						'json',
						'resident',
						...args,
						'--cwd',
						cwd,
					],
					{
						cwd,
						env: { ...process.env, NAMZU_HOME: home },
						timeout: 120_000,
						maxBuffer: 2_000_000,
					},
				)
				const parsed = JSON.parse(result.stdout)
				row.commands.push({ args, exit: 0, result: parsed })
				return parsed
			} catch (error) {
				row.commands.push({
					args,
					exit: error.code ?? null,
					signal: error.signal ?? null,
					stdout: error.stdout ?? '',
					stderr: error.stderr ?? '',
					error: error.message,
				})
				return null
			} finally {
				await persist()
			}
		}
		await command([
			'add',
			'--trust',
			'Report the current version from package.json, then complete the review. Only read; do not change files or run commands. If the source is missing, report blocked.',
		])
		await command([
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
			'24000',
			'--verify',
			'checks.json',
		])
		row.status = await command(['status'])
		const collect = async (dir) => {
			let entries
			try {
				entries = await readdir(dir, { withFileTypes: true })
			} catch (error) {
				if (error.code === 'ENOENT') return
				throw error
			}
			for (const entry of entries) {
				const path = join(dir, entry.name)
				if (entry.isDirectory()) await collect(path)
				else if (entry.name === 'run.json') {
					const run = JSON.parse(await readFile(path, 'utf8'))
					row.runs.push({
						id: run.id,
						status: run.status,
						tokenUsage: run.tokenUsage,
						cost: run.cost,
					})
				} else if (entry.name === 'finish.json')
					row.finishes.push(JSON.parse(await readFile(path, 'utf8')))
				else if (entry.name === 'transcript.jsonl')
					for (const line of (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean)) {
						const event = JSON.parse(line)
						if (['tool_executing', 'tool_completed'].includes(event.type)) row.tools.push(event)
					}
			}
		}
		await collect(join(home, 'sessions'))
		await collect(join(home, 'residents'))
		row.requests = (await readFile(requestsPath, 'utf8'))
			.trim()
			.split('\n')
			.filter(Boolean)
			.map(JSON.parse)
		row.providerTokens = row.runs.reduce((sum, run) => sum + (run.tokenUsage?.totalTokens ?? 0), 0)
		row.phase = row.status?.agenda.pursuits[0].state.phase
		await persist()
		assert.equal(row.finishes.length, 1)
		const finish = row.finishes[0]
		if (id === 'exhausted') {
			assert.equal(row.phase, 'running')
			assert.equal(finish.stopReason, 'answer_rejected')
			assert.equal(finish.decision, null)
		} else if (id === 'missing') {
			assert.equal(row.phase, 'blocked')
			assert.equal(finish.verification, null)
		} else {
			assert.equal(row.phase, 'complete')
			const evidence = finish.verification.receipt
			assert.equal(evidence.runId, finish.runId)
			assert.equal(evidence.claims.version, id === 'changed' ? '4.0.0' : '3.0.0')
			assert.equal(
				evidence.observations[0].sha256,
				createHash('sha256')
					.update(await readFile(join(cwd, 'package.json')))
					.digest('hex'),
			)
		}
		if (['repair', 'changed', 'exhausted'].includes(id))
			assert.ok(row.requests.some((request) => request.feedback.length))
		console.log(
			JSON.stringify({
				id,
				phase: row.phase,
				requests: row.requests.length,
				tokens: row.providerTokens,
			}),
		)
	}
} catch (error) {
	report.failure = error.stack
	process.exitCode = 1
} finally {
	report.buildAfter = await hashes()
	report.buildStable = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter)
	report.providerTokens = report.cases.reduce((sum, row) => sum + (row.providerTokens ?? 0), 0)
	await persist()
	console.log(
		JSON.stringify({
			root,
			buildStable: report.buildStable,
			tokens: report.providerTokens,
			failure: report.failure ?? null,
		}),
	)
}
