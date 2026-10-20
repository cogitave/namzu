import { join, resolve } from 'node:path'

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
			return createCodeAnalysisProvider(cacheDir !== undefined ? { cacheDir } : {})
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

/** Where the index files live, for `namzu doctor`-style reporting and tests. */
export function codeAnalysisCacheDir(home: string): string {
	return join(resolve(home), 'cache', 'analysis')
}
