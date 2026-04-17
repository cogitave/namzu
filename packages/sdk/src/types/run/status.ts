/**
 * Domain Run status enum. See session-hierarchy.md §4.6 + §5.2 state machine.
 *
 * Distinct from the wire-side `RunStatus` in `contracts/api.ts`, which maps
 * these states onto HTTP payload shapes (`completed` / `cancelling` /
 * `expired`). Keep this enum purely the domain surface; any consumer that
 * needs the HTTP representation should translate at the bridge boundary.
 *
 * Variants:
 *  - `queued` — run created, not yet started.
 *  - `running` — iteration loop in flight.
 *  - `awaiting_hitl` — synchronous-wait on a HITL gate (user present).
 *  - `awaiting_hitl_resolution` — persisted-wait after a HITL timeout under
 *    `HITLConfig.onTimeout = 'pause_run_until_resolved'`. User absent; Run
 *    persists until resolved or cancelled (permission-policies.md §13.3).
 *  - `succeeded` — terminal, run completed without error.
 *  - `failed` — terminal, run errored out.
 *  - `cancelled` — terminal, explicitly cancelled.
 */
export type RunStatus =
	| 'queued'
	| 'running'
	| 'awaiting_hitl'
	| 'awaiting_hitl_resolution'
	| 'succeeded'
	| 'failed'
	| 'cancelled'
