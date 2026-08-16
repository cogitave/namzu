import { LOG_SECRET_PATTERNS } from '@namzu/sdk'
import type { RunEvent } from '@namzu/sdk'

/**
 * Exporting a session's CONTENT, which is not what the rest of this package
 * does.
 *
 * `provider.ts` and `metrics.ts` trace the agent's own execution —
 * `namzu.agent.run`, `namzu.tool.execute`, the chat spans — and that is
 * operational telemetry, deliberately not a mirror of the conversation. An
 * operator who wants to hand a session to support, or replay one while
 * debugging, had no seam at all: they would instrument the store or the
 * session layer by hand, with no redaction extension point and nothing to
 * tell an end user what leaves the machine.
 *
 * Three properties are what make this safe enough to offer, and each is
 * enforced rather than documented:
 *
 *  - **A redactor may refuse.** The chain is an ordered array of
 *    transforms; returning `null` drops the record and stops the chain. A
 *    redactor that THROWS also drops it — the record is never emitted
 *    un-redacted as a fallback, because a redaction stage that fails open
 *    is the exact failure this whole seam exists to prevent.
 *  - **Export cannot stall a run.** `emit` is fire-and-forget from the
 *    listener's point of view; a sink that takes a second to reach its
 *    destination costs the run nothing, and a sink that throws is caught.
 *  - **A host can state what leaves.** {@link describeSessionExport}
 *    returns one sentence naming the destination, the event types, the
 *    installed redactor count, and whether conversation text is included —
 *    and that last one is DERIVED from the event types rather than
 *    declared beside them, so the disclosure cannot disagree with the
 *    filter.
 *
 * What this is NOT: a boundary the OS enforces, or a guarantee that a
 * redactor caught everything. `LOG_SECRET_PATTERNS` is a pattern table, and
 * a credential in a shape it does not know reaches the sink. The seam makes
 * redaction possible and states its own reach; it does not make leakage
 * inexpressible.
 */

/**
 * One run event on its way out, with the moment the listener saw it.
 *
 * Wraps the SDK's own `RunEvent` rather than flattening it into an
 * export-shaped record. A flattened copy is a second definition of every
 * event in the kernel, and the one that drifted would be the one an
 * operator was reading during an incident.
 */
export interface SessionExportRecord {
	/** The event, verbatim as the run emitted it. */
	readonly event: RunEvent
	/** Epoch ms at which the listener saw it. */
	readonly at: number
}

/**
 * A transform in the redaction chain.
 *
 * Returning `null` DROPS the record: it is not emitted, and no later
 * redactor runs. That is the whole reason this is a nullable return rather
 * than a mapper — a redactor that can only rewrite cannot express "this
 * record must not leave at all".
 */
export type SessionExportRedactor = (record: SessionExportRecord) => SessionExportRecord | null

/** Where redacted records go. */
export interface SessionExportSink {
	/**
	 * Hand over one record.
	 *
	 * Returns `void`, and the listener never waits on it. A sink that
	 * batches, retries or dials a network does so on its own time.
	 */
	emit(record: SessionExportRecord): void
	/** Flush whatever is buffered. Resolves when the destination has it. */
	shutdown(): Promise<void>
}

export interface SessionExportConfig {
	readonly sink: SessionExportSink
	/**
	 * Human-readable destination, for the disclosure.
	 *
	 * Required, and a string rather than a URL: the sink may be a file, a
	 * collector, or an in-process buffer, and a host that cannot name where
	 * a session goes should not be exporting one.
	 */
	readonly destination: string
	/**
	 * Which event types leave. Absent means every one of them.
	 *
	 * This is the ONLY control over what is exported, on purpose. A second
	 * `includeMessageText` flag beside it would be a claim that could
	 * disagree with this list, and the disclosure would then have to pick
	 * one of them to believe.
	 */
	readonly eventTypes?: readonly RunEvent['type'][]
	/** Applied in order, before `emit`. */
	readonly redactors?: readonly SessionExportRedactor[]
	/** Injectable for tests, the same way the read models take one. */
	readonly now?: () => number
}

/**
 * The listener, plus what it has done.
 *
 * A callable with two counters rather than a bare function: a redactor that
 * refuses is a silent event by design, and "nothing was exported" and "every
 * record was dropped" are indistinguishable without them. It is still
 * assignable to the SDK's `RunEventListener`, so it attaches to
 * `query({ onEvent })` with no new hook.
 */
export interface SessionExportListener {
	(event: RunEvent): void
	/** Records handed to the sink. */
	readonly exported: number
	/** Records a redactor refused — by returning `null`, or by throwing. */
	readonly dropped: number
	/** Records the sink itself threw on. They left the chain; they may not have arrived. */
	readonly failed: number
	/** Records the `eventTypes` filter excluded before any redactor ran. */
	readonly filtered: number
}

/**
 * Event types that carry model- or user-authored text.
 *
 * Enumerated from `packages/sdk/src/types/run/events.ts` by the fields each
 * member declares — `text`, `content`, `result`, `messages`, `question`,
 * `answer`, `summary`, `output`, `systemPrompt`. It is what
 * {@link describeSessionExport} derives its "conversation text is included"
 * sentence from, which is why it is a table here rather than a judgement at
 * the call site: an operator reading the disclosure is asking a question
 * about this list, and a list that drifts from the event union makes the
 * disclosure quietly wrong.
 *
 * Erring inclusive: `activity_updated` carries an `output` and `plan_ready`
 * a `summary`, and both are the agent's own words even though neither is a
 * chat message. A disclosure that under-claims is worse than one that
 * over-claims, because only the first is a surprise.
 */
export const CONTENT_BEARING_EVENT_TYPES: readonly RunEvent['type'][] = [
	'run_started',
	'request_envelope',
	'compaction_shed',
	'compaction_failed',
	'tool_completed',
	'user_question_asked',
	'run_completed',
	'activity_updated',
	'plan_ready',
	'agent_completed',
	'plugin_hook_completed',
	'reasoning_delta',
	'reasoning_completed',
	'text_delta',
	'message_completed',
]

/**
 * The shipped redactor: replace known credential shapes wherever they appear
 * in an event.
 *
 * Uses `LOG_SECRET_PATTERNS`, the WIDER of the SDK's two tables, and that
 * choice follows the reasoning already written in
 * `packages/sdk/src/constants/secret-patterns.ts`: the narrow
 * `OUTPUT_SECRET_PATTERNS` set exists because a false positive there
 * rewrites the answer a caller asked for. Here a false positive redacts one
 * word out of an exported record, which is the cost the wide net is worth
 * paying for.
 *
 * Serialise-scan-parse rather than a recursive walk, because a run event's
 * text is nested at a different depth in nearly every member of the union
 * and a walk that missed one arm would fail silently in exactly the way this
 * is meant to prevent. The cost is a JSON round trip per record, which is
 * the same order as handing it to a sink at all.
 */
export function secretRedactor(): SessionExportRedactor {
	return (record) => {
		let text: string
		try {
			text = JSON.stringify(record.event)
		} catch {
			// A cyclic or unserialisable event cannot be scanned, so it cannot
			// be cleared. Refuse it: an unscannable record is exactly the one
			// that must not leave.
			return null
		}
		let redacted = text
		for (const [label, pattern] of LOG_SECRET_PATTERNS) {
			pattern.lastIndex = 0
			if (!pattern.test(redacted)) continue
			pattern.lastIndex = 0
			redacted = redacted.replace(pattern, `[REDACTED:${label}]`)
		}
		if (redacted === text) return record
		return { ...record, event: JSON.parse(redacted) as RunEvent }
	}
}

/**
 * Build the listener.
 *
 * Attaches to `query({ onEvent })` unchanged — the return type is callable
 * as a `RunEventListener`.
 */
export function createSessionExportListener(config: SessionExportConfig): SessionExportListener {
	const now = config.now ?? Date.now
	const redactors = config.redactors ?? []
	const allowed = config.eventTypes ? new Set<string>(config.eventTypes) : undefined

	let exported = 0
	let dropped = 0
	let failed = 0
	let filtered = 0

	const listener = (event: RunEvent): void => {
		if (allowed && !allowed.has(event.type)) {
			filtered++
			return
		}

		let record: SessionExportRecord | null = { event, at: now() }
		for (const redact of redactors) {
			try {
				record = redact(record)
			} catch {
				// DROPPED, not emitted un-redacted. A redaction stage that fails
				// open exports exactly the record somebody installed a redactor to
				// stop, and it does it at the moment the redactor is most likely
				// to be wrong about its input.
				//
				// The exception does not escape either: this listener runs inside
				// the run's event loop, and a throwing exporter must not be able
				// to end a run.
				dropped++
				return
			}
			// A refusal stops the chain. Running the rest would ask later
			// redactors to transform a record that is not going anywhere, and
			// one of them observing that call is a side effect nobody asked for.
			if (record === null) {
				dropped++
				return
			}
		}

		try {
			config.sink.emit(record)
			exported++
		} catch {
			// Counted apart from `dropped`: the record cleared the chain and was
			// released. Whether it ARRIVED is the sink's business, and conflating
			// the two would let a broken destination read as a working redactor.
			failed++
		}
	}

	return Object.defineProperties(listener, {
		exported: { get: () => exported, enumerable: true },
		dropped: { get: () => dropped, enumerable: true },
		failed: { get: () => failed, enumerable: true },
		filtered: { get: () => filtered, enumerable: true },
	}) as SessionExportListener
}

/**
 * The sentence a host shows a user before a session leaves the machine.
 *
 * Takes the config rather than the listener so it can be rendered at boot,
 * before a run exists — and returns a DISTINCT string when export is
 * unconfigured. A disclosure that read the same in both states would be a
 * check that cannot fail: it would satisfy any test asserting "the
 * disclosure is shown" while telling a user nothing about which of the two
 * situations they are in.
 */
export function describeSessionExport(config?: SessionExportConfig): string {
	if (!config) {
		return 'Session export is off: no run events, and no conversation text, leave this machine.'
	}

	const types = config.eventTypes
	const typeCount = types ? types.length : undefined
	const typePhrase =
		types === undefined
			? 'every run event'
			: types.length === 0
				? 'no event types (nothing will be exported)'
				: `${typeCount} event type${typeCount === 1 ? '' : 's'} (${[...types].sort().join(', ')})`

	const redactorCount = config.redactors?.length ?? 0
	const redactorPhrase =
		redactorCount === 0
			? 'no redactors are installed'
			: `${redactorCount} redactor${redactorCount === 1 ? '' : 's'} run before anything is sent`

	// DERIVED from the event types, never declared beside them — see
	// `SessionExportConfig.eventTypes`.
	const carriesText =
		types === undefined ? true : types.some((t) => CONTENT_BEARING_EVENT_TYPES.includes(t))
	const textPhrase = carriesText
		? 'conversation text IS included'
		: 'no conversation text is included'

	return `Session export is on: ${typePhrase} is sent to ${config.destination}, ${redactorPhrase}, and ${textPhrase}.`
}
