import type { AuthorizationGate } from '../../../../authorization/index.js'
import type { ToolSourceRef } from '../../../../toolsets/types.js'
import type { ToolCallSummary } from '../../../../types/hitl/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { SessionEvent } from '../../../../types/session/index.js'
import type { ShellDialect } from '../../../../types/tool/index.js'
import { DECLINED_TOOL_CALL_FEEDBACK } from '../../declined.js'
import type { PreparedToolBatch, ToolCallDenials } from '../../executor.js'
import {
	awaitProjectInstructionCallback,
	replaceProjectInstructionSnapshot,
} from '../../project-instructions.js'
import { attachRepeatNotice } from '../../repeat-call.js'
import { attachNotice, attachSteering, formatJobNote } from '../../steering.js'
import { type IterationContext, awaitDecisionDurably } from './context.js'

interface VerificationAwareContext extends IterationContext {
	readonly verificationGate?: AuthorizationGate
}

/** Why an escalated call cannot be waved through by the rule that would otherwise allow it. */
function escalationReason(escalation: ToolCallSummary['escalation']): string {
	if (escalation?.unknownProgram !== undefined) {
		return `this call's program cannot be verified ahead of time (${escalation.unknownProgram})`
	}
	if (escalation?.sandboxEscape) return "this call asks to run outside the turn's sandbox"
	if (escalation?.outsidePaths?.length)
		return `this call reaches ${escalation.outsidePaths.length === 1 ? 'a path' : 'paths'} outside the turn's boundary`
	return "this call reaches past the turn's boundary, which a rule cannot approve on its own"
}

export type ToolReviewDecision = 'executed' | 'rejected' | 'stop'

/**
 * What the review produced. The tool outcomes travel with the decision so
 * the loop can build a `StepResult` without re-deriving them from the
 * messages it just pushed.
 */
export interface ToolReviewOutcome {
	decision: ToolReviewDecision
	results: readonly import('../../executor.js').ToolCallOutcome[]
	/** Wall-clock spent executing tools in this review. */
	durationMs: number
}

/**
 * Run every tool call in `response` through the gate and (when the gate is
 * inconclusive) a human, then hand the whole batch — approved and refused
 * alike — to the executor.
 *
 * Two invariants this function is responsible for:
 *
 * 1. **Every `tool_use` is answered.** No branch may return without the
 *    executor having produced a `tool_result` for each call, because an
 *    unanswered `tool_use` makes the next provider request malformed. The
 *    refusal reason rides inside the `tool_result`, which is also what
 *    lets a rejection steer the model instead of just stopping it.
 * 2. **A gate denial is never overridable by an approval.** A human
 *    approving a batch approves the calls the gate left undecided — not
 *    the ones it refused. Gate denials are threaded into every downstream
 *    execution so no path can widen them.
 */
export async function* runToolReview(
	ctx: VerificationAwareContext,
	response: ChatCompletionResponse,
	iterationNum: number,
): AsyncGenerator<SessionEvent, ToolReviewOutcome> {
	let executed: readonly import('../../executor.js').ToolCallOutcome[] = []
	let toolMs = 0
	// The shell each call's command line will run in, for the rules and the
	// skill grants to read it the same way. A test double without the method
	// leaves it unset, which reads the line for any POSIX shell.
	const dialectFor = (toolName: string): { commandDialect?: ShellDialect } => {
		const executor = ctx.toolExecutor as {
			commandDialect?: (name: string) => ShellDialect
		}
		return typeof executor.commandDialect === 'function'
			? { commandDialect: executor.commandDialect(toolName) }
			: {}
	}

	// `allow_read_only` needs to know whether the tool's own `readOnlyHint`
	// is one the operator trusts (an MCP server they configured that way), so
	// it must not be told "host-defined" for a name the manager does not
	// have. `sourceOf` throws for an unknown name, so this checks first.
	const sourceFor = (toolName: string): { toolSource?: ToolSourceRef } =>
		ctx.tools.has(toolName) ? { toolSource: ctx.tools.sourceOf(toolName) } : {}

	const finish = (decision: ToolReviewDecision): ToolReviewOutcome => ({
		decision,
		results: executed,
		durationMs: toolMs,
	})

	const toolCalls = response.message.toolCalls
	if (!toolCalls || toolCalls.length === 0) {
		return finish('executed')
	}

	const prepareForReview = async (): Promise<PreparedToolBatch | undefined> => {
		const prepare = ctx.toolExecutor.prepareBatchForReview
		return typeof prepare === 'function' ? prepare.call(ctx.toolExecutor, response) : undefined
	}
	let preparedBatch = await prepareForReview()
	const summariesFor = (prepared: PreparedToolBatch | undefined): ToolCallSummary[] => {
		const calls =
			prepared?.reviewCalls ??
			toolCalls.map((tc) => {
				let input: unknown
				try {
					input = JSON.parse(tc.function.arguments)
				} catch {
					input = tc.function.arguments
				}
				return { id: tc.id, name: tc.function.name, input }
			})
		return calls.map((tc) => {
			const tool = ctx.tools.get(tc.name)
			const isDestructive = tool?.isDestructive ? tool.isDestructive(tc.input) : false
			const requiresApproval = tool?.requiresApproval ? tool.requiresApproval(tc.input) : false
			const escalation = 'escalation' in tc ? tc.escalation : undefined

			return {
				id: tc.id,
				name: tc.name,
				input: tc.input,
				isDestructive,
				authorization: { decision: 'review' },
				...(requiresApproval ? { requiresApproval: true as const } : {}),
				...(escalation ? { escalation } : {}),
			}
		})
	}
	let toolCallSummaries = summariesFor(preparedBatch)
	const escalated = (): ToolCallSummary[] =>
		toolCallSummaries.filter((tc) => tc.escalation !== undefined)
	/** A call the tool itself declared always needs a person's approval. */
	const requiresApproval = (): ToolCallSummary[] =>
		toolCallSummaries.filter((tc) => tc.requiresApproval === true)

	/**
	 * A call that has failed identically too many times in a row is answered
	 * with the tracker's refusal instead of being run — the one denial the
	 * tracker makes, on top of whatever the caller already denied.
	 */
	const withRepeatRefusals = (denials?: ToolCallDenials): ToolCallDenials | undefined => {
		const tracker = ctx.repeatCalls
		if (!tracker) return denials
		let merged: Map<string, string> | undefined
		for (const summary of toolCallSummaries) {
			if (denials?.has(summary.id)) continue
			const refusal = tracker.refusal(summary.name, summary.input)
			if (!refusal) continue
			merged ??= new Map(denials ?? [])
			merged.set(summary.id, refusal)
		}
		return merged ?? denials
	}

	/** Executes the batch, answering every call, and appends the results. */
	const settle = async (denials?: ToolCallDenials): Promise<void> => {
		const startedAt = Date.now()
		const batch = await ctx.toolExecutor.executeBatch(
			response,
			withRepeatRefusals(denials),
			undefined,
			preparedBatch,
		)
		toolMs += Date.now() - startedAt
		executed = batch.results
		// Recorded AFTER execution, with the real result: the notice advises
		// on the call that already ran, and the failure count is what the
		// refusal above reads on the NEXT identical call.
		const notices = []
		for (const summary of toolCallSummaries) {
			const outcome = batch.results.find((result) => result.toolCallId === summary.id)
			const notice = ctx.repeatCalls?.record(
				summary.name,
				summary.input,
				outcome ? { failed: outcome.isError === true } : undefined,
			)
			if (notice) notices.push(notice)
		}
		// Guidance the host queued while this batch was running rides out on
		// the last result. This is the only legal slot for it: a `tool_use`
		// block must be answered by a `tool_result` with the same id, so a
		// user message wedged between them is rejected by the provider. Same
		// delivery a denial already uses, without the refusal.
		for (const msg of attachRepeatNotice(
			attachNotice(
				attachSteering(batch.messages, ctx.steering, ctx.onSteeringDelivered),
				ctx.jobNotices,
				formatJobNote,
				// The exits that text accounts for have now been read, so the
				// record of them stops being pending work. Left standing, it
				// buys the model a turn the next time any job queues a notice.
				() => ctx.awaitedJobs?.noticesDelivered(),
			),
			notices,
		)) {
			ctx.recorder.pushMessage(msg)
		}
		// The complete tool-result batch is already in history before host policy
		// may react, so a replacement cannot split provider-required adjacency.
		// Commit each accepted observation before entering the next one. A single
		// batch-end drain loses the accepted prefix when a later observer aborts.
		// Nested registry dispatches are carried in this same ordered list.
		if (ctx.projectInstructionContext) {
			for (const observation of batch.observations) {
				const signal = ctx.abortController.signal
				const snapshot = await awaitProjectInstructionCallback(signal, () =>
					ctx.projectInstructionContext?.observeToolResult(observation, {
						messages: [...ctx.recorder.messages],
						signal,
					}),
				)
				// Callback settlement and snapshot publication are distinct
				// microtasks. Authority may be withdrawn between them.
				signal.throwIfAborted()
				if (snapshot !== undefined) {
					ctx.recorder.replaceMessages(
						replaceProjectInstructionSnapshot(ctx.recorder.messages, snapshot),
					)
				}
			}
		}
	}

	if (toolCallSummaries.length === 0) {
		await settle()
		yield* ctx.drainPending()
		return finish('executed')
	}

	/** Every call denied for the same reason (human rejection, gate stop). */
	const denyAll = (reason: string): ToolCallDenials =>
		new Map(toolCalls.map((tc) => [tc.id, reason]))

	/**
	 * A crossing that was asked about and refused, on the record as a
	 * refusal whoever refused it — a person answering No, a policy with
	 * nobody to ask, a rule. An absent record would read the same as a
	 * crossing nobody asked for.
	 */
	const recordRefusedEscalation = async (tc: ToolCallSummary, reason: string): Promise<void> => {
		if (tc.escalation?.sandboxEscape) {
			await ctx.recorder.recordAudit({
				what: { action: 'sandbox_escape', tool: tc.name },
				outcome: 'refused',
				reason,
			})
		}
		for (const path of tc.escalation?.outsidePaths ?? []) {
			await ctx.recorder.recordAudit({
				what: { action: 'outside_root_access', tool: tc.name, resource: path },
				outcome: 'refused',
				reason,
			})
		}
		if (tc.escalation?.unknownProgram !== undefined) {
			await ctx.recorder.recordAudit({
				what: { action: 'unknown_program', tool: tc.name, resource: tc.escalation.unknownProgram },
				outcome: 'refused',
				reason,
			})
		}
	}

	// Gate-denied ids survive the whole function: a later human approval
	// must not be able to release them.
	const gateDenied = new Map<string, string>()

	// Sampled once, the first time a shortcut asks, so both shortcuts below
	// read the same answer for this batch. A policy stricter than the rules
	// (a read-only mode) sees the batch rather than letting an allowance or a
	// grant run it past the handler.
	let reviewAllowedSample: boolean | undefined
	const reviewAllowed = (): boolean => {
		reviewAllowedSample ??= ctx.reviewAllowedCalls?.() === true
		return reviewAllowedSample
	}

	// The operator's policy runs FIRST, and a grant cannot overrule it.
	//
	// The grant short-circuit used to sit above this block and return, so a
	// remembered approval skipped the gate entirely. The two are different
	// authorities: a grant records that the USER said yes to a shape of
	// call, and the gate encodes what the OPERATOR forbids. A tool-scoped
	// grant matches any arguments, so approving `bash: git status` with
	// `remember: ['bash']` — the scope the docs recommend — then let
	// `bash: rm -rf /` through unevaluated, past a rule written to stop
	// exactly that. The CLI already states the correct rule for its own
	// bypass: the deny applies even when every prompt is skipped.
	if (ctx.verificationGate) {
		const gate = ctx.verificationGate
		const gateResults = toolCallSummaries.map((tc) => ({
			toolCall: tc,
			gateResult: gate.evaluate({
				toolName: tc.name,
				toolInput: tc.input,
				toolDef: ctx.tools.get(tc.name),
				...dialectFor(tc.name),
				...sourceFor(tc.name),
			}),
		}))
		for (const gr of gateResults) {
			// An `allow` rule was written about a tool, not about a path outside
			// the working directory or a command outside the sandbox, which
			// were refused outright when it was written. So an escalated call
			// is a question even where a rule would allow the tool; a `deny`
			// still refuses it, because a deny is never widened.
			if (gr.toolCall.escalation && gr.gateResult.decision === 'allow') {
				gr.gateResult = {
					decision: 'review',
					matchedRule: gr.gateResult.matchedRule,
					reason: `${gr.gateResult.reason}; but ${escalationReason(gr.toolCall.escalation)}`,
				}
			}
			// Same override, for a call the tool itself declared always needs a
			// person's approval: an `allow` rule was written about the tool by
			// name or category, never about this per-call declaration, so it
			// cannot settle the question on its own either. A `deny` still
			// refuses it, because this can only ADD a review, never remove one.
			if (gr.toolCall.requiresApproval && gr.gateResult.decision === 'allow') {
				gr.gateResult = {
					decision: 'review',
					matchedRule: gr.gateResult.matchedRule,
					reason: `${gr.gateResult.reason}; but the tool itself declares this call always needs a person's approval, which a rule cannot waive`,
				}
			}
			const { toolCall, gateResult } = gr
			toolCall.authorization = {
				decision: gateResult.decision,
				...(gateResult.reason ? { reason: gateResult.reason } : {}),
				...(gateResult.decision === 'review' && gateResult.matchedRule
					? { explicitReview: true as const }
					: {}),
			}
		}

		for (const gr of gateResults) {
			if (gr.gateResult.decision === 'deny') {
				const reason = `Blocked by the authorization gate: ${gr.gateResult.reason}`
				gateDenied.set(gr.toolCall.id, reason)
				// A gate denial is a refusal — first-class in the audit trail, never
				// an absent record (LOG-14, design §5). Written here, once per
				// denied call, regardless of which path the rest of this function
				// takes afterwards.
				await ctx.recorder.recordAudit({
					what: { action: 'tool_call', tool: gr.toolCall.name },
					outcome: 'refused',
					reason,
				})
			}
		}

		const allAllowed = gateResults.every((gr) => gr.gateResult.decision === 'allow')
		const allDenied = gateResults.every((gr) => gr.gateResult.decision === 'deny')

		if (allAllowed && !reviewAllowed()) {
			ctx.log.debug('Authorization gate: all tool calls pre-approved', {
				'namzu.tool.names': gateResults.map((gr) => gr.toolCall.name),
			})
			await settle()
			yield* ctx.drainPending()
			return finish('executed')
		}

		if (allDenied) {
			ctx.log.debug('Authorization gate: all tool calls denied', {
				'namzu.tool.names': gateResults.map((gr) => gr.toolCall.name),
			})
			// Every escalated call here was refused by a rule, and a crossing
			// refused by a rule is recorded like one a person refused.
			for (const tc of escalated()) {
				const reason = gateDenied.get(tc.id)
				if (reason !== undefined) await recordRefusedEscalation(tc, reason)
			}
			await settle(gateDenied)
			yield* ctx.drainPending()
			return finish('rejected')
		}

		ctx.log.debug('Authorization gate: mixed decisions, proceeding to review', {
			'namzu.runtime.decisions': gateResults.map((gr) => ({
				tool: gr.toolCall.name,
				decision: gr.gateResult.decision,
			})),
		})
	}

	// A skill's `allowed-tools` pre-approval, marked on the calls it covers
	// and left for the review policy to honour. Marked, never decided here:
	// only the policy knows the mode, and `plan` and `strict` must refuse a
	// call a skill granted exactly as they refuse any other. Nothing stronger
	// may stand in the way — an operator's deny or explicit ask, a
	// destructive call, a path outside the roots or a sandbox escape all
	// leave the call unmarked, so it is reviewed as though no skill had
	// spoken.
	if (ctx.skillGrants && ctx.skillGrants.size > 0) {
		for (const tc of toolCallSummaries) {
			if (gateDenied.has(tc.id)) continue
			if (tc.authorization?.decision === 'deny' || tc.authorization?.explicitReview) continue
			if (tc.isDestructive || tc.escalation !== undefined || tc.requiresApproval) continue
			const skill = ctx.skillGrants.coveringSkill(tc, ctx.tools.get(tc.name), dialectFor(tc.name))
			if (skill !== undefined) tc.skillGrant = { skill }
		}
	}

	// Already approved, at a scope the approver chose — and nothing the
	// operator's policy denied, because `gateDenied` is checked first.
	// Re-asking about a call somebody has already said yes to is how an
	// approval prompt becomes noise, and a noisy prompt gets answered with
	// the widest option available: `bash: git status` re-prompted on every
	// batch forever, and the only escape was a blanket session grant that
	// also covered every destructive call.
	//
	// Except an escalated call: a grant is remembered at the scope of a tool
	// or a command, and neither says anything about a path outside the
	// working directory or a run outside the sandbox.
	if (
		ctx.toolGrants &&
		!reviewAllowed() &&
		gateDenied.size === 0 &&
		escalated().length === 0 &&
		requiresApproval().length === 0 &&
		toolCallSummaries.every((tc) => ctx.toolGrants?.covers(tc))
	) {
		ctx.log.debug('Every tool call is covered by an approval already granted', {
			'namzu.tool.names': toolCallSummaries.map((tc) => tc.name),
		})
		await settle()
		yield* ctx.drainPending()
		return finish('executed')
	}

	const reviewCheckpoint = await ctx.checkpointMgr.create(ctx.recorder, iterationNum)

	await ctx.emitEvent({
		type: 'tool_review_requested',
		turnId: ctx.recorder.turnId,
		toolCalls: toolCallSummaries,
		iteration: iterationNum,
	})
	yield* ctx.drainPending()

	const reviewDecision = await awaitDecisionDurably(ctx, reviewCheckpoint, {
		type: 'tool_review',
		sessionId: ctx.recorder.sessionId,
		turnId: ctx.recorder.turnId,
		checkpointId: reviewCheckpoint.id,
		toolCalls: toolCallSummaries,
	})

	/**
	 * The escalations this decision lets through, on the record, and the
	 * escapes it did not confirm, refused.
	 *
	 * An approval that does not name an escape by id is not consent to it:
	 * `approve_tools` is also what an auto mode, a remembered "approve all"
	 * and a host's blanket handler answer, and none of those showed anybody
	 * the escape. Refusing it here, beside the executor that would honour it,
	 * makes that hold for every policy rather than for the shipped one only.
	 */
	const settleEscalations = async (
		denials: Map<string, string>,
		confirmed: readonly string[] | undefined,
	): Promise<void> => {
		for (const tc of escalated()) {
			const denied = denials.get(tc.id)
			if (denied !== undefined) {
				// A crossing that was asked about and refused is on the record
				// as a refusal, whoever refused it — a person answering No, a
				// policy with nobody to ask, a rule. An absent record would read
				// the same as a crossing nobody asked for.
				await recordRefusedEscalation(tc, denied)
				continue
			}
			if (tc.escalation?.sandboxEscape && !confirmed?.includes(tc.id)) {
				const reason =
					'Refused: running this command outside the sandbox needs a person to confirm it for this call, and this approval did not. Run it inside the sandbox, or ask the user to approve the escape when they can be asked.'
				denials.set(tc.id, reason)
				await ctx.recorder.recordAudit({
					what: { action: 'sandbox_escape', tool: tc.name },
					outcome: 'refused',
					reason,
				})
				continue
			}
			if (tc.escalation?.sandboxEscape) {
				await ctx.recorder.recordAudit({
					what: { action: 'sandbox_escape', tool: tc.name },
					outcome: 'approved',
					reason: 'the reviewer confirmed this call by id',
				})
			}
			for (const path of tc.escalation?.outsidePaths ?? []) {
				await ctx.recorder.recordAudit({
					what: {
						action: 'outside_root_access',
						tool: tc.name,
						resource: path,
					},
					outcome: 'approved',
					reason: "the turn's review approved this call",
				})
			}
			if (tc.escalation?.unknownProgram !== undefined) {
				await ctx.recorder.recordAudit({
					what: {
						action: 'unknown_program',
						tool: tc.name,
						resource: tc.escalation.unknownProgram,
					},
					outcome: 'approved',
					reason: "the turn's review approved this call",
				})
			}
		}
	}

	switch (reviewDecision.action) {
		case 'reject_tools': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				turnId: ctx.recorder.turnId,
				decision: 'rejected',
			})
			yield* ctx.drainPending()

			const feedback = reviewDecision.feedback || DECLINED_TOOL_CALL_FEEDBACK
			const denials = new Map(denyAll(feedback))
			await settleEscalations(denials, undefined)
			await settle(denials)
			yield* ctx.drainPending()
			return finish('rejected')
		}

		case 'modify_tools': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				turnId: ctx.recorder.turnId,
				decision: 'modified',
			})
			yield* ctx.drainPending()

			// Gate denials are the floor; per-call human denials add to them.
			const denials = new Map(gateDenied)
			const modifiedCallIds = new Set<string>()

			for (const mod of reviewDecision.modifications) {
				if (mod.action === 'modify' && mod.modifiedInput !== undefined) {
					const tc = toolCalls.find((t) => t.id === mod.toolCallId)
					// A modification cannot resurrect a gate-denied call.
					if (tc && !denials.has(tc.id)) {
						tc.function.arguments = JSON.stringify(mod.modifiedInput)
						modifiedCallIds.add(tc.id)
					}
				}
				if (mod.action === 'deny' && !denials.has(mod.toolCallId)) {
					denials.set(mod.toolCallId, DECLINED_TOOL_CALL_FEEDBACK)
				}
			}

			// A human modification changes the raw call after the first preparation.
			// Decode it once again, then require policy to explicitly allow the new
			// executable value. A second nested review would be ambiguous: the human
			// edited raw JSON, not an unseen schema transform of it.
			if (modifiedCallIds.size > 0) {
				const reprepare = ctx.toolExecutor.reprepareBatchForReview
				preparedBatch =
					preparedBatch && typeof reprepare === 'function'
						? await reprepare.call(ctx.toolExecutor, response, preparedBatch, modifiedCallIds)
						: await prepareForReview()
				toolCallSummaries = summariesFor(preparedBatch)
			}
			if (ctx.verificationGate && modifiedCallIds.size > 0) {
				for (const summary of toolCallSummaries) {
					if (!modifiedCallIds.has(summary.id)) continue
					if (denials.has(summary.id)) continue
					const gateResult = ctx.verificationGate.evaluate({
						toolName: summary.name,
						toolInput: summary.input,
						toolDef: ctx.tools.get(summary.name),
						...dialectFor(summary.name),
						...sourceFor(summary.name),
					})
					if (gateResult.decision === 'allow') continue
					const reason =
						gateResult.decision === 'deny'
							? `Blocked by the authorization gate after the tool input was modified: ${gateResult.reason}`
							: `Blocked by the authorization gate after the tool input was modified: the prepared value requires a new explicit approval. ${gateResult.reason}`
					denials.set(summary.id, reason)
					await ctx.recorder.recordAudit({
						what: { action: 'tool_call', tool: summary.name },
						outcome: 'refused',
						reason,
					})
				}
			}

			await settleEscalations(denials, reviewDecision.confirmedEscalations)
			const everythingDenied = denials.size === toolCalls.length
			await settle(denials)
			yield* ctx.drainPending()
			return finish(everythingDenied ? 'rejected' : 'executed')
		}

		case 'pause': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				turnId: ctx.recorder.turnId,
				decision: 'rejected',
			})
			await ctx.emitEvent({
				type: 'turn_paused',
				turnId: ctx.recorder.turnId,
				checkpointId: reviewCheckpoint.id,
				reason: reviewDecision.reason,
			})
			yield* ctx.drainPending()
			ctx.recorder.setStopReason('paused')
			return finish('stop')
		}

		case 'abort': {
			await ctx.emitEvent({
				type: 'tool_review_completed',
				turnId: ctx.recorder.turnId,
				decision: 'rejected',
			})
			yield* ctx.drainPending()
			ctx.recorder.setStopReason('cancelled')
			ctx.recorder.markCancelled()
			return finish('stop')
		}

		case 'approve_tools':
		case 'continue': {
			// Recorded only on an EXPLICIT approval that asked for it. A
			// denial, a non-response, or an approval that said nothing about
			// scope leaves nothing behind — consent stays untransferable
			// unless the approver chose to transfer it.
			if (reviewDecision.action === 'approve_tools' && reviewDecision.remember) {
				ctx.toolGrants?.grant(reviewDecision.remember)
			}
			// A call nobody was asked about, approved because a skill said so,
			// is on the record naming that skill. Only a call that carried the
			// mark counts: a policy that lists an unmarked id has not been
			// given a skill's word for it.
			if (reviewDecision.action === 'approve_tools' && reviewDecision.skillGranted) {
				const listed = new Set(reviewDecision.skillGranted)
				for (const tc of toolCallSummaries) {
					if (!listed.has(tc.id) || !tc.skillGrant || gateDenied.has(tc.id)) continue
					await ctx.recorder.recordAudit({
						what: { action: 'tool_call', tool: tc.name },
						outcome: 'approved',
						reason: `pre-approved by the allowed-tools of skill "${tc.skillGrant.skill}" for this turn; nobody was asked`,
					})
				}
			}

			await ctx.emitEvent({
				type: 'tool_review_completed',
				turnId: ctx.recorder.turnId,
				decision: 'approved',
			})
			yield* ctx.drainPending()

			// `gateDenied` is non-empty only on the gate's mixed-decision
			// path. Passing it here is what stops a human "approve" from
			// executing calls the gate refused.
			const denials = new Map(gateDenied)
			await settleEscalations(
				denials,
				reviewDecision.action === 'approve_tools' ? reviewDecision.confirmedEscalations : undefined,
			)
			await settle(denials)
			yield* ctx.drainPending()
			return finish(denials.size === toolCalls.length ? 'rejected' : 'executed')
		}

		case 'approve_plan':
		case 'reject_plan':
		// 'answer_question' belongs to an ask_user_question park, not a
		// tool review — like the misdirected plan decisions above, warn
		// and proceed with execution rather than stalling the turn.
		case 'answer_question': {
			ctx.log.warn('Unexpected plan decision during tool review', {
				'namzu.runtime.action': reviewDecision.action,
			})
			const denials = new Map(gateDenied)
			await settleEscalations(denials, undefined)
			await settle(denials)
			yield* ctx.drainPending()
			return finish('executed')
		}

		default: {
			const _exhaustive: never = reviewDecision
			throw new Error(
				`Unhandled tool review decision: ${(_exhaustive as { action: string }).action}`,
			)
		}
	}
}
