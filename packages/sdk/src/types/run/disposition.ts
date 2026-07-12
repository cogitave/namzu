/**
 * Why the iteration loop returned.
 *
 * The loop can end for two structurally different reasons, and until ses_017
 * `query()` could not tell them apart: it inferred "done" from the mere fact
 * that `runLoop()` returned, then unconditionally terminalized the run. A pause
 * only set a `stopReason`, so a run waiting on a human was persisted as
 * **completed**, fired `run_completed`, and resolved a result.
 *
 * `stopReason` cannot carry this. It is a *label on the last thing that
 * happened* — `paused`, `cancelled`, `timeout`, `end_turn` — written by whoever
 * happened to stop the loop, and several of them (`cancelled`, `plan_rejected`)
 * legitimately end a run for good. Deriving "is this run finished?" from it
 * means re-deriving a control-flow fact from a description, and getting a new
 * `StopReason` variant wrong silently un-finishes or double-finishes a run.
 * The disposition is the control-flow fact itself, returned by the loop.
 */
export type RunDisposition =
	/** The run is over — terminalize it, resolve a result, emit a completion event. */
	| 'completed'
	/**
	 * The run is parked awaiting an external decision. It has already been marked
	 * `awaiting_input` by the phase that parked it. Nothing downstream may
	 * terminalize it: no `endedAt`, no result, no `run_completed`.
	 */
	| 'suspended'
