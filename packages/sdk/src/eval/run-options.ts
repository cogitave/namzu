import { AsyncLocalStorage } from 'node:async_hooks'

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
