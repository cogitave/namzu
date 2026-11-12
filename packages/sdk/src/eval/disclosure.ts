import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { EvalRunOptions } from './run-options.js'

/**
 * What a report says about how it was produced.
 *
 * A score without its provenance cannot be compared with another: two runs
 * three points apart may differ by a model, a route, a reasoning effort or a
 * harness version, and the number alone does not say which. Every fact here
 * is either known or the literal string `unknown`. Nothing is guessed, and a
 * report written before this existed has none of it and is read as unknown.
 */
export type RunMode =
	/** The model is a script; nothing measures a vendor. */
	| 'scripted'
	/** A real provider answered. */
	| 'real-model'
	/** No model was involved at all. */
	| 'no-model'
	| 'unknown'

export interface RoleDisclosure {
	readonly provider: string
	readonly model: string
}

/** The routing configuration, `off` when routing was not on. */
export type RoutingDisclosure = 'off' | 'unknown' | Readonly<Record<string, unknown>>

/**
 * What a suite declares about itself in its `runExperiment` config. Every
 * field is optional; the ones left out are written `unknown`.
 */
export interface SuiteFacts {
	readonly mode?: RunMode
	/** One entry per role that ran, such as `agent`, `judge`, `child`. */
	readonly roles?: Readonly<Record<string, { provider?: string; model?: string }>>
	readonly routing?: RoutingDisclosure
	/** The reasoning effort the model ran at, or `not applicable`. */
	readonly reasoningEffort?: string
	/** Version of the suite. The runner fills it from the suite's package when it can. */
	readonly suiteVersion?: string
}

export interface ReportDisclosure {
	/** The program that ran the suites, for example the CLI's version. */
	readonly harnessVersion: string
	readonly sdkVersion: string
	/** ISO time the experiment finished. */
	readonly generatedAt: string
	/** Cases in the suite. */
	readonly cases: number
	readonly repeats: number
	readonly seed: number
	readonly mode: RunMode
	/** `unknown` when the suite declared no roles; an empty object when no model ran. */
	readonly roles: Readonly<Record<string, RoleDisclosure>> | 'unknown'
	readonly routing: RoutingDisclosure
	readonly reasoningEffort: string
	readonly suiteVersion: string
	/** Source revision, when the runner could read one. */
	readonly commit: string
}

export const UNKNOWN = 'unknown'

let cachedSdkVersion: string | undefined

/** The version of this SDK, read from its manifest; `unknown` when it cannot be read. */
export function sdkVersion(): string {
	if (cachedSdkVersion !== undefined) return cachedSdkVersion
	try {
		// `src/eval/` and `dist/eval/` are both two levels below the package.
		const path = fileURLToPath(new URL('../../package.json', import.meta.url))
		const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
		cachedSdkVersion =
			typeof manifest.version === 'string' && manifest.version.length > 0
				? manifest.version
				: UNKNOWN
	} catch {
		cachedSdkVersion = UNKNOWN
	}
	return cachedSdkVersion
}

function text(value: string | undefined): string {
	return value !== undefined && value.length > 0 ? value : UNKNOWN
}

export function buildDisclosure(
	facts: SuiteFacts | undefined,
	counts: { cases: number; repeats: number; seed: number },
	options: EvalRunOptions,
	generatedAt: string,
): ReportDisclosure {
	let roles: ReportDisclosure['roles'] = UNKNOWN
	if (facts?.roles !== undefined) {
		const declared: Record<string, RoleDisclosure> = {}
		for (const [role, who] of Object.entries(facts.roles)) {
			declared[role] = { provider: text(who.provider), model: text(who.model) }
		}
		roles = declared
	}
	return {
		harnessVersion: text(options.harnessVersion),
		sdkVersion: sdkVersion(),
		generatedAt,
		cases: counts.cases,
		repeats: counts.repeats,
		seed: counts.seed,
		mode: facts?.mode ?? UNKNOWN,
		roles,
		routing: facts?.routing ?? UNKNOWN,
		reasoningEffort: text(facts?.reasoningEffort),
		suiteVersion: text(facts?.suiteVersion ?? options.suiteVersion),
		commit: text(options.commit),
	}
}

/** One plain line for a terminal. */
export function describeDisclosure(d: ReportDisclosure): string {
	const roles =
		d.roles === UNKNOWN
			? 'models unknown'
			: Object.keys(d.roles).length === 0
				? 'no model'
				: Object.entries(d.roles)
						.map(([role, who]) => `${role} ${who.provider}/${who.model}`)
						.join(', ')
	const routing =
		d.routing === 'off' || d.routing === UNKNOWN
			? `routing ${d.routing}`
			: `routing ${JSON.stringify(d.routing)}`
	return `ran as ${d.mode}: ${roles}; ${routing}; effort ${d.reasoningEffort}; suite ${d.suiteVersion}`
}
