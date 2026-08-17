/**
 * ID-prefix migration window — read-side compat for the pre-0.2.0 top-level
 * `thd_*` container id (D2 meaning (a), ses_020). NZ-TOPIC-04 narrowed the
 * Topic layer's own id (D2 meaning (b)) to `top_*`, so as of this release
 * `thd_*` means ONLY the legacy container everywhere in this codebase — see
 * `types/ids/index.ts` for where the two meanings used to collide.
 *
 * Consumers that touch raw legacy container IDs (the filesystem migrator,
 * wire decoders, CLI imports) route through {@link acceptLegacyContainerId}
 * so the warning signal is structured rather than ad-hoc console output
 * (Convention #18).
 *
 * | Window state | Reader accepts      | Writer emits | Legacy read behaviour         |
 * |--------------|---------------------|--------------|-------------------------------|
 * | OPEN (now)   | `thd_*` AND `prj_*` | `prj_*` only | emits `MigrationWarning` once |
 * | CLOSED       | `prj_*` only        | `prj_*` only | rejects `StalePrefixError`    |
 *
 * The {@link WINDOW_OPEN} constant is the module-level default for
 * {@link acceptLegacyContainerId}'s `windowOpen` parameter — the single
 * knob that flips this module from soft-accept to hard-reject in
 * production. The writer guard {@link rejectLegacyContainerPrefix} has no
 * such fork: a writer must never emit `thd_*` in EITHER window state (see
 * the table's Writer column, unchanged across both rows), so it takes no
 * `windowOpen` parameter at all — one would be unused, which is its own
 * failure mode (a-check-that-cannot-fail, applied to an argument no less
 * than to a branch). Convention #0: no silent long-lived compat — the
 * window is explicit and fails closed when closed.
 */

import type { ProjectId } from '../../types/session/ids.js'
import { asProjectId } from '../../utils/id.js'

/**
 * Structured event emitted when the reader accepts a legacy `thd_*` ID.
 *
 * Shape is stable across the 0.2.x window — platform consumers can wire
 * this into their observability pipeline (metrics, audit log) without
 * string parsing (Convention #18).
 */
export interface MigrationWarning {
	kind: 'id_prefix_legacy_read'
	legacyId: string
	normalizedId: ProjectId
	at: Date
	emittedOncePerProcess: true
}

/** Sink contract — one `emit` method so callers can swap implementations. */
export interface MigrationWarningSink {
	emit(warning: MigrationWarning): void
}

/**
 * Default sink used when consumers do not inject one. Drops warnings on the
 * floor — migration still runs; observers just lose the signal. Convention
 * #5 deny-by-default applies to behaviour, not telemetry; missing a warning
 * sink is not a failure mode.
 */
export const NOOP_MIGRATION_WARNING_SINK: MigrationWarningSink = {
	emit() {},
}

/**
 * Raised when the reader encounters a string that is neither a valid
 * `prj_*` nor `thd_*` prefix. In the 0.3.x window the legacy branch will
 * also throw this error — flip {@link WINDOW_OPEN} to `false` to cut over.
 */
export class StalePrefixError extends Error {
	readonly details: { rawId: string; kind: 'thd_rejected' | 'unknown_prefix' }

	constructor(details: { rawId: string; kind: 'thd_rejected' | 'unknown_prefix' }) {
		const reason =
			details.kind === 'thd_rejected'
				? `Stale legacy container id prefix '${details.rawId.slice(0, 4)}…' — run 'namzu sdk migrate-ids' before 0.3.0`
				: `Unknown ID prefix '${details.rawId.slice(0, 4)}…' — expected 'prj_' or 'thd_'`
		super(reason)
		this.name = 'StalePrefixError'
		this.details = details
	}
}

/**
 * 0.2.x: compat window OPEN — `thd_*` coerces to `prj_*` with a warning.
 * 0.3.x: flip to `false` — legacy branch becomes throw-only.
 */
export const WINDOW_OPEN = true

/**
 * Process-lifetime dedup map. Keyed by raw legacy ID so each distinct legacy
 * string emits exactly one warning — spamming observability on a hot loop
 * of reads is the anti-goal.
 */
const seenLegacy = new Set<string>()

/**
 * Accept-on-read for legacy container `thd_*` IDs during the 0.2.x window.
 *
 * Contract:
 *  - `prj_*` inputs return as-is; no warning emitted.
 *  - `thd_*` inputs normalize to `prj_<suffix>` and emit a single
 *    {@link MigrationWarning} per distinct input string per process.
 *  - Everything else (including a live `top_*` Topic id — NZ-TOPIC-04)
 *    throws {@link StalePrefixError} with `kind: 'unknown_prefix'}`.
 *  - `windowOpen` (default {@link WINDOW_OPEN}) is an explicit parameter
 *    rather than a read of the module constant so the CLOSED branch below
 *    is reachable from a test without mutating shared module state
 *    (a-check-that-cannot-fail). When `false`, the `thd_*` branch throws
 *    too — single knob, single commit, now also a single argument a test
 *    can flip per-call.
 *
 * Testing hook: {@link __resetSeenLegacyForTests} clears the dedup Set so
 * each test starts with a clean emission history.
 */
export function acceptLegacyContainerId(
	raw: string,
	sink: MigrationWarningSink,
	windowOpen: boolean = WINDOW_OPEN,
): ProjectId {
	if (raw.startsWith('prj_')) {
		return raw as ProjectId
	}
	if (raw.startsWith('thd_')) {
		if (!windowOpen) {
			throw new StalePrefixError({ rawId: raw, kind: 'thd_rejected' })
		}
		const normalized = asProjectId(`prj_${raw.slice('thd_'.length)}`)
		if (!seenLegacy.has(raw)) {
			seenLegacy.add(raw)
			sink.emit({
				kind: 'id_prefix_legacy_read',
				legacyId: raw,
				normalizedId: normalized,
				at: new Date(),
				emittedOncePerProcess: true,
			})
		}
		return normalized
	}
	throw new StalePrefixError({ rawId: raw, kind: 'unknown_prefix' })
}

/**
 * Writer guard: reject emission of a legacy container `thd_*` id at encode
 * time. Phase 1's {@link generateProjectId} already emits `prj_*` only;
 * this helper exists so write paths that handle raw strings (e.g.
 * synthesis during filesystem migration) can fail fast on accidental
 * legacy re-emission. No `windowOpen` parameter — unlike the reader above,
 * this guard's outcome does not fork on migration-window state; a writer
 * must never emit `thd_*` in either window (see the module header's
 * Writer column). Convention #0: no silent back-sliding to the old prefix.
 */
export function rejectLegacyContainerPrefix(id: string): void {
	if (id.startsWith('thd_')) {
		throw new StalePrefixError({ rawId: id, kind: 'thd_rejected' })
	}
}

/**
 * Test-only: clear the process-level dedup Set so subsequent
 * {@link acceptLegacyContainerId} calls emit warnings again. Production code
 * must never call this — the whole point is one warning per distinct
 * legacy id per process.
 */
export function __resetSeenLegacyForTests(): void {
	seenLegacy.clear()
}
