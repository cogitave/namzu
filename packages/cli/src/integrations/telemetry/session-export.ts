import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { RunEventListener } from '@namzu/sdk'

import { probeOptionalPackage } from '../../context/capabilities.js'

import type { SessionExportConfig } from '../../config/schema.js'

/**
 * Turning `telemetry.sessionExport` in a config file into a live listener.
 *
 * Two things this file is careful about, and both are the reason it exists
 * rather than the wiring being inline at the call site.
 *
 * **`@namzu/telemetry` is optional, and its absence is a REFUSAL here.**
 * Everywhere else in this CLI an absent optional package degrades a feature:
 * no sandbox package, no sandbox, say so and continue. Not here. An operator
 * who wrote `sessionExport` into a config asked for a session to be
 * recorded, and continuing without it means the run happens and the record
 * they were counting on does not exist — the failure is invisible until the
 * moment they go looking for the session that was supposed to be there.
 *
 * **The redaction chain is never silently empty.** Omitting `redactors`
 * installs the shipped secret redactor. Turning redaction off takes an
 * explicit `redactors: []`, because reaching "no redaction" by forgetting a
 * key is the shape this whole seam exists to prevent.
 */

/** What the CLI needs back: a listener to attach, and a way to drain it. */
export interface AttachedSessionExport {
	readonly listener: RunEventListener
	/** Flush before the process exits. */
	shutdown(): Promise<void>
	/** The sentence to show a user — `describeSessionExport`'s output. */
	readonly disclosure: string
}

/** Why a configured export could not be started. */
export class SessionExportUnavailableError extends Error {
	constructor(
		readonly reason: 'absent' | 'broken',
		cause?: string,
	) {
		super(
			reason === 'absent'
				? 'telemetry.sessionExport is configured but "@namzu/telemetry" is not installed, so nothing would be recorded. Install it (npm i @namzu/telemetry), or remove telemetry.sessionExport from your config. Refusing rather than running a session whose export silently does not exist.'
				: `telemetry.sessionExport is configured but "@namzu/telemetry" failed to load (${cause ?? 'no detail'}). Reinstall it, or remove telemetry.sessionExport from your config.`,
		)
		this.name = 'SessionExportUnavailableError'
	}
}

/** The slice of `@namzu/telemetry` this uses. Structural, so a test needs no install. */
interface TelemetryModule {
	createSessionExportListener(config: {
		sink: { emit(record: unknown): void; shutdown(): Promise<void> }
		destination: string
		eventTypes?: readonly string[]
		redactors?: readonly ((record: unknown) => unknown)[]
	}): RunEventListener
	describeSessionExport(config?: unknown): string
	secretRedactor(): (record: unknown) => unknown
}

export type TelemetryLoader = () => Promise<TelemetryModule>

const TELEMETRY_SPECIFIER = '@namzu/telemetry'

/**
 * Load the optional package, separating "not installed" from "installed and
 * unusable" the same way `context/capabilities.ts` does — and for the same
 * reason: the two send a reader to different places.
 *
 * Takes the specifier so a test can drive the REAL resolution path with a
 * name that cannot resolve. Everything else in this file is tested through
 * an injected loader, which proves what `attachSessionExport` does with a
 * refusal and proves nothing about where the refusal comes from — a
 * mutation replacing this `throw` with a stub module survived until this was
 * separated out.
 */
export async function loadTelemetryFrom(specifier: string): Promise<TelemetryModule> {
	// Through the SAME probe the doctor and the boot narrative use, rather
	// than a second resolution here. Two answers to "is @namzu/telemetry
	// installed" is two chances to disagree, and the one that drifted would be
	// the one deciding whether a session gets recorded.
	//
	// It also inherits the fix: `require.resolve` reports an installed
	// ESM-only package as absent, which would have produced this refusal
	// against a machine that was configured correctly.
	const probe = await probeOptionalPackage(specifier)
	if (probe.state === 'absent') throw new SessionExportUnavailableError('absent')
	if (probe.state === 'broken')
		throw new SessionExportUnavailableError('broken', probe.error.message)
	return (await import(specifier)) as unknown as TelemetryModule
}

async function loadTelemetry(loader?: TelemetryLoader): Promise<TelemetryModule> {
	if (loader) return await loader()
	return await loadTelemetryFrom(TELEMETRY_SPECIFIER)
}

/**
 * A JSONL file, one record per line.
 *
 * `appendFileSync` rather than a stream, and that is a deliberate trade: a
 * stream would not block, but a stream's buffered tail is lost when the
 * process exits on a signal, and the whole value of an exported session is
 * that it survives the run that produced it. The listener already never
 * waits on `emit` — the synchronous write happens inside a call the run does
 * not await, so the cost lands on the exporting call and not on the model
 * loop.
 */
export function fileSink(destinationPath: string): {
	emit(record: unknown): void
	shutdown(): Promise<void>
} {
	const path = resolve(destinationPath)
	let ensured = false
	return {
		emit(record) {
			if (!ensured) {
				mkdirSync(dirname(path), { recursive: true })
				ensured = true
			}
			appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8')
		},
		// Nothing is buffered, so there is nothing to drain — and saying so is
		// better than an empty function that reads as an unfinished one.
		shutdown: async () => {},
	}
}

export interface AttachSessionExportOptions {
	readonly config: SessionExportConfig
	/** Injectable for tests; production resolves `@namzu/telemetry` itself. */
	readonly loader?: TelemetryLoader
	/** Injectable for tests; production appends to the configured file. */
	readonly sink?: { emit(record: unknown): void; shutdown(): Promise<void> }
}

export async function attachSessionExport(
	options: AttachSessionExportOptions,
): Promise<AttachedSessionExport> {
	const telemetry = await loadTelemetry(options.loader)
	const sink = options.sink ?? fileSink(options.config.destination)

	// Omitted means the shipped redactor; `[]` means none. A config reaches
	// "no redaction" only by saying so.
	const redactors = (options.config.redactors ?? ['secrets']).map((name) => {
		switch (name) {
			case 'secrets':
				return telemetry.secretRedactor()
		}
	})

	const exportConfig = {
		sink,
		destination: options.config.destination,
		...(options.config.eventTypes !== undefined ? { eventTypes: options.config.eventTypes } : {}),
		redactors,
	}

	return {
		listener: telemetry.createSessionExportListener(exportConfig),
		shutdown: () => sink.shutdown(),
		disclosure: telemetry.describeSessionExport(exportConfig),
	}
}

/**
 * The disclosure when export is NOT configured.
 *
 * Goes through the same function as the configured case so the two cannot
 * drift into reading alike — which is the property
 * `describeSessionExport`'s own test pins, and which is worth nothing if
 * this branch hand-writes its own sentence instead.
 */
export async function describeSessionExportOff(loader?: TelemetryLoader): Promise<string | null> {
	try {
		const telemetry = await loadTelemetry(loader)
		return telemetry.describeSessionExport()
	} catch {
		// `@namzu/telemetry` absent AND export unconfigured is the ordinary
		// case, not a problem: there is nothing to disclose because there is
		// nothing installed that could export.
		return null
	}
}
