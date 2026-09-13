// Run the same cases against the committed adapter and shared engine. The two
// original modules are transpiled in a temporary directory; installed production
// files are never replaced. Dependencies retain their current built locations.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const revision = '97acc32c'
const root = fileURLToPath(new URL('../../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'namzu-selection-baseline-'))
const require = createRequire(new URL('../../packages/sdk/package.json', import.meta.url))
const paths = ['manager/resident/evidence-recall', 'run/evidence-recall']
const originalSources = {}
for (const [i, path] of paths.entries()) {
	const source = execFileSync('git', ['show', `${revision}:packages/sdk/src/${path}.ts`], {
		cwd: root,
		encoding: 'utf8',
	})
	originalSources[path] = createHash('sha256').update(source).digest('hex')
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
	})
	const base = new URL(`../../packages/sdk/dist/${path}.js`, import.meta.url)
	const text = outputText.replace(/from ['"]([^'"]+)['"]/g, (_match, name) => {
		let target = name.startsWith('.')
			? new URL(name, base).href
			: name.startsWith('node:')
				? name
				: pathToFileURL(require.resolve(name)).href
		if (target === new URL('../../packages/sdk/dist/run/evidence-recall.js', import.meta.url).href)
			target = pathToFileURL(join(temporary, '1.mjs')).href
		return `from ${JSON.stringify(target)}`
	})
	await writeFile(join(temporary, `${i}.mjs`), text)
}
await writeFile(
	join(temporary, 'sources.json'),
	`${JSON.stringify({ revision, originalSources }, null, 2)}\n`,
)
execFileSync(
	process.execPath,
	[
		fileURLToPath(new URL('./selection-quality.mjs', import.meta.url)),
		`baseline-${revision}`,
		...(process.argv[2] ? [process.argv[2]] : []),
	],
	{
		cwd: root,
		env: {
			...process.env,
			NAMZU_SELECTION_ADAPTER: pathToFileURL(join(temporary, '0.mjs')).href,
			NAMZU_SELECTION_ENGINE: pathToFileURL(join(temporary, '1.mjs')).href,
		},
		stdio: 'inherit',
	},
)
console.log(`Baseline source manifest: ${join(temporary, 'sources.json')}`)
