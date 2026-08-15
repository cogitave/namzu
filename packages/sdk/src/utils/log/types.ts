// The LogSink seam's record and pipeline types.
//
// `../logger.ts` keeps `Logger`, `LogContext`, `getRootLogger` and
// `configureLogger` completely unchanged — `Logger` is in INPUT position on
// the public surface (`logger?: Logger` on `RunConfig` and tool config), so
// every host's existing implementation must keep satisfying it forever.
// Everything here is additive: a new, structurally separate seam that does
// not touch that interface.

/**
 * The severity vocabulary Namzu actually emits. `trace` and `fatal` are
 * deliberately absent — shipping either with no emitter is exactly the "a
 * declaration nothing drives is a defect" this codebase forbids, and `fatal`
 * in a library is a category error besides: the SDK never terminates the
 * host process it runs inside. The OTel numeric scale leaves 1-4 and 21-24
 * free, so both can arrive later, with their own emitters, without renaming
 * anything that ships today.
 */
export type Severity = 'debug' | 'info' | 'warn' | 'error'

/**
 * `silent` is not a severity — nothing is ever emitted "at" silent. It is a
 * property of a filter, which is why it lives on this type and not on
 * `Severity`.
 */
export type LevelFilter = Severity | 'silent'

/** OTel Resource: identifies the process emitting records, stamped once per
 *  logger and never per call. */
export interface Resource {
	readonly 'service.name': string
	readonly 'service.version'?: string
	readonly 'service.instance.id'?: string
}

/**
 * A structural subset of the OTel Logs Data Model — the fields this
 * increment actually populates. `traceId`, `spanId` and `eventName` are not
 * here: each arrives, together with the emitter that writes it, in later
 * work. Declaring them now and leaving them unwritten would be the same
 * defect with extra steps — present on the type, wrong in every record.
 */
export interface LogRecord {
	/** Epoch ms at the call site. */
	readonly timestamp: number
	/** Epoch ms at the point the pipeline finished building the record. */
	readonly observedTimestamp: number
	readonly severityNumber: 5 | 9 | 13 | 17
	readonly severityText: Severity
	/** OTel Body. Intended to be a constant string at every call site — a
	 *  future CI gate enforces that; this type does not. */
	readonly body: string
	readonly scope: { readonly name: string }
	/** Stamped once by `createLogger` from `LoggerOptions.resource`, never
	 *  per call. */
	readonly resource: Resource
	readonly attributes: Readonly<Record<string, unknown>>
}

export interface LogSink {
	/**
	 * Must not throw. `createLogger`'s dispatch enforces this regardless —
	 * see `create-logger.ts` — because a host sink is arbitrary code the
	 * kernel does not control, and the seam cannot rely on every
	 * implementation honouring a comment.
	 */
	emit(record: LogRecord): void
}

export interface LoggerOptions {
	readonly sink: LogSink
	/**
	 * A mutable holder, read per record inside `createLogger`'s dispatch —
	 * never captured in a closure at construction. `child()` on today's
	 * `Logger` bakes its level in exactly that way, which is why the
	 * module-scope loggers in `skills/loader.ts`, `skills/registry.ts` and
	 * `plugin/loader.ts` are frozen at `info` forever and unreachable by any
	 * later `configureLogger` call — verified live: `skills/loader.ts:12`,
	 * `skills/registry.ts:10` and `plugin/loader.ts:12` all call
	 * `getRootLogger().child({...})` at module load time.
	 */
	readonly level: { current: LevelFilter }
	readonly resource: Resource
	readonly scope: string
}

export interface LogSinkCounters {
	/** Records that never reached a live sink — the sink threw, or the
	 *  configured sink was `NOOP_SINK`. */
	readonly dropped: number
	/** Records where the redaction scan replaced at least one matched value. */
	readonly redacted: number
	/** Records where more than 64 attributes were present; the excess were
	 *  dropped. */
	readonly attributesDropped: number
	/** Attribute string values truncated at the per-value byte cap. */
	readonly valuesTruncated: number
	/** Records whose total serialized size exceeded the cap and were
	 *  shrunk by dropping attributes. */
	readonly recordsTruncated: number
}

/**
 * The mutable view of `LogSinkCounters` the pipeline writes through.
 * Deliberately not exported from `log/index.ts` — a consumer only ever
 * reads the readonly view attached to the logger it was handed, never
 * increments one directly.
 */
export type MutableLogSinkCounters = { -readonly [K in keyof LogSinkCounters]: LogSinkCounters[K] }
