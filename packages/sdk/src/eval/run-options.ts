import { AsyncLocalStorage } from 'node:async_hooks'
import type { SettingsSnapshot } from './settings.js'
import type { SplitFilter } from './split.js'

/**
 * Settings an operator gives a whole eval run, handed to every
 * `runExperiment` that executes inside it.
 *
 * A suite file calls `runExperiment` itself and returns the report, so
 * `namzu eval --repeat 5` has no argument to pass the five through. Rather
 * than ask every suite to forward it, the runner opens a scope with
 * {@link withEvalRunOptions} and `runExperiment` reads the scope. A suite
 * that was written before the option existed repeats like any other.
 *
 * An option given here wins over the same option in the suite's own config:
 * the person running the command asked for it.
 */
export interface EvalRunOptions {
	/** Times every case runs. */
	readonly repeats?: number
	/** Seed for the bootstrap. */
	readonly seed?: number
	/** Version of the program that is running the suites, for the disclosure. */
	readonly harnessVersion?: string
	/** Source revision the suites came from, when known. */
	readonly commit?: string
	/** Version of the suite being run, when known. */
	readonly suiteVersion?: string
	/**
	 * The settings the run was given. Written into every report. A suite shapes
	 * itself by them through {@link currentEvalSettings}; one that does not is
	 * reported as not having read them.
	 */
	readonly settings?: SettingsSnapshot
	/** Which tasks run. Absent means all of them. */
	readonly split?: SplitFilter
	/** Set by {@link currentEvalSettings} when a suite asks for the settings. Owned by the runner. */
	readonly settingsUse?: { read: boolean }
}

const STORE_KEY = Symbol.for('namzu.eval.runOptions')

/**
 * One store per process, found through a global symbol, so a suite that
 * resolves its own copy of the SDK still sees the scope the runner opened.
 */
function store(): AsyncLocalStorage<EvalRunOptions> {
	const holder = globalThis as { [STORE_KEY]?: AsyncLocalStorage<EvalRunOptions> }
	holder[STORE_KEY] ??= new AsyncLocalStorage<EvalRunOptions>()
	return holder[STORE_KEY]
}

/** Run `work` with `options` in force for every experiment it starts. */
export function withEvalRunOptions<T>(options: EvalRunOptions, work: () => T): T {
	return store().run(options, work)
}

/** The options in force here, or an empty set outside any scope. */
export function currentEvalRunOptions(): EvalRunOptions {
	return store().getStore() ?? {}
}

/**
 * The values of the settings the run was given, or an empty object when it was
 * given none. Asking marks the suite as one that read them, which its report
 * says: a setting nobody reads cannot have changed what a suite measured.
 */
export function currentEvalSettings(): Readonly<Record<string, unknown>> {
	const options = currentEvalRunOptions()
	if (options.settingsUse) options.settingsUse.read = true
	return options.settings?.values ?? {}
}

/** One setting by its dotted path, for example `limits.maxIterations`; undefined when not stated. */
export function evalSetting(path: string): unknown {
	let at: unknown = currentEvalSettings()
	for (const part of path.split('.')) {
		if (typeof at !== 'object' || at === null || Array.isArray(at)) return undefined
		at = (at as Record<string, unknown>)[part]
	}
	return at
}
