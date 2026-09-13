// Replay the unchanged study with the committed SDK resident guidance. Node's
// process-local module hook substitutes one transpiled source, never dist files.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const revision = '2bcf017f'
const repository = fileURLToPath(new URL('../../', import.meta.url))
const original = execFileSync(
	'git',
	['show', `${revision}:packages/sdk/src/prompt/resident-step.ts`],
	{ cwd: repository, encoding: 'utf8' },
)
const baselineRoot = await mkdtemp(join(tmpdir(), 'namzu-interpretation-baseline-'))
const target = new URL('../../packages/sdk/dist/prompt/resident-step.js', import.meta.url).href
const { outputText } = ts.transpileModule(original, {
	compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
})
const code = outputText.replace(
	/from ['"](\.[^'"]+)['"]/g,
	(_match, path) => `from ${JSON.stringify(new URL(path, target).href)}`,
)
const baseline = pathToFileURL(join(baselineRoot, 'resident-step.mjs')).href
await writeFile(new URL(baseline), code)
const manifest = join(baselineRoot, 'manifest.json')
await writeFile(
	manifest,
	JSON.stringify(
		{
			revision,
			source: 'packages/sdk/src/prompt/resident-step.ts',
			sourceHash: createHash('sha256').update(original).digest('hex'),
			moduleHash: createHash('sha256').update(code).digest('hex'),
			baseline,
		},
		null,
		2,
	),
)
const hook = pathToFileURL(join(baselineRoot, 'hook.mjs')).href
await writeFile(
	new URL(hook),
	`export async function resolve(specifier,context,next){const resolved=await next(specifier,context);return resolved.url===${JSON.stringify(target)}?{url:${JSON.stringify(baseline)},shortCircuit:true}:resolved;}`,
)
const register = pathToFileURL(join(baselineRoot, 'register.mjs')).href
await writeFile(
	new URL(register),
	`import { register } from 'node:module'; register(${JSON.stringify(hook)},import.meta.url);`,
)
// The generated URL has no shell interpretation. NODE_OPTIONS propagates the
// hook to the separate seed, add/wake/status, and actual CLI run processes.
execFileSync(
	process.execPath,
	[fileURLToPath(new URL('./interpretation-cli.mjs', import.meta.url)), ...process.argv.slice(2)],
	{
		cwd: repository,
		env: {
			...process.env,
			NODE_OPTIONS: [process.env.NODE_OPTIONS ?? '', '--import', register].join(' ').trim(),
			NAMZU_INTERPRETATION_BASELINE_MANIFEST: manifest,
		},
		stdio: 'inherit',
	},
)
