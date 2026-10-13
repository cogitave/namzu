import { BOOT_EVENT_NAMES, EVENT_NAME_ATTRIBUTE, VERSION as SDK_VERSION } from '@namzu/sdk'

import { formatConfigSource } from './config/debug.js'
import type { ConfigProvenance, ConfigSource } from './config/load.js'
import type { NamzuCliConfig } from './config/schema.js'
import { cliLogger } from './logging.js'
import { CLI_VERSION } from './version.js'

// A module of its own so that `cli.ts` can leave `@namzu/sdk` unloaded until a
// command runs: this is the one place the command shell used the SDK, and a
// static import of it made `namzu --version` compile the whole runtime first.

/**
 * The CLI-process third of the boot narrative — the two other thirds
 * (`namzu.sandbox.resolved`/`.provider.resolved`/`.capability.*`/
 * `.discovery.completed`/`.boot.ready`, and the SDK's own
 * `namzu.migration.completed`) belong to `createAgentSession`
 * (`tui/agent.ts`) and `query()` respectively, because they describe facts
 * an agent session resolves — `doctor` and `login` never reach either.
 *
 * Exported (not re-exported from `./index.ts`) so `__tests__/` can drive it
 * directly with a hand-built `ConfigProvenance` and a capturing sink,
 * without needing a live Commander parse or a real config cascade on disk.
 */
export function emitBootNarrative(provenance: ConfigProvenance, config: NamzuCliConfig): void {
	const log = cliLogger()
	log.info('namzu starting', {
		[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.BOOT_START,
		'namzu.boot.cli_version': CLI_VERSION,
		'namzu.boot.sdk_version': SDK_VERSION,
		'namzu.boot.node_version': process.version,
		'namzu.boot.platform': `${process.platform}-${process.arch}`,
	})

	const counts: Record<ConfigSource['kind'], number> = {
		default: 0,
		'user-file': 0,
		'project-file': 0,
		profile: 0,
		env: 0,
		managed: 0,
	}
	for (const source of Object.values(provenance)) {
		if (source) counts[source.kind]++
	}
	const keyCount = Object.keys(provenance).length
	log.info('Configuration resolved', {
		[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.CONFIG_RESOLVED,
		'namzu.config.key_count': keyCount,
		'namzu.config.default_count': counts.default,
		'namzu.config.user_file_count': counts['user-file'],
		'namzu.config.project_file_count': counts['project-file'],
		'namzu.config.env_count': counts.env,
	})
	// Per-key debug rows. The value is handed to the logger as JSON text, not
	// hand-masked by key name and not omitted — the record-boundary
	// redaction scan every sink sits behind
	// (`packages/sdk/src/utils/log/redact.ts`) already screens every
	// attribute value for a secret shape, the SAME defence `namzu exec`'s
	// stderr gets. A second, bespoke "these key names are secret" table
	// here would duplicate that control and go stale the day a
	// secret-shaped value arrives under a key nobody added to it — exactly
	// the empty, undriven masking table this session already struck once.
	for (const key of Object.keys(provenance) as (keyof NamzuCliConfig)[]) {
		const source = provenance[key]
		if (!source) continue
		log.debug('config key resolved', {
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.CONFIG_RESOLVED,
			'namzu.config.key': key,
			'namzu.config.value': JSON.stringify((config as Record<string, unknown>)[key]),
			'namzu.config.source': formatConfigSource(source),
		})
	}

	// The CLI never calls `registerTelemetry()` on any path today — this is
	// therefore not a probe, it is the honest constant truth of the process
	// that is running. §3.3's falsifiable claim ("every record inside an
	// active span carries traceId/spanId") is what this line resolves the
	// ambiguity for: absence of a trace id reads as "off", stated here,
	// never silently as "dropped".
	log.info(
		'no LoggerProvider/TracerProvider registered; trace_id will be absent from every record this process emits',
		{
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.TELEMETRY_STATUS,
			'namzu.telemetry.registered': false,
			// Session CONTENT export, which is a different question from whether
			// a tracer is registered and is the one an end user cares about: this
			// is the flag that says whether their conversation leaves the machine.
			// Always present, so "off" is a stated fact rather than the absence
			// of a claim.
			//
			// The BOOLEAN only. The disclosure sentence is emitted by `exec` at the
			// moment export is actually attached, under this same event name,
			// because that sentence describes what was BUILT — the destination
			// that resolved, the redactors that loaded — and this function is
			// synchronous by design: `doctor` and `login` call it before anything
			// async has happened, and neither of them attaches an export at all.
			'namzu.telemetry.session_export': config.telemetry?.sessionExport !== undefined,
		},
	)
}
