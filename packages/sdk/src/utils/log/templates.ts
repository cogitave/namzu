import { BOOT_EVENT_NAMES, type BootEventName } from '../../constants/telemetry/index.js'
import type { LogRecord } from './types.js'

/**
 * How a boot record is turned into one readable line.
 *
 * The complaint this exists to answer is that the logs say nothing when the
 * project starts. A record already carries everything — the problem is the
 * shape it arrives in: an absolute ISO timestamp nobody can subtract in
 * their head, and every attribute dumped as JSON, so the two facts that
 * matter sit inside forty that do not.
 *
 * Two things fix most of it, and neither is a freebie of a generic sink.
 * The `+Nms` column turns a wall of timestamps into a readout of which
 * phase was slow. And a template per event decides which attributes are
 * worth a line at `info`, instead of printing all of them.
 *
 * **Display only.** Nothing here may mutate a record, and no machine-read
 * path sees any of it — `jsonLinesSink` renders the same records
 * byte-identically whether or not this file is loaded.
 */

/**
 * A template returns the text after the marker, or `undefined` to fall
 * through to the default rendering.
 *
 * It receives the record rather than just the attributes because several
 * lines are the body with two attributes appended, and re-deriving the body
 * from attributes would let the rendered line disagree with what the
 * emitter actually said.
 */
export type BootTemplate = (record: LogRecord) => string | undefined

function attr(record: LogRecord, key: string): string | undefined {
	const value = record.attributes[key]
	if (value === undefined || value === null) return undefined
	return typeof value === 'string' ? value : JSON.stringify(value)
}

/** `a · b · c`, skipping anything absent, or `undefined` if all are. */
function joined(parts: (string | undefined)[]): string | undefined {
	const kept = parts.filter((p): p is string => p !== undefined && p !== '')
	return kept.length > 0 ? kept.join(' · ') : undefined
}

/** The body, with a `key=value` tail for the named attributes that exist. */
function bodyWith(record: LogRecord, keys: string[]): string {
	const tail = keys
		.map((key) => {
			const value = attr(record, key)
			return value === undefined ? undefined : `${shortKey(key)}=${value}`
		})
		.filter((p): p is string => p !== undefined)
	return tail.length > 0 ? `${record.body}  ${tail.join(' ')}` : record.body
}

/** `namzu.config.key.count` reads as `count` in a column already labelled `config`. */
function shortKey(key: string): string {
	const parts = key.split('.')
	return parts[parts.length - 1] ?? key
}

/**
 * One template per boot event, as a TOTAL map over the union.
 *
 * `Record<BootEventName, …>` rather than `Partial<…>` on purpose: adding a
 * member to `BOOT_EVENT_NAMES` then fails to compile here until somebody
 * decides how it should read. A partial map would let a new event silently
 * fall through to the default dump, which is the exact outcome this file
 * exists to prevent — and nothing would fail.
 */
export const BOOT_TEMPLATES: Record<BootEventName, BootTemplate> = {
	[BOOT_EVENT_NAMES.BOOT_START]: (r) => bodyWith(r, ['namzu.boot.cwd', 'namzu.boot.argv']),
	[BOOT_EVENT_NAMES.CONFIG_RESOLVED]: (r) =>
		joined([r.body, attr(r, 'namzu.config.key.count'), attr(r, 'namzu.config.sources')]),
	[BOOT_EVENT_NAMES.SANDBOX_RESOLVED]: (r) =>
		bodyWith(r, ['namzu.sandbox.backend', 'namzu.sandbox.enforces']),
	[BOOT_EVENT_NAMES.PROVIDER_RESOLVED]: (r) =>
		bodyWith(r, ['namzu.provider.chain', 'namzu.provider.constructed']),
	[BOOT_EVENT_NAMES.CAPABILITY_DETECTED]: (r) => bodyWith(r, ['namzu.capability.name']),
	[BOOT_EVENT_NAMES.CAPABILITY_BROKEN]: (r) =>
		bodyWith(r, ['namzu.capability.name', 'namzu.capability.reason']),
	[BOOT_EVENT_NAMES.TELEMETRY_STATUS]: (r) => r.body,
	[BOOT_EVENT_NAMES.MIGRATION_COMPLETED]: (r) => bodyWith(r, ['namzu.migration.root']),
	[BOOT_EVENT_NAMES.DISCOVERY_COMPLETED]: (r) =>
		joined([
			r.body,
			attr(r, 'namzu.discovery.plugins'),
			attr(r, 'namzu.discovery.skills'),
			attr(r, 'namzu.discovery.connectors'),
		]),
	[BOOT_EVENT_NAMES.BOOT_REFUSED]: (r) => bodyWith(r, ['namzu.boot.refusal.reason']),
	[BOOT_EVENT_NAMES.BOOT_READY]: (r) => bodyWith(r, ['namzu.boot.duration.ms']),
}

/**
 * The column label: `namzu.config.resolved` reads as `config`.
 *
 * Derived from the event name rather than `scope.name` because the scope of
 * every one of these is the process that emitted it — `cli` for all eleven —
 * which would make the column a constant and buy nothing. A record with no
 * event name keeps its scope, which is the only thing it has.
 */
export function columnLabel(record: LogRecord): string {
	const name = record.eventName
	if (!name) return record.scope.name
	const parts = name.split('.')
	// `namzu.<area>.<verb>` → `<area>`; anything else keeps its whole name so
	// a foreign vocabulary is not silently truncated into a wrong label.
	if (parts.length === 3 && parts[0] === 'namzu') return parts[1] as string
	return name
}

const BOOT_EVENT_SET: ReadonlySet<string> = new Set(Object.values(BOOT_EVENT_NAMES))

/** The rendered body for a record, or `undefined` to use the default. */
export function applyTemplate(record: LogRecord): string | undefined {
	const name = record.eventName
	if (!name || !BOOT_EVENT_SET.has(name)) return undefined
	return BOOT_TEMPLATES[name as BootEventName](record)
}

// ─── the scope column's colour ───────────────────────────────────────────

/**
 * Eight ANSI foreground colours, pinned here.
 *
 * Not 256-colour and not truecolour: this has to be legible on a default
 * terminal profile, and the bright/dim variants of these eight are the only
 * ones a user's own theme is guaranteed to have already made readable
 * against their background. Black and white are absent because one of the
 * two disappears on any given background.
 */
const PALETTE = [31, 32, 33, 34, 35, 36, 91, 92] as const

/**
 * FNV-1a, written out rather than imported.
 *
 * The requirement is that the same scope gets the same colour in a
 * different process on a different day, so nothing here may touch process
 * state — no `Math.random`, no insertion order, no `Date`. Written out
 * because a dependency could change its algorithm in a patch release and
 * every colour in every terminal would move at once, for a bump nobody
 * reviewed as a display change.
 */
export function scopeColour(scope: string): number {
	let hash = 0x811c9dc5
	for (let i = 0; i < scope.length; i++) {
		hash ^= scope.charCodeAt(i)
		// `Math.imul` keeps this in 32-bit integer space; `hash * 16777619`
		// exceeds 2^53 and starts losing low bits, which is where a hash
		// stops distributing.
		hash = Math.imul(hash, 0x01000193)
	}
	return PALETTE[Math.abs(hash) % PALETTE.length] as number
}
