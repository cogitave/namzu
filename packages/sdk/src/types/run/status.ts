/**
 * Domain Run status enum. See session-hierarchy.md §4.6 + §5.2 state machine.
 *
 * Distinct from the wire-side {@link WireRunStatus} in `contracts/api.ts`,
 * which maps these states onto HTTP payload shapes (`completed` /
 * `cancelling` / `expired`). Keep this enum purely the domain surface; any
 * consumer that needs the HTTP representation should translate at the bridge
 * boundary.
 *
 * Variants:
 *  - `queued` — run created, not yet started.
 *  - `running` — iteration loop in flight.
 *  - `awaiting_input` — **the suspension.** The run is blocked on a decision
 *    from outside itself (tool review, plan approval, iteration checkpoint) and
 *    cannot progress until one arrives. Non-terminal: no `endedAt`, no result,
 *    no completion event. Spelled identically in {@link
 *    import('../common/index.js').AgentStatus} (the persisted vocabulary) and
 *    on the wire — one name, one meaning, everywhere.
 *
 *    Replaces the pre-ses_017 `awaiting_hitl` / `awaiting_hitl_resolution`
 *    pair, which were declared here and never set by anything. Two spellings
 *    for one state, neither of them reachable, is how "a paused run is
 *    persisted as FINISHED" survived as a bug: the vocabulary said the state
 *    existed while every code path terminalized it. The `pause_run_until_
 *    resolved` timeout policy that motivated the second variant does not exist
 *    in the runtime; if it lands, it is a property of the pending *decision*
 *    (how long it may sit unanswered), not a second run state.
 *  - `awaiting_subsession` — parent Run has delegated to a child SubSession
 *    and is suspended until the Materializer seals the child's summary.
 *    Session-level fan-in treats this as `active` (delegation in flight
 *    means the parent IS active). See session-hierarchy.md §5.1.
 *  - `succeeded` — terminal, run completed without error.
 *  - `failed` — terminal, run errored out.
 *  - `cancelled` — terminal, explicitly cancelled.
 */
export type RunStatus =
	| 'queued'
	| 'running'
	| 'awaiting_input'
	| 'awaiting_subsession'
	| 'succeeded'
	| 'failed'
	| 'cancelled'
