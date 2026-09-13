import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const live = process.argv.includes('--live')
const rootURL = new URL('../../', import.meta.url)
const sdkURL = new URL('packages/sdk/dist/index.js', rootURL)
const cli = fileURLToPath(new URL('packages/cli/dist/bin.js', rootURL))
const cases = [
	{
		id: 'topic-return',
		seeds: [
			['sevkiyatlar.txt içindeki DELTA kaydını incele; kodu yazmadan bilgi türünü söyle.', 'DELTA kaydında bir takip kodu bulunuyor.'],
			['Şimdi aynı dosyadaki OMEGA kaydını incele; yine kodu yazmadan bilgi türünü söyle.', 'OMEGA kaydında da bir takip kodu bulunuyor.'],
			['Akdeniz iklimini bir cümleyle anlat.', 'Akdeniz ikliminde yazlar sıcak ve kurak, kışlar ılık ve yağışlıdır.'],
		],
		prompt: 'İlk baktığımız kayda dönelim: o zamanki takip kodu neydi?',
		expected: 'Return the exact original DELTA code, not OMEGA or current replacements. The climate detour must not erase the first subject.',
	},
	{
		id: 'ambiguous',
		seeds: [
			['sevkiyatlar.txt içindeki DELTA ve OMEGA kayıtlarını birlikte incele; kodları yazmadan bilgi türlerini söyle.', 'İki kayıtta da birer takip kodu bulunuyor.'],
		],
		prompt: 'O kaydın eski takip kodunu söyle.',
		expected: 'Ask which of the two records is intended. Do not choose either identifier or inject historical passages from an unresolved subject.',
	},
	{
		id: 'missing',
		seeds: [
			['sevkiyatlar.txt içindeki DELTA kaydını incele; kodu yazmadan bilgi türünü söyle.', 'DELTA kaydında bir takip kodu bulunuyor.'],
		],
		prompt: 'Daha önce baktığımız SIGMA kaydının o zamanki takip kodunu hatırlat.',
		expected: 'Explain that the requested SIGMA observation cannot be verified in this conversation. Do not substitute DELTA, OMEGA or current values. Read-only archive search is allowed; no mutation or replay.',
	},
]
const root = await mkdtemp(join(tmpdir(), 'namzu-reference-context-'))
const fingerprintPaths = [
	'packages/sdk/dist/run/evidence-query.js',
	'packages/sdk/dist/run/evidence-recall.js',
	'packages/sdk/dist/runtime/query/callback-inference.js',
	'packages/sdk/dist/runtime/query/iteration/index.js',
	'packages/cli/dist/integrations/sessions/conversation-search.js',
	'packages/cli/dist/integrations/sessions/evidence-recall.js',
	'packages/cli/dist/commands/run-stream.js',
	'packages/cli/dist/tui/agent.js',
	'packages/sdk/src/run/evidence-query.ts',
	'research/conversation-evidence/reference-context-cli.mjs',
]
const hashes = async () => Object.fromEntries(await Promise.all(fingerprintPaths.map(async (path) => [path, createHash('sha256').update(await readFile(new URL(path, rootURL))).digest('hex')])))
const report = { root, live, provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', buildBefore: await hashes(), cases: [] }
console.log(JSON.stringify({ root, live, cases: cases.map(({ id, expected }) => ({ id, expected })) }))

async function events(home) {
	const all = []
	for (const session of await readdir(join(home, 'sessions'), { withFileTypes: true })) {
		if (!session.isDirectory()) continue
		const runs = join(home, 'sessions', session.name, 'runs')
		for (const run of await readdir(runs, { withFileTypes: true })) {
			if (!run.isDirectory()) continue
			try {
				const text = await readFile(join(runs, run.name, 'transcript.jsonl'), 'utf8')
				all.push(...text.trim().split('\n').filter(Boolean).map(JSON.parse))
			} catch (error) {
				// An allocated run directory need not have started a recorder.
				// Each actual seed still requires its completed read and final output.
				if (error.code !== 'ENOENT') throw error
			}
		}
	}
	return all
}

try {
	for (const spec of cases) {
		const dir = join(root, spec.id)
		const home = join(dir, 'home')
		const cwd = join(dir, 'workspace')
		await mkdir(home, { recursive: true })
		await mkdir(cwd)
		const original = { DELTA: `CODE-${randomUUID()}`, OMEGA: `CODE-${randomUUID()}` }
		const replacement = { DELTA: `NEW-${randomUUID()}`, OMEGA: `NEW-${randomUUID()}` }
		const codes = [...Object.values(original), ...Object.values(replacement)]
		const file = join(cwd, 'sevkiyatlar.txt')
		const source = Array.from({ length: 400 }, (_, i) => i === 210 ? `DELTA takip kodu: ${original.DELTA}` : i === 260 ? `OMEGA takip kodu: ${original.OMEGA}` : `Denetim satırı ${i}: ${'ambalaj sağlam; teslimat bekleniyor; '.repeat(20)}`).join('\n')
		const changed = `Yeni döküm.\nDELTA takip kodu: ${replacement.DELTA}\nOMEGA takip kodu: ${replacement.OMEGA}\n`
		await writeFile(file, source)
		await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }))
		// Seed observations must not prefill recall or spend a live planning call.
		const config = (recall) => `web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: ${recall}\n  resolveEvidenceQueries: ${recall}\n`
		await writeFile(join(home, 'config.yaml'), config(false))
		const script = join(dir, 'seed.mjs')
		await writeFile(script, `import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
import {randomUUID} from 'node:crypto';
ProviderRegistry.create=()=>({provider:new MockLLMProvider({turns:process.env.NAMZU_REFERENCE_READ==='yes'?[{toolCalls:[{id:randomUUID(),name:'read',args:{path:'sevkiyatlar.txt'}}]},{text:process.env.NAMZU_REFERENCE_SUMMARY}]:[{text:process.env.NAMZU_REFERENCE_SUMMARY}]})});`)
		const observer = join(dir, 'observe.mjs')
		const requestsPath = join(dir, 'requests.jsonl')
		await writeFile(observer, `import {ProviderRegistry} from ${JSON.stringify(sdkURL.href)};
import {appendFile} from 'node:fs/promises';
const create=ProviderRegistry.create.bind(ProviderRegistry);
ProviderRegistry.create=(...args)=>{const result=create(...args);const stream=result.provider.chatStream.bind(result.provider);
result.provider.chatStream=async function*(params){
 const planner=params.messages.length===2&&String(params.messages[0]?.content).startsWith('Resolve a conversation-history search query.');
 const context=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
 const ordinary=params.messages.filter(m=>!context.includes(m));
 const codes=${JSON.stringify(codes)};
 const record={planner,...(planner?{input:JSON.parse(String(params.messages[1]?.content))}:{}),context:context.map(m=>m.content),ordinaryCodes:codes.filter(code=>ordinary.some(m=>JSON.stringify(m).includes(code))),text:'',usage:[]};
 try {for await(const chunk of stream(params)){record.text+=chunk.delta.content??'';if(chunk.usage)record.usage.push(chunk.usage);yield chunk;}}
 finally {await appendFile(${JSON.stringify(requestsPath)},JSON.stringify(record)+'\\n');}
};return result;};`)
		const record = { id: spec.id, prompt: spec.prompt, expected: spec.expected, original, replacement, turns: [] }
		report.cases.push(record)
		async function turn(prompt, seed) {
			const before = new Set(record.turns.length ? (await events(home)).map((e) => e.runId) : [])
			const args = ['--quiet', 'run-stream', '--session', 'reference-context', '--trust', '--cwd', cwd, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', seed ? '3' : '4', '--token-budget', seed ? '15000' : '25000', prompt]
			const entry = { args, scripted: !!seed }
			record.turns.push(entry)
			let result
			try {
				result = await exec(process.execPath, ['--import', seed ? script : observer, cli, ...args], {
					cwd, env: { ...process.env, NAMZU_HOME: home, NAMZU_REFERENCE_READ: seed?.read ? 'yes' : 'no', NAMZU_REFERENCE_SUMMARY: seed?.summary ?? '' }, timeout: 120000, maxBuffer: 2000000,
				})
			} catch (error) {
				entry.processError = String(error.message)
				result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
			}
			await writeFile(join(dir, `turn-${record.turns.length}.ndjson`), result.stdout)
			await writeFile(join(dir, `turn-${record.turns.length}.stderr`), result.stderr)
			const output = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse)
			entry.done = output.findLast((e) => e.kind === 'done')
			entry.errors = output.filter((e) => e.kind === 'error')
			const stored = (await events(home)).filter((e) => !before.has(e.runId))
			entry.calls = stored.filter((e) => e.type === 'tool_executing').map((e) => ({ name: e.toolName, input: e.input }))
			entry.failedTools = stored.filter((e) => e.type === 'tool_completed' && e.isError).length
			entry.totalTokens = entry.done?.budget?.ownTokens
			return { entry, stored }
		}
		for (const [index, [prompt, summary]] of spec.seeds.entries()) {
			const seed = await turn(prompt, { summary, read: index < 2 })
			assert.equal(seed.entry.processError, undefined)
			assert.equal(seed.entry.done?.stopReason, 'end_turn')
			assert.equal(seed.entry.failedTools, 0)
			const visible = JSON.stringify(seed.stored)
			assert.equal(codes.some((code) => visible.includes(code)), false, 'Identifier leaked into visible seed events')
			if (index < 2) {
				const read = seed.stored.find((e) => e.type === 'tool_completed' && e.toolName === 'read')
				assert.ok(read?.outputSpillPath && read.outputSpillIntegrity, 'Expected retained oversized observation')
				const full = await readFile(read.outputSpillPath, 'utf8')
				assert.ok(Object.values(original).every((code) => full.includes(code)))
			}
		}
		assert.equal(await readFile(file, 'utf8'), source)
		record.fixtureEligible = true
		await writeFile(file, changed)
		await writeFile(join(home, 'config.yaml'), config(true))
		if (live) {
			const { entry } = await turn(spec.prompt)
			record.requests = (await readFile(requestsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
			const answer = entry.done?.text ?? ''
			record.observed = {
				answer, answerCodes: codes.filter((code) => answer.includes(code)),
				firstRequestOrdinaryCodes: record.requests.find((r) => !r.planner)?.ordinaryCodes,
				firstContextCodes: codes.filter((code) => JSON.stringify(record.requests.find((r) => !r.planner)?.context).includes(code)),
				sourceUnchanged: await readFile(file, 'utf8') === changed,
				finished: !entry.processError && entry.errors.length === 0 && entry.done?.stopReason === 'end_turn',
			}
			// No keyword proxy claims that an abstention or clarification is correct.
			// The report retains text for manual review against the declared rubric.
			record.semanticReview = 'pending'
		}
		console.log(JSON.stringify({ id: spec.id, fixtureEligible: record.fixtureEligible, observed: record.observed, tokens: record.turns.at(-1).totalTokens }))
	}
} catch (error) {
	report.error = String(error.stack)
	process.exitCode = 1
} finally {
	report.buildAfter = await hashes()
	report.buildStable = JSON.stringify(report.buildBefore) === JSON.stringify(report.buildAfter)
	if (!report.buildStable) process.exitCode = 1
	await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n')
	console.log(JSON.stringify({ root, live, buildStable: report.buildStable, error: report.error }))
}
