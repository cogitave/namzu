import { timingSafeEqual } from 'node:crypto'
import type {
	HITLDecisionRequest,
	PendingDecision,
	ToolExecutionJournalEntry,
} from '../../../types/hitl/index.js'
import type { ResumeToken } from '../../../types/ids/index.js'
import { generateResumeToken } from '../../../utils/id.js'

/**
 * Does a live decision own this tool-call block?
 *
 * **The single predicate the whole durable pause rests on.** `repairDanglingMessages`
 * is RIGHT for a crash — it heals an interrupted assistant/tool pair into a
 * provider-valid history — and CATASTROPHIC for a pause, where it rewrites the very
 * call a human was asked to approve into a "tool result missing" placeholder and tells
 * the model the tool failed. The record could not tell the two cases apart because the
 * pending decision was not persisted. Now it can, and this is where it is asked.
 *
 * Two conditions, and both are load-bearing:
 *
 *   - **Only a `tool_review` decision owns a block.** A plan approval and an iteration
 *     checkpoint have no unanswered calls to protect; suppressing the repair for them
 *     would leave a genuinely-interrupted pair unhealed and hand a provider an invalid
 *     history.
 *   - **Only while the decision is still live.** Once it is `settled` or `cancelled` it
 *     has let go of the block. A checkpoint resumed from that far back is a *fork*, in
 *     whose timeline the tools genuinely did not run — so repairing it is once again
 *     the correct thing to do, and skipping the repair there would hand a provider an
 *     assistant tool-call block with no results at all.
 */
export function decisionOwnsToolBlock(decision: PendingDecision | undefined): boolean {
	if (!decision) return false
	if (decision.request.type !== 'tool_review') return false
	return (
		decision.state === 'pending' || decision.state === 'resolved' || decision.state === 'executing'
	)
}

/** Mint the record a review persists when it parks the run. */
export function buildPendingDecision(request: HITLDecisionRequest): PendingDecision {
	const now = Date.now()
	return {
		requestId: request.requestId,
		request,
		state: 'pending',
		resumeToken: generateResumeToken(),
		createdAt: now,
		updatedAt: now,
	}
}

/**
 * Constant-time token comparison.
 *
 * `a === b` on strings short-circuits at the first differing byte, which leaks the
 * length of a correct prefix to anyone who can measure the refusal. The token is a
 * bearer capability guarding a resumable run; it gets the same treatment a password
 * hash would. Lengths are compared first (and `timingSafeEqual` requires equal lengths
 * anyway) — that leaks only the length, which is a constant of the format.
 */
export function resumeTokenMatches(expected: ResumeToken, presented: string): boolean {
	const a = Buffer.from(expected, 'utf8')
	const b = Buffer.from(presented, 'utf8')
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}

/** Journal entries marking every call in a batch as dispatched, written before dispatch. */
export function journalStarted(
	calls: ReadonlyArray<{ id: string; function: { name: string } }>,
): ToolExecutionJournalEntry[] {
	const at = Date.now()
	return calls.map((call) => ({
		toolCallId: call.id,
		toolName: call.function.name,
		state: 'started' as const,
		at,
	}))
}

/**
 * Fold one call's settlement into the journal, replacing its `started` entry.
 *
 * Replaces rather than appends so the journal stays one entry per call and a reader
 * never has to reconcile two rows to learn one call's fate.
 */
export function journalSettled(
	journal: ToolExecutionJournalEntry[] | undefined,
	settled: { toolCallId: string; toolName: string; output: string },
): ToolExecutionJournalEntry[] {
	const entry: ToolExecutionJournalEntry = {
		toolCallId: settled.toolCallId,
		toolName: settled.toolName,
		state: 'settled',
		at: Date.now(),
		output: settled.output,
	}
	const rest = (journal ?? []).filter((e) => e.toolCallId !== settled.toolCallId)
	return [...rest, entry]
}

/**
 * What a crash in `executing` left behind, per call.
 *
 * `settled` calls keep their recorded output and are NOT re-executed. Everything else —
 * a call the journal recorded as `started` and never settled, and (defensively) a call
 * the journal never mentions at all — is `uncertain`: it may or may not have had its
 * real-world effect, and there is no way to find out from here. It is NOT re-executed
 * and it is NOT guessed at; it is surfaced.
 *
 * A call missing from the journal entirely should be impossible — the whole batch's
 * `started` entries are written in one atomic write before dispatch, so if that write
 * did not land the state would still read `resolved`, not `executing`. Treating the
 * impossible case as uncertain rather than as safe-to-run is the fail-closed reading: a
 * journal that disagrees with the state machine is a journal we cannot trust to tell us
 * that nothing ran.
 */
export interface CrashRecovery {
	settled: Map<string, ToolExecutionJournalEntry>
	uncertain: string[]
}

export function recoverFromJournal(
	calls: ReadonlyArray<{ id: string }>,
	journal: ToolExecutionJournalEntry[] | undefined,
): CrashRecovery {
	const byId = new Map((journal ?? []).map((e) => [e.toolCallId, e]))
	const settled = new Map<string, ToolExecutionJournalEntry>()
	const uncertain: string[] = []

	for (const call of calls) {
		const entry = byId.get(call.id)
		if (entry?.state === 'settled' && entry.output !== undefined) {
			settled.set(call.id, entry)
		} else {
			uncertain.push(call.id)
		}
	}

	return { settled, uncertain }
}

/**
 * What the model is told about a call that may or may not have run. Deliberately says
 * the tool was NOT re-executed and that the effect is unknown, rather than reporting a
 * failure — a call that already charged a customer's card did not fail, and telling the
 * model it did is how it gets charged twice.
 */
export function uncertainToolResult(toolName: string): string {
	return `[SYSTEM] Tool "${toolName}" was dispatched but the process stopped before its result was recorded. It MAY have already run and had its full effect. It was NOT re-executed. Do not retry it blindly — verify its effect first, or ask the user.`
}
