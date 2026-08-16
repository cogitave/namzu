import type { ToolPresenter } from '../../registry/tool/presentation.js'
import type { AcpSessionUpdate, AcpStopReason } from '../../types/acp/index.js'
import type { RunEvent } from '../../types/run/events.js'
import type { StopReason } from '../../types/run/index.js'

/**
 * Internal run events, in the peer's vocabulary.
 *
 * Mirrors `bridge/sse/mapper.ts`: one pure function over one event,
 * returning `null` for the events this protocol has no word for. Pure so a
 * test can assert the whole mapping without a run, and `null` rather than a
 * thrown error because "this protocol does not carry that" is an ordinary
 * answer — a run emits far more than any one peer surface renders.
 *
 * **No tool name is compared anywhere in this file.** Every tool call is
 * rendered by the presenter the registry built, which asks the TOOL how it
 * wants to be shown. A front end that switched on `'edit'` could never give
 * a diff to a tool it had not heard of — an MCP server's, a plugin's — and
 * that is the defect `createToolPresenter` was extracted to fix once rather
 * than in each host.
 */

/**
 * The kernel's stop reasons, in the peer's.
 *
 * A table rather than a pass-through, because the two vocabularies are not
 * the same set and a peer receiving a word its own union does not contain
 * cannot render it. Anything unmapped becomes `error` rather than being
 * forwarded: an unrecognised terminal state is a state this bridge does not
 * understand, and saying so is more useful than inventing a word for it.
 */
const STOP_REASONS: Readonly<Record<string, AcpStopReason>> = {
	end_turn: 'end_turn',
	stop_condition: 'end_turn',
	max_iterations: 'max_turns',
	max_tokens: 'max_turns',
	cancelled: 'cancelled',
	canceled: 'cancelled',
	aborted: 'cancelled',
	paused: 'cancelled',
	guardrail_blocked: 'refused',
	plan_rejected: 'refused',
	answer_rejected: 'refused',
	error: 'error',
	provider_error: 'error',
}

export function toAcpStopReason(reason: StopReason | string | undefined): AcpStopReason {
	if (reason === undefined) return 'end_turn'
	return STOP_REASONS[reason] ?? 'error'
}

/**
 * One run event as a session update, or `null`.
 *
 * Takes the presenter rather than reaching for a registry, so this stays
 * pure and so a caller with a narrowed registry gets that narrowing.
 */
export function toAcpSessionUpdate(
	event: RunEvent,
	presenter: ToolPresenter,
): AcpSessionUpdate | null {
	switch (event.type) {
		case 'text_delta':
			return { kind: 'agent_message_chunk', text: event.text }

		case 'reasoning_delta':
			return { kind: 'agent_thought_chunk', text: event.text }

		case 'tool_executing':
			return {
				kind: 'tool_call',
				toolCallId: event.toolUseId,
				title: event.toolName,
				status: 'pending',
				view: presenter.presentCall(event.toolName, event.input),
			}

		case 'tool_completed':
			return {
				kind: 'tool_call',
				toolCallId: event.toolUseId,
				title: event.toolName,
				// `isError`, the field the event actually carries. The INPUT is
				// not on this event — only the result is — so the presenter is
				// asked with `undefined`, and a tool whose `presentResult` needs
				// its input falls back to the generic view rather than being
				// handed a guess at what it was called with.
				status: event.isError === true ? 'failed' : 'completed',
				view: presenter.presentResult(event.toolName, undefined, {
					success: event.isError !== true,
					output: typeof event.result === 'string' ? event.result : String(event.result ?? ''),
				}),
			}

		case 'run_completed':
			return { kind: 'turn_ended', stopReason: toAcpStopReason(event.stopReason) }

		case 'run_failed':
			return { kind: 'turn_ended', stopReason: 'error' }

		default:
			// Everything else: iteration boundaries, token accounting, plan and
			// activity events, compaction. Real events with no word in this
			// protocol, and forwarding them as a generic blob would put text on a
			// client's screen that nothing there knows how to lay out.
			return null
	}
}
