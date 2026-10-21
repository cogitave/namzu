import { extname } from 'node:path'

/**
 * `oxc-parser`, loaded on the first parse.
 *
 * The package is native: importing it maps a shared library and, with raw
 * transfer, allocates a multi-megabyte buffer. A host that never asks a code
 * question must not pay for either, and the CLI's start-up time is measured.
 */
type OxcModule = typeof import('oxc-parser')

let oxc: Promise<{ module: OxcModule; raw: boolean }> | undefined

/**
 * The parser cannot be loaded: its native binary is missing for this platform,
 * or the package is not installed. Distinct from a file that does not parse,
 * because it is not about any file: every file would fail the same way, and an
 * index that recorded each as "parser failure" would be empty while looking
 * merely incomplete.
 */
export class ParserUnavailableError extends Error {
	override readonly name = 'ParserUnavailableError'
}

/**
 * The module to load the parser from. `oxc-parser` always, except where the
 * host names another (a vendored copy; a test's stand-in). It is chosen by the
 * parent and handed to the child as an argument, never read from the
 * environment, which a production process should not be steered by.
 */
let parserModule = 'oxc-parser'
export function useParserModule(specifier: string): void {
	parserModule = specifier
	oxc = undefined
}

async function loadOxc(): Promise<{ module: OxcModule; raw: boolean }> {
	oxc ??= (import(parserModule) as Promise<OxcModule>).then(
		(module) => {
			let raw = false
			try {
				raw = module.rawTransferSupported()
			} catch {
				raw = false
			}
			return { module, raw }
		},
		(err: unknown) => {
			// Not cached: a later call may succeed once the install is repaired.
			oxc = undefined
			throw new ParserUnavailableError(
				`The JavaScript parser (oxc-parser) could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
			)
		},
	)
	return await oxc
}

export interface Parsed {
	/** The ESTree `Program`. Valid only until the next parse; consume it at once. */
	readonly program: unknown
	readonly errors: number
	readonly firstError?: string
	/** Where each error starts, as an offset into the text parsed. */
	readonly errorStarts: readonly number[]
	/** The parser recovered nothing: the program has no statements. */
	readonly empty: boolean
}

export const SOURCE_EXTENSIONS: ReadonlyMap<string, 'js' | 'jsx' | 'ts' | 'tsx'> = new Map([
	['.js', 'jsx'],
	['.mjs', 'jsx'],
	['.cjs', 'jsx'],
	['.jsx', 'jsx'],
	['.ts', 'ts'],
	['.mts', 'ts'],
	['.cts', 'ts'],
	['.tsx', 'tsx'],
])

/** `.d.ts` and friends declare types and hold no function bodies to index. */
export function isDeclarationFile(path: string): boolean {
	return /\.d\.[cm]?ts$/.test(path)
}

export function languageOf(path: string): 'js' | 'jsx' | 'ts' | 'tsx' | undefined {
	return SOURCE_EXTENSIONS.get(extname(path).toLowerCase())
}

/**
 * Parse one file.
 *
 * Choices, each measured on a 44 MB bundle and on this repository:
 *
 * - **Raw transfer when the platform has it.** The AST arrives as one buffer
 *   and is deserialised in a single pass, about twice as fast as the default.
 *   Where it is not supported the eager parse is used; the result is the same
 *   tree.
 * - **Not the lazy visitor.** In 0.155.0 it drops `extends` subtrees, which
 *   silently loses every call in a class heritage clause.
 * - **`sourceType: 'unambiguous'`, then `'commonjs'`.** A file that fails as a
 *   module but parses as a script (top-level `return`, `with`) is taken as the
 *   script. `.cjs` and `.mjs` say which they are.
 * - **`lang: 'jsx'` for JavaScript.** Plenty of `.js` files carry JSX.
 * - **`preserveParens: false`.** A parenthesised callee is the callee.
 *
 * Throws when the parser itself throws; a file that merely has syntax errors
 * comes back with `errors > 0` and whatever tree the parser recovered.
 */
export async function parseSource(
	path: string,
	text: string,
	as?: 'js' | 'jsx' | 'ts' | 'tsx',
): Promise<Parsed> {
	const { module, raw } = await loadOxc()
	return parseWith(module, raw, path, text, as)
}

function parseWith(
	module: OxcModule,
	raw: boolean,
	path: string,
	text: string,
	as?: 'js' | 'jsx' | 'ts' | 'tsx',
): Parsed {
	const lang = as ?? languageOf(path)
	const ext = extname(path).toLowerCase()
	const base = {
		preserveParens: false,
		// An extension-less script (found by its shebang) has no extension to say
		// what it is: JavaScript, with JSX tolerated like any `.js`.
		...(lang === 'jsx' || (lang === undefined && ext === '') ? { lang: 'jsx' as const } : {}),
		...(as === 'tsx' || as === 'ts' ? { lang: as } : {}),
	}
	const sourceType = ext === '.cjs' ? 'commonjs' : ext === '.mjs' ? 'module' : 'unambiguous'
	const attempt = (type: 'unambiguous' | 'commonjs' | 'module', useRaw: boolean) => {
		const options = {
			...base,
			sourceType: type,
			...(useRaw ? { experimentalRawTransfer: true } : {}),
		}
		// `experimentalRawTransfer` is accepted at runtime but absent from the
		// published option types in this release.
		return module.parseSync(path, text, options as Parameters<typeof module.parseSync>[2])
	}
	const run = (type: 'unambiguous' | 'commonjs' | 'module') => {
		if (!raw) return attempt(type, false)
		try {
			return attempt(type, true)
		} catch {
			// Raw transfer is experimental: one file it cannot take is read the
			// ordinary way rather than lost.
			return attempt(type, false)
		}
	}

	let result = run(sourceType)
	if (result.errors.length > 0 && sourceType === 'unambiguous') {
		const script = run('commonjs')
		if (script.errors.length < result.errors.length) result = script
	}
	const first = result.errors[0]
	const body = (result.program as { body?: unknown[] }).body
	return {
		program: result.program,
		errors: result.errors.length,
		...(first ? { firstError: first.message } : {}),
		errorStarts: result.errors.flatMap((e) => (e.labels ?? []).slice(0, 1).map((l) => l.start)),
		empty: !Array.isArray(body) || body.length === 0,
	}
}
