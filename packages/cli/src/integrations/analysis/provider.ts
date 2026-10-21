import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CodeAnalysisProvider, CodeAnalysisResult } from '@namzu/sdk'

import { ensurePrivateStateDirectory } from '../state/private-directory.js'

/**
 * The code index, constructed on first use.
 *
 * `@namzu/analysis` pulls in a native parser and `node:sqlite`; neither is
 * wanted on the path to the first frame, and most sessions never ask a code
 * question. So the SESSION holds this thin provider, which does nothing until
 * a `code_analysis` call arrives, and only then imports the package, creates
 * its cache directory and opens a database.
 *
 * The cache lives at `<namzu home>/cache/analysis`, beside the compile cache,
 * created owner-only. If that directory cannot be made the index runs in
 * memory rather than the tool failing: an index that does not persist is
 * slower on the next launch, not wrong.
 */
export function createLazyCodeAnalysis(home: string): CodeAnalysisProvider {
	let real: Promise<CodeAnalysisProvider> | undefined
	const load = (): Promise<CodeAnalysisProvider> => {
		real ??= (async () => {
			const { createCodeAnalysisProvider } = await import('@namzu/analysis')
			let cacheDir: string | undefined
			try {
				const root = resolve(home)
				cacheDir = ensurePrivateStateDirectory(
					ensurePrivateStateDirectory(root, 'cache'),
					'analysis',
				)
			} catch {
				cacheDir = undefined
			}
			const hostScript = parsingChildScript()
			return createCodeAnalysisProvider({
				...(cacheDir !== undefined ? { cacheDir } : {}),
				...(hostScript !== undefined ? { hostScript } : {}),
			})
		})()
		return real
	}
	/** A failure to even load the package is an answer, not an exception in a tool call. */
	const guard = async <T>(
		call: (p: CodeAnalysisProvider) => Promise<CodeAnalysisResult<T>>,
	): Promise<CodeAnalysisResult<T>> => {
		let provider: CodeAnalysisProvider
		try {
			provider = await load()
		} catch (err) {
			real = undefined
			return {
				kind: 'unsupported',
				reason: `The code index could not be loaded: ${err instanceof Error ? err.message : String(err)}.`,
			}
		}
		return await call(provider)
	}
	return {
		index: (r) => guard((p) => p.index(r)),
		findLiteral: (r) => guard((p) => p.findLiteral(r)),
		enclosingFunction: (r) => guard((p) => p.enclosingFunction(r)),
		functionSource: (r) => guard((p) => p.functionSource(r)),
		callersOf: (r) => guard((p) => p.callersOf(r)),
		imports: (r) => guard((p) => p.imports(r)),
		async dispose() {
			// Never loaded means nothing is open, and importing the package just to
			// close nothing would cost exactly what the laziness saved.
			const pending = real
			real = undefined
			if (pending) await (await pending.catch(() => undefined))?.dispose()
		},
	}
}

/**
 * The parsing child this CLI ships: `dist/analysis-host.js`, a bundle entry.
 *
 * Found relative to this module's place in the original layout (the build
 * rewrites `import.meta.url` to it), so it is the file beside the running
 * bundle wherever the CLI is installed. Undefined when it is not there, which
 * is the case when running from source in a test; the package then forks its
 * own build.
 */
export function parsingChildScript(): string | undefined {
	const script = fileURLToPath(new URL('../../analysis-host.js', import.meta.url))
	return existsSync(script) ? script : undefined
}

/**
 * What `namzu doctor` runs: index one tiny file through the same provider, and
 * the same parsing child, a session uses, in memory. A packaged CLI whose child
 * script or native parser is missing says so here instead of on the first
 * question about code.
 */
export async function codeAnalysisSelfTest(): Promise<
	{ ok: true; detail: string } | { ok: false; detail: string }
> {
	const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const dir = await mkdtemp(join(tmpdir(), 'namzu-analysis-selftest-'))
	let provider: CodeAnalysisProvider | undefined
	try {
		await writeFile(join(dir, 'probe.js'), 'function probe() { return "namzu-self-test" }\n')
		const { createCodeAnalysisProvider } = await import('@namzu/analysis')
		const hostScript = parsingChildScript()
		provider = createCodeAnalysisProvider(hostScript !== undefined ? { hostScript } : {})
		const found = await provider.findLiteral({ root: dir, text: 'namzu-self-test' })
		if (found.kind !== 'ok') {
			return { ok: false, detail: found.kind === 'failed' ? found.error : found.reason }
		}
		const hit = found.value.items[0]
		if (found.value.total !== 1 || hit?.function?.name !== 'probe') {
			return {
				ok: false,
				detail: 'the index answered, but not with the function that holds the test string',
			}
		}
		return {
			ok: true,
			detail: `parsed in a child process (${hostScript !== undefined ? 'the CLI bundle' : 'the package'})`,
		}
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) }
	} finally {
		await provider?.dispose().catch(() => undefined)
		await rm(dir, { recursive: true, force: true }).catch(() => undefined)
	}
}

/** Where the index files live, for `namzu doctor`-style reporting and tests. */
export function codeAnalysisCacheDir(home: string): string {
	return join(resolve(home), 'cache', 'analysis')
}
