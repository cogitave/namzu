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
 * kernel actually populates. `traceId`, `spanId` and `traceFlags` arrived
 * together with the emitter that writes them: `createLogger`'s `emit`,
 * reading `telemetry/runtime-accessors.ts`'s `getActiveSpanContext()` on
 * every accepted record. See their own doc comment below for what
 * "arrived" means when nothing is active — declaring them and leaving them
 * unwritten would have been the same defect with extra steps, present on
 * the type and wrong in every record.
 *
 * `eventName` arrives a different way than the rest of the record. No
 * field on `LoggerOptions` sets it and `Logger` gains no method for it —
 * `Logger` is in INPUT position on the public surface (see the file
 * header), so a fifth method would break every host's existing
 * implementation. Instead a call site sets `EVENT_NAME_ATTRIBUTE` on the
 * `data` it already passes to `debug`/`info`/`warn`/`error`; `createLogger`
 * promotes that one attribute onto this field and deletes it from
 * `attributes` so the same name never appears twice in one record.
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
	/** Promoted from the `EVENT_NAME_ATTRIBUTE` attribute when a call site
	 *  set one. Absent on the great majority of records — only the boot
	 *  narrative and other named events carry it. */
	readonly eventName?: string
	/**
	 * The active span's identity at the moment this record was built —
	 * resolved fresh per record by `createLogger`'s `emit`, from
	 * `telemetry/runtime-accessors.ts`'s `getActiveSpanContext()`. All three
	 * of `traceId`, `spanId` and `traceFlags` arrive together or not at
	 * all: a trace id with no span id would be a half-address, useless to a
	 * trace viewer's join and worse than the plain absence a reader can
	 * already tell apart from "unwritten".
	 *
	 * Genuinely ABSENT — not `''`, not `'unknown'` — whenever nothing is
	 * active: no tracer provider registered, or a real one registered with
	 * no context manager to carry it past the first `await` (the default
	 * `NoopContextManager` `@opentelemetry/api` ships is exactly that; see
	 * `getActiveSpanContext`'s own doc). Reading the active context this
	 * way cannot make a check fail on a host that never configured
	 * telemetry — it can only ever add information that was not there
	 * before.
	 */
	readonly traceId?: string
	readonly spanId?: string
	readonly traceFlags?: number
}

/**
 * The one attribute key `createLogger` treats specially: set it on the
 * `data` passed to a `Logger` call and the value is promoted to
 * `LogRecord.eventName` and removed from `attributes`, rather than copied to
 * both — an attribute and a field carrying the same value would be the same
 * name spelled two ways in one record. Exported so the small number of call
 * sites that name an event (see `BOOT_EVENT_NAMES` in
 * `constants/telemetry`) spell the reserved key once, not as a duplicated
 * string literal each has to keep in sync with this one.
 */
export const EVENT_NAME_ATTRIBUTE = 'namzu.event.name'

/**
 * The other attribute key `createLogger` treats specially, alongside
 * `EVENT_NAME_ATTRIBUTE` above: set it on the `data` passed to a `Logger`
 * call to the THROWN VALUE ITSELF — not a string a call site already built
 * with `toErrorMessage` — and `errorAttributes` (`./exception.ts`) maps it
 * to `exception.type` / `exception.message` / `exception.stacktrace` before
 * the record reaches redaction and the size caps, exactly like any other
 * attribute a call site set by hand. Removed from `attributes` the same way
 * `EVENT_NAME_ATTRIBUTE` is, so the raw `Error` object this key held is
 * never itself what a sink tries to serialize.
 *
 * Spelled `err`, not `error`: dozens of existing call sites already pass
 * `{ error: toErrorMessage(err) }` — a STRING built by hand — and giving the
 * new, structured path a different key means both shapes keep compiling
 * side by side instead of one silently shadowing the other depending on
 * which call site wrote last.
 */
export const ERR_ATTRIBUTE = 'err'

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
