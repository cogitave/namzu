import type { AuthorizationGate } from '../../../../authorization/index.js'
import type {
	HITLResumeDecision,
	ToolCallDeclined,
	ToolCallSummary,
} from '../../../../types/hitl/index.js'
import type { ToolCall } from '../../../../types/message/index.js'
import { DECLINED_TOOL_CALL_FEEDBACK } from '../../declined.js'
import type { CallAdmission, ReviewedExecution } from '../../executor.js'
import { DECLINED_NOTE_MAX_CHARS } from '../../executor.js'
import { supersededByRecovery } from '../../resume-pending.js'
import { type IterationContext, awaitDecisionDurably } from './context.js'

/** What a call is told when a refusal elsewhere in its batch ended the turn before it started. */
export const REFUSED_WITH_THE_TURN =
	'An earlier call in this batch was refused and the turn was stopped, so this call was not run. Wait for the user.'

/** What a call is told when the answer to it could not be taken. */
export const UNANSWERED_CALL =
	'No answer was given for this call, so it was not run. Ask again if it is still needed.'

const EDIT_NOT_OFFERED =
	'Editing a call while it is asked about is not offered, so this call was not run. Ask again with the input you want.'

const PAUSED_CALL =
	'The turn was asked to wait before this call could be answered, so it was not run. Ask again if it is still needed.'

const NOT_THIS_QUESTION =
	'That answer was not an answer to a question about a tool call, so this call was not run.'

/** The audit trail keeps a person's reason, cut short and without control characters. */
const AUDIT_NOTE_MAX_CHARS = 500

/**
 * A person's words, made safe to print: control characters (an escape
 * sequence among them) become spaces, line breaks and tabs stay, and the
 * length is capped by code point.
 */
export function cleanPersonNote(note: string | undefined): string {
	if (note === undefined) return ''
	let out = ''
	let inGap = false
	for (const ch of note) {
		const code = ch.codePointAt(0) as number
		const control = code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)
		if (control) {
			if (!inGap) out += ' '
			inGap = true
			continue
		}
		inGap = false
		out += ch
	}
	return Array.from(out.trim()).slice(0, DECLINED_NOTE_MAX_CHARS).join('')
}

interface Refusal {
	readonly run: false
	readonly reason: string
	readonly declined?: ToolCallDeclined
}

type Verdict = { readonly run: true } | Refusal

/** What a decision about some calls means for each of them. */
interface Interpreted {
	readonly verdicts: Map<string, Verdict>
	/** The calls were refused and the refusal ends the turn. */
	readonly endsTurn: boolean
	/** The decision was the host stopping the turn outright. */
	readonly cancelled: boolean
	/** The decision was a request to wait: the park it recorded must not stay open. */
	readonly paused: boolean
}

interface OpenAsk {
	readonly calls: readonly ToolCallSummary[]
	readonly controller: AbortController
	/** A question about one call can be closed by a re-check; a question about several cannot. */
	readonly recheckable: boolean
	/** Why the question was closed from here, when it was. */
	closedBy?: 'covered' | 'ended'
}

/** What the walk needs from the review phase; keeps this file free of that file's closures. */
export interface PerCallReviewDeps {
	readonly ctx: IterationContext & {
		readonly verificationGate?: AuthorizationGate
	}
	readonly iteration: number
	readonly toolCalls: readonly ToolCall[]
	readonly summaries: () => readonly ToolCallSummary[]
	/** Ids the review may not release: the operator's policy denied them. */
	readonly gateDenied: ReadonlyMap<string, string>
	readonly reviewAllowed: () => boolean
	/**
	 * Calls that carry no summary because their preparation failed: they run
	 * nothing, the executor answers them with the reason, so they need no yes.
	 */
	readonly unreviewedIds: ReadonlySet<string>
	/** The shared checks that follow an approval or a refusal; see `runToolReview`. */
	readonly settleEscalations: (
		denials: Map<string, string>,
		confirmed: readonly string[] | undefined,
		calls: readonly ToolCallSummary[],
	) => Promise<void>
	readonly recordGrantAudits: (
		decision: HITLResumeDecision,
		calls: readonly ToolCallSummary[],
	) => Promise<void>
	readonly evaluateGate: (call: ToolCallSummary) => 'allow' | 'deny' | 'review' | undefined
}

/**
 * The per-call review of one batch: it answers the executor's question "may this
 * call start" by asking about that call alone, and keeps every question that is
 * open at once consistent with the others.
 *
 * - An answer that grants something (a remembered approval, a changed rule or
 *   mode on the host's side) re-checks the questions still open, and any call
 *   the new state covers is let through unasked. A re-check never refuses.
 * - A plain refusal ends the turn: the questions still open close, calls not
 *   yet started are refused without being asked, calls in flight are cancelled.
 * - Every refusal and every call that could not be matched to a reviewed
 *   summary is a refusal. Nothing is approved by the absence of an answer.
 */
export class PerCallReview implements ReviewedExecution {
	readonly #deps: PerCallReviewDeps
	readonly #endController = new AbortController()
	readonly #open = new Set<OpenAsk>()
	readonly #approvedTogether = new Set<string>()
	/** Refusals settled before the walk, from the question asked of several calls at once. */
	readonly denials = new Map<string, string>()
	readonly declines = new Map<string, ToolCallDeclined>()
	#endsTurn = false
	#cancelled = false
	#refused = 0
	#checking: Promise<void> | undefined
	#checkAgain = false
	#unsubscribe: (() => void) | undefined

	constructor(deps: PerCallReviewDeps) {
		this.#deps = deps
		this.#unsubscribe = deps.ctx.perCallReview?.onRulesChanged?.(() => {
			void this.recheck()
		})
	}

	get ended(): AbortSignal {
		return this.#endController.signal
	}

	/** A refusal (or the host) ended the turn. */
	get endsTurn(): boolean {
		return this.#endsTurn
	}

	/** How many calls the walk refused, asked or not. */
	get refusedCount(): number {
		return this.#refused
	}

	/** The host stopped the turn rather than a person refusing a call. */
	get cancelled(): boolean {
		return this.#cancelled
	}

	/** Stop listening for changes. Called when the walk is over, whichever way it ended. */
	dispose(): void {
		this.#unsubscribe?.()
		this.#unsubscribe = undefined
	}

	/**
	 * The questions that are about the batch rather than about one call, asked
	 * first and together. Their answers are settled here, before anything starts.
	 */
	async askTogetherFirst(): Promise<void> {
		const config = this.#deps.ctx.perCallReview
		if (!config?.askTogether) return
		const askable = this.#deps
			.summaries()
			.filter((call) => !this.#deps.gateDenied.has(call.id) && !this.#skipsAsk(call))
		if (askable.length === 0) return
		const wanted = new Set(config.askTogether(askable))
		const together = askable.filter((call) => wanted.has(call.id))
		if (together.length === 0) return
		const interpreted = await this.#ask(together)
		for (const call of together) {
			const verdict = interpreted.verdicts.get(call.id) ?? {
				run: false,
				reason: UNANSWERED_CALL,
			}
			if (verdict.run) {
				this.#approvedTogether.add(call.id)
			} else {
				this.denials.set(call.id, verdict.reason)
				if (verdict.declined) this.declines.set(call.id, verdict.declined)
			}
		}
		this.#noteEnd(interpreted)
	}

	/** Answers the executor: may this call start. */
	async admit(call: ToolCall): Promise<CallAdmission> {
		const verdict = await this.#decide(call)
		if (!verdict.run) this.#refused += 1
		return verdict
	}

	async #decide(call: ToolCall): Promise<CallAdmission> {
		if (this.ended.aborted) return { run: false, reason: REFUSED_WITH_THE_TURN }
		if (this.#approvedTogether.has(call.id)) return { run: true }
		const summary = this.#deps.summaries().find((candidate) => candidate.id === call.id)
		if (summary === undefined) {
			// A call whose preparation failed runs nothing; the executor answers it
			// with the reason. Any other call that has no summary was never shown,
			// and a call nobody saw is not approved.
			return this.#deps.unreviewedIds.has(call.id)
				? { run: true }
				: { run: false, reason: UNANSWERED_CALL }
		}
		if (this.#skipsAsk(summary)) return { run: true }
		const interpreted = await this.#ask([summary])
		this.#noteEnd(interpreted)
		const verdict = interpreted.verdicts.get(summary.id) ?? {
			run: false,
			reason: UNANSWERED_CALL,
		}
		if (!verdict.run) {
			this.#deps.ctx.log.info('A tool call was refused', {
				'namzu.tool.names': [summary.name],
			})
			return verdict
		}
		return { run: true }
	}

	/**
	 * Re-check every question still open against the rules and approvals as they
	 * are now. Only ever approves.
	 */
	recheck(): Promise<void> {
		if (this.#checking) {
			this.#checkAgain = true
			return this.#checking
		}
		this.#checking = (async () => {
			try {
				do {
					this.#checkAgain = false
					for (const ask of [...this.#open]) {
						if (!ask.recheckable || ask.closedBy !== undefined || this.ended.aborted) continue
						if (await this.#coveredNow(ask.calls[0] as ToolCallSummary)) {
							// The person may have answered while this was being worked out.
							if (!this.#open.has(ask) || ask.closedBy !== undefined) continue
							ask.closedBy = 'covered'
							ask.controller.abort()
						}
					}
				} while (this.#checkAgain)
			} finally {
				this.#checking = undefined
			}
		})()
		return this.#checking
	}

	/** Calls a re-check must never wave through: they exist to put a question to a person. */
	static #alwaysAsked(call: ToolCallSummary): boolean {
		return (
			call.escalation !== undefined ||
			call.requiresApproval === true ||
			call.authorization?.askRule === true ||
			call.authorization?.explicitReview === true ||
			call.hookPermission?.decision === 'ask'
		)
	}

	async #coveredNow(call: ToolCallSummary): Promise<boolean> {
		if (PerCallReview.#alwaysAsked(call) || this.#deps.gateDenied.has(call.id)) return false
		const { ctx } = this.#deps
		if (!this.#deps.reviewAllowed()) {
			if (this.#deps.evaluateGate(call) === 'allow') return true
			if (ctx.toolGrants?.covers(call)) return true
		}
		try {
			return (await ctx.perCallReview?.covers?.(call)) === true
		} catch {
			// A host predicate that fails is not a yes.
			return false
		}
	}

	/** Whether the turn's own rules and earlier approvals let this call run unasked. */
	#skipsAsk(call: ToolCallSummary): boolean {
		if (this.#deps.reviewAllowed()) return false
		if (call.authorization?.decision === 'allow') return true
		return !PerCallReview.#alwaysAsked(call) && this.#deps.ctx.toolGrants?.covers(call) === true
	}

	#noteEnd(interpreted: Interpreted): void {
		if (!interpreted.endsTurn && !interpreted.cancelled) return
		this.#end(interpreted.cancelled)
	}

	#end(cancelled: boolean): void {
		if (this.#endsTurn) return
		this.#endsTurn = true
		this.#cancelled = cancelled
		for (const ask of this.#open) {
			ask.closedBy ??= 'ended'
			ask.controller.abort()
		}
		this.#endController.abort(new Error('the user stopped the turn'))
	}

	/** One request to the handler about `calls`, and what its answer means for each. */
	async #ask(calls: readonly ToolCallSummary[]): Promise<Interpreted> {
		const { ctx, iteration } = this.#deps
		const checkpoint = await ctx.checkpointMgr.create(ctx.recorder, iteration)
		await ctx.emitEvent({
			type: 'tool_review_requested',
			turnId: ctx.recorder.turnId,
			toolCalls: [...calls],
			iteration,
		})
		const asked: OpenAsk = {
			calls,
			controller: new AbortController(),
			recheckable: calls.length === 1,
		}
		this.#open.add(asked)
		let decision: HITLResumeDecision
		try {
			decision = await awaitDecisionDurably(
				ctx,
				checkpoint,
				{
					type: 'tool_review',
					sessionId: ctx.recorder.sessionId,
					turnId: ctx.recorder.turnId,
					checkpointId: checkpoint.id,
					toolCalls: [...calls],
					perCall: true,
				},
				{
					signal: asked.controller.signal,
					closedAs: () =>
						asked.closedBy === 'covered'
							? { action: 'approve_tools' }
							: { action: 'reject_tools', feedback: REFUSED_WITH_THE_TURN },
				},
			)
		} finally {
			this.#open.delete(asked)
		}

		if (asked.closedBy === 'covered') {
			for (const call of calls) {
				await ctx.recorder.recordAudit({
					what: { action: 'tool_call', tool: call.name },
					outcome: 'approved',
					reason:
						'a rule, an earlier approval or the permission mode changed while this call waited and now covers it; it was approved without being shown',
				})
			}
			return this.#settle(
				{ action: 'approve_tools' },
				calls,
				new Map(calls.map((call) => [call.id, { run: true } as Verdict])),
				false,
				false,
				false,
			)
		}
		if (asked.closedBy === 'ended') {
			return {
				verdicts: new Map(
					calls.map((call) => [call.id, { run: false, reason: REFUSED_WITH_THE_TURN } as Verdict]),
				),
				endsTurn: false,
				cancelled: false,
				paused: false,
			}
		}

		const interpreted = this.#interpret(decision, calls)
		await ctx.emitEvent({
			type: 'tool_review_completed',
			turnId: ctx.recorder.turnId,
			decision: decisionLabel(decision, interpreted),
		})
		if (interpreted.paused) {
			await ctx.checkpointMgr
				.unpark(checkpoint.id, supersededByRecovery(decision))
				.catch(() => null)
		}
		return this.#settle(
			decision,
			calls,
			interpreted.verdicts,
			interpreted.endsTurn,
			interpreted.cancelled,
			interpreted.paused,
		)
	}

	/** The checks that follow an answer, then the answer's side effects. */
	async #settle(
		decision: HITLResumeDecision,
		calls: readonly ToolCallSummary[],
		verdicts: Map<string, Verdict>,
		endsTurn: boolean,
		cancelled: boolean,
		paused: boolean,
	): Promise<Interpreted> {
		const { ctx } = this.#deps
		const denials = new Map<string, string>()
		for (const call of calls) {
			const verdict = verdicts.get(call.id)
			if (verdict && !verdict.run) denials.set(call.id, verdict.reason)
		}
		const confirmed =
			decision.action === 'approve_tools' || decision.action === 'modify_tools'
				? decision.confirmedEscalations
				: undefined
		await this.#deps.settleEscalations(denials, confirmed, calls)
		const result = new Map<string, Verdict>()
		for (const call of calls) {
			const prior = verdicts.get(call.id) ?? {
				run: false,
				reason: UNANSWERED_CALL,
			}
			const reason = denials.get(call.id)
			// An escape the answer did not confirm turns a yes into a refusal here.
			result.set(call.id, prior.run && reason !== undefined ? { run: false, reason } : prior)
		}
		const approvedCalls = calls.filter((call) => result.get(call.id)?.run === true)
		if (decision.action === 'approve_tools' && approvedCalls.length > 0) {
			if (decision.remember) ctx.toolGrants?.grant(decision.remember)
			await this.#deps.recordGrantAudits(decision, approvedCalls)
			// What was just remembered may cover a question still open.
			if (decision.remember) void this.recheck()
		}
		for (const call of calls) {
			const verdict = result.get(call.id)
			if (verdict && !verdict.run && verdict.declined) {
				const note = cleanPersonNote(verdict.declined.note)
				await ctx.recorder.recordAudit({
					what: { action: 'tool_call', tool: call.name },
					outcome: 'refused',
					reason: `declined by the person${
						note ? `: ${Array.from(note).slice(0, AUDIT_NOTE_MAX_CHARS).join('')}` : ''
					}`,
				})
			}
		}
		return { verdicts: result, endsTurn, cancelled, paused }
	}

	#interpret(decision: HITLResumeDecision, calls: readonly ToolCallSummary[]): Interpreted {
		const verdicts = new Map<string, Verdict>()
		const refuseAll = (verdict: Refusal) => {
			for (const call of calls) verdicts.set(call.id, verdict)
		}
		let endsTurn = false
		let cancelled = false
		let paused = false
		switch (decision.action) {
			case 'approve_tools':
			case 'continue':
				for (const call of calls) verdicts.set(call.id, { run: true })
				break
			case 'reject_tools': {
				const note = cleanPersonNote(decision.declined?.note)
				refuseAll({
					run: false,
					reason: decision.feedback
						? Array.from(decision.feedback)
								.slice(0, DECLINED_NOTE_MAX_CHARS * 2)
								.join('')
						: DECLINED_TOOL_CALL_FEEDBACK,
					...(decision.declined ? { declined: note ? { note } : {} } : {}),
				})
				endsTurn = decision.endTurn === true
				break
			}
			case 'modify_tools': {
				for (const call of calls) {
					const mods = decision.modifications.filter((mod) => mod.toolCallId === call.id)
					if (mods.some((mod) => mod.action === 'deny')) {
						verdicts.set(call.id, {
							run: false,
							reason: DECLINED_TOOL_CALL_FEEDBACK,
							declined: {},
						})
					} else if (mods.some((mod) => mod.action === 'modify')) {
						verdicts.set(call.id, { run: false, reason: EDIT_NOT_OFFERED })
					} else if (mods.some((mod) => mod.action === 'approve')) {
						verdicts.set(call.id, { run: true })
					} else {
						verdicts.set(call.id, { run: false, reason: UNANSWERED_CALL })
					}
				}
				break
			}
			case 'pause':
				refuseAll({ run: false, reason: PAUSED_CALL })
				paused = true
				break
			case 'abort':
				refuseAll({ run: false, reason: REFUSED_WITH_THE_TURN })
				cancelled = true
				break
			default:
				// A plan or question answer to a tool question: not an answer to it.
				this.#deps.ctx.log.warn('Unexpected decision during a per-call tool review', {
					'namzu.runtime.action': decision.action,
				})
				refuseAll({ run: false, reason: NOT_THIS_QUESTION })
		}
		return { verdicts, endsTurn, cancelled, paused }
	}
}

function decisionLabel(
	decision: HITLResumeDecision,
	interpreted: Interpreted,
): 'approved' | 'modified' | 'rejected' {
	if (decision.action === 'modify_tools') return 'modified'
	const refused = [...interpreted.verdicts.values()].some((verdict) => !verdict.run)
	return refused ? 'rejected' : 'approved'
}
