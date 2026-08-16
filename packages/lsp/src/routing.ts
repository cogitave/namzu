import { extname } from 'node:path'

import { type StdioCodeNavigationOptions, StdioCodeNavigationProvider } from './stdio.js'
import type {
	CodeNavigationProvider,
	CodeNavigationResult,
	HoverResult,
	SymbolSearchResult,
} from './types.js'

/**
 * One server per language, started when its first file is asked about.
 *
 * A single hard-wired server means the capability exists for one language in
 * a repository that will not stay one language — and the failure is quiet:
 * a `.py` file reaches a server that has never parsed Python, which answers
 * nothing, which reads as a symbol with no references.
 *
 * **A file whose extension maps to nothing is `unsupported`, naming the
 * extension.** Not routed to a default, and not an empty result. A default
 * would send the file to a server that cannot read it and produce exactly
 * the quiet wrong answer above; an empty result would say the symbol has no
 * callers.
 *
 * **Lazy, and reused.** Starting every configured server up front pays for
 * languages a run never touches, and starting one per request would pay the
 * initialize handshake — seconds, for an indexing server — on every call.
 */

export interface CodeNavigationRoute {
	/** Extensions this server answers for, with the dot: `['.ts', '.tsx']`. */
	readonly extensions: readonly string[]
	readonly server: StdioCodeNavigationOptions
}

export interface RoutingCodeNavigationOptions {
	readonly routes: readonly CodeNavigationRoute[]
	/**
	 * How a route becomes a provider.
	 *
	 * Injectable so a test can count spawns — the reuse property is about
	 * how many processes exist, and asserting it on wall-clock time would
	 * pass on a fast machine with the reuse removed.
	 */
	readonly createProvider?: (options: StdioCodeNavigationOptions) => CodeNavigationProvider
}

export class RoutingCodeNavigationProvider implements CodeNavigationProvider {
	private readonly byExtension = new Map<string, CodeNavigationRoute>()
	private readonly started = new Map<CodeNavigationRoute, CodeNavigationProvider>()
	private readonly create: (options: StdioCodeNavigationOptions) => CodeNavigationProvider

	constructor(options: RoutingCodeNavigationOptions) {
		this.create = options.createProvider ?? ((server) => new StdioCodeNavigationProvider(server))
		for (const route of options.routes) {
			for (const extension of route.extensions) {
				// Lower-cased once, here. A `.TS` on a case-insensitive filesystem
				// is the same language, and a lookup that missed it would report
				// the extension as unconfigured.
				this.byExtension.set(extension.toLowerCase(), route)
			}
		}
	}

	async definition(file: string, line: number, character: number): Promise<CodeNavigationResult> {
		const routed = this.routeFor(file)
		if ('reason' in routed) return { kind: 'unsupported', reason: routed.reason }
		return await routed.provider.definition(file, line, character)
	}

	async references(file: string, line: number, character: number): Promise<CodeNavigationResult> {
		const routed = this.routeFor(file)
		if ('reason' in routed) return { kind: 'unsupported', reason: routed.reason }
		return await routed.provider.references(file, line, character)
	}

	async hover(file: string, line: number, character: number): Promise<HoverResult> {
		const routed = this.routeFor(file)
		if ('reason' in routed) return { kind: 'unsupported', reason: routed.reason }
		return await routed.provider.hover(file, line, character)
	}

	/**
	 * Search by name, across one language or all of them.
	 *
	 * With a scope, the scope's extension picks the server — the ordinary
	 * case, and the cheap one. Without, every configured language answers,
	 * because "find this symbol" in a mixed repository means all of it and a
	 * caller who wanted one language would have said which.
	 */
	async symbols(query: string, scope?: string): Promise<SymbolSearchResult> {
		if (scope) {
			const routed = this.routeFor(scope)
			if ('reason' in routed) return { kind: 'unsupported', reason: routed.reason }
			return await routed.provider.symbols(query, scope)
		}

		const routes = [...new Set(this.byExtension.values())]
		if (routes.length === 0) {
			return { kind: 'unsupported', reason: 'No language servers are configured.' }
		}

		const answers = await Promise.all(
			routes.map(async (route) => await this.providerFor(route).symbols(query)),
		)
		const found = answers.flatMap((a) => (a.kind === 'symbols' ? a.symbols : []))
		if (found.length > 0) return { kind: 'symbols', symbols: found }

		// Nothing found anywhere. If EVERY server refused, that is not an empty
		// result — nobody looked. Reporting it as `symbols: []` would tell the
		// caller the name does not exist in the repository.
		const failure = answers.find((a) => a.kind === 'failed')
		if (failure) return failure
		const unsupported = answers.find((a) => a.kind === 'unsupported')
		if (unsupported && answers.every((a) => a.kind === 'unsupported')) return unsupported
		return { kind: 'symbols', symbols: [] }
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.started.values()].map(async (p) => await p.dispose()))
		this.started.clear()
	}

	/** How many servers are running. For a test asserting reuse. */
	startedCount(): number {
		return this.started.size
	}

	private routeFor(file: string): { provider: CodeNavigationProvider } | { reason: string } {
		const extension = extname(file).toLowerCase()
		const route = this.byExtension.get(extension)
		if (!route) {
			return {
				reason: `No language server is configured for "${extension || file}". Configure one, or use \`grep\` and treat the result as textual.`,
			}
		}
		return { provider: this.providerFor(route) }
	}

	private providerFor(route: CodeNavigationRoute): CodeNavigationProvider {
		const existing = this.started.get(route)
		if (existing) return existing
		const created = this.create(route.server)
		this.started.set(route, created)
		return created
	}
}
