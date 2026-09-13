// Reproduce the existing acceptance boundary with a scripted candidate through
// the actual CLI executable. This measures host acceptance, not model accuracy.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'namzu-resident-verification-baseline-'))
const home = join(root, 'home')
const cwd = join(root, 'workspace')
await mkdir(home)
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
await writeFile(
	join(cwd, 'package.json'),
	JSON.stringify({ name: 'verification-fixture', version: '3.0.0' }) + '\n',
)
const preload = join(root, 'candidate.mjs')
await writeFile(
	preload,
	`import { ProviderRegistry, MockLLMProvider } from ${JSON.stringify(new URL('../../packages/sdk/dist/index.js', import.meta.url).href)};
ProviderRegistry.create=()=>({provider:new MockLLMProvider({turns:[{text:JSON.stringify({kind:'complete',summary:'The current package version is 1.0.0. The review is complete.'})}]})});`,
)
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
const report = { root, model: 'scripted provider; no live accuracy claim', commands: [] }
for (const args of [
	[
		'add',
		'--trust',
		'Report the current version from package.json, then complete the review. Only read; do not change files or run commands.',
	],
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
		'3',
		'--token-budget',
		'20000',
	],
]) {
	const result = await exec(
		process.execPath,
		['--import', preload, cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', cwd],
		{ cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 30000, maxBuffer: 1000000 },
	)
	report.commands.push({ args, result: JSON.parse(result.stdout) })
}
report.currentDocument = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
report.accepted = report.commands.at(-1).result.agenda.pursuits[0].state
assert.equal(report.accepted.phase, 'complete')
assert.ok(report.accepted.summary.includes('1.0.0'))
assert.equal(report.currentDocument.version, '3.0.0')
report.reproduced = true
report.sourceHashes = Object.fromEntries(
	await Promise.all(
		[
			'packages/cli/src/integrations/resident/session-step.ts',
			'packages/sdk/src/types/run/answer-review.ts',
		].map(async (path) => [
			path,
			createHash('sha256')
				.update(await readFile(new URL('../../' + path, import.meta.url)))
				.digest('hex'),
		]),
	),
)
await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n')
console.log(
	JSON.stringify({
		root,
		reproduced: true,
		accepted: report.accepted.summary,
		currentVersion: report.currentDocument.version,
	}),
)
