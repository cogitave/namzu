import { resolveContextWindow } from '../../../compaction/context-window.js'
import { estimateMessageTokens } from '../../../compaction/token-estimate.js'
import { NAMZU } from '../../../constants/telemetry/index.js'
import { renderSkillsSection } from '../../../persona/assembler.js'
import { PreparationContextError } from '../../../run/preparation-context-error.js'
import {
	type Message,
	type UserMessage,
	createRuntimeContextMessage,
	createSystemMessage,
} from '../../../types/message/index.js'
import type { ToolChoice } from '../../../types/provider/chat.js'
import type {
	PrepareStepContext,
	PrepareStepResult,
	StepResult,
	StepVeto,
} from '../../../types/run/index.js'
import type { Skill } from '../../../types/skills/index.js'
import { toErrorMessage } from '../../../utils/error.js'
import { createCallbackInference } from '../callback-inference.js'
import { measureContext } from './phases/compaction.js'
import type { IterationContext } from './phases/index.js'

/**
 * How the next request is shaped: admission, preparation, and the context
 * budget handed to both.
 *
 * Three of these read state the loop replaces or grows as it runs, so they
 * arrive as accessors rather than as values — `latestUserMessage` is replaced
 * on every operator turn and `steps` gains a member per step, and a captured
 * copy of either would describe an earlier return. `ctx` is the run's own
 * context object, passed through rather than re-derived, because
 * `selectContextModel` WRITES two of its fields (`contextModel` and
 * `activeProviderContextWindow`) for the compaction pass to read.
 */
export interface StepShaping {
	readonly ctx: IterationContext
	readonly latestUserMessage: () => UserMessage | undefined
	readonly steps: () => readonly StepResult[]
}

export function stepContextMessage(content: string) {
	return createRuntimeContextMessage(
		`Current step context (runtime-generated; not a new user request):\n${content}`,
		'step-context',
	)
}

/** Derived after request projection; never accumulates in canonical history or replaces operator intent. */
export function appendWorkContext(
	shaping: StepShaping,
	messages: Message[],
	stepNumber: number,
	prepared: PrepareStepResult,
): void {
	const { ctx } = shaping

	const contributions = [
		ctx.completionInbox?.describeOwnedWork(),
		ctx.toolExecutor.describeFileEvidence(messages),
	].filter((content): content is string => Boolean(content))
	if (contributions.length === 0) return
	let room = stepContext(shaping, stepNumber, prepared).contextBudget?.remainingTokens ?? 0
	// Leave room for the actual task; admit whole contributions, never dangling partial references.
	if (room < 1_500) return
	for (const content of contributions) {
		if (!content || content.length > 8_000) continue
		const message = stepContextMessage(content)
		const tokens = estimateMessageTokens(message)
		if (tokens > Math.min(2_000, room - 1_000)) continue
		messages.push(message)
		room -= tokens
	}
}

export function stepContext(
	shaping: StepShaping,
	stepNumber: number,
	prepared: PrepareStepResult,
): PrepareStepContext {
	const { ctx, latestUserMessage, steps } = shaping

	const model = prepared.model ?? ctx.runConfig.model
	const window = resolveContextWindow(
		ctx.compactionConfig?.contextWindowTokens,
		model,
		model === ctx.runConfig.model
			? ctx.providerContextWindow
			: model === ctx.contextModel
				? ctx.activeProviderContextWindow
				: undefined,
	)
	const skills = prepared.skills ? renderSkillsSection([...prepared.skills]) : null
	const preamble = [prepared.system, skills].filter(Boolean).join('\n\n')
	const preparedTokens =
		(preamble ? estimateMessageTokens(createSystemMessage(preamble)) : 0) +
		(prepared.context ? estimateMessageTokens(stepContextMessage(prepared.context)) : 0)
	const responseReserve = Math.min(
		prepared.maxResponseTokens ?? ctx.runConfig.maxResponseTokens ?? Math.floor(window.tokens / 4),
		Math.floor(window.tokens / 4),
	)
	return {
		runId: ctx.runMgr.id,
		stepNumber,
		messages: ctx.runMgr.messages,
		...(ctx.captureRunEvidence ? { captureRunEvidence: ctx.captureRunEvidence } : {}),
		...(latestUserMessage() ? { latestUserMessage: latestUserMessage() } : {}),
		signal: ctx.abortController.signal,
		contextBudget: {
			windowTokens: window.tokens,
			remainingTokens: Math.max(
				0,
				Math.floor(window.tokens - measureContext(ctx).tokens - preparedTokens - responseReserve),
			),
		},
		steps: steps(),
		prepared,
	}
}

/** Refuse the next call on a veto or hook error; do not skip a failed admission check. */
export async function beforeStep(
	shaping: StepShaping,
	stepNumber: number,
): Promise<StepVeto | undefined> {
	const { ctx } = shaping

	const configured = ctx.beforeStep
	if (!configured) return undefined
	try {
		return (await configured(stepContext(shaping, stepNumber, {}))) ?? undefined
	} catch (err) {
		return { reason: `beforeStep threw: ${toErrorMessage(err)}` }
	}
}

/** Shape the next request. A failed tuning stage is skipped; admission belongs to beforeStep. */
export async function prepareStep(
	shaping: StepShaping,
	stepNumber: number,
): Promise<{
	allowedTools?: string[]
	toolChoice?: ToolChoice
	model?: string
	system?: string
	context?: string
	skills?: readonly Skill[]
	temperature?: number
	maxResponseTokens?: number
}> {
	const { ctx } = shaping

	const configured = ctx.prepareStep
	if (!configured) return {}
	const stages = Array.isArray(configured) ? configured : [configured]

	// Folded in DECLARATION order, each stage seeing what the ones
	// before it decided. A later stage overriding a field is last-writer
	// wins — visibly, because the order is a line in the host's code
	// rather than an accident of install history.
	let result: PrepareStepResult = {}
	for (const stage of stages) {
		const inference = createCallbackInference(
			ctx,
			result.model ?? ctx.runConfig.model,
			'preparation',
		)
		try {
			const decided = await stage({
				...stepContext(shaping, stepNumber, result),
				generateText: inference.generateText,
			})
			if (decided) result = { ...result, ...decided }
			await selectContextModel(shaping, result.model ?? ctx.runConfig.model)
		} catch (err) {
			// Skipped, and the rest still run: one broken concern must
			// not silently disable the others it was declared beside.
			ctx.log.error('a prepareStep stage threw — skipping it', {
				[NAMZU.RUN_ID]: ctx.runMgr.id,
				'namzu.runtime.step_number': stepNumber,
				'exception.message': toErrorMessage(err),
			})
			// An SDK stage may report availability and validated fallback evidence
			// without exposing its error. Preserve prior decisions and the context budget;
			// ordinary exceptions still contribute nothing to the model request.
			if (err instanceof PreparationContextError && !ctx.abortController.signal.aborted) {
				const room = stepContext(shaping, stepNumber, result).contextBudget?.remainingTokens ?? 0
				if (
					typeof err.context === 'string' &&
					err.context.length > 0 &&
					err.context.length + (result.context ? 2 : 0) <= Math.min(12_000, Math.floor(room))
				)
					result = {
						...result,
						context: [result.context, err.context].filter(Boolean).join('\n\n'),
					}
			}
		} finally {
			inference.close()
		}
	}

	const prepared: {
		allowedTools?: string[]
		toolChoice?: ToolChoice
		model?: string
		system?: string
		context?: string
		skills?: readonly Skill[]
		temperature?: number
		maxResponseTokens?: number
	} = {}

	if (result.activeTools) {
		const known = result.activeTools.filter((name: string) => ctx.tools.has(name))
		const unknown = result.activeTools.filter((name: string) => !ctx.tools.has(name))
		if (unknown.length > 0) {
			// The all-unknown case gets its own sentence because it has its
			// own consequence. Some names dropped narrows the step; ALL of
			// them dropped leaves it able to call nothing — which is the
			// honest reading of "only these tools" when none of them exist,
			// and is not what a reader of "ignoring them" would expect.
			//
			// Widening back to the run's list would be worse: it grants
			// exactly the tools the caller asked to exclude, on the grounds
			// that their own list failed. A step that can call nothing is
			// constrained; a step that can call everything is a control
			// that stopped applying.
			const message =
				known.length === 0
					? 'prepareStep named only tools that are not registered — this step can call nothing'
					: 'prepareStep named tools that are not registered — ignoring them'
			ctx.log.warn(message, {
				[NAMZU.RUN_ID]: ctx.runMgr.id,
				'namzu.runtime.step_number': stepNumber,
				'namzu.runtime.unknown': unknown,
				'namzu.runtime.remaining': known.length,
			})
		}
		prepared.allowedTools = known
	}
	if (result.toolChoice !== undefined) prepared.toolChoice = result.toolChoice
	if (result.model !== undefined) prepared.model = result.model
	if (result.system !== undefined) prepared.system = result.system
	if (result.context !== undefined) prepared.context = result.context
	if (result.skills !== undefined) prepared.skills = result.skills
	if (result.temperature !== undefined) prepared.temperature = result.temperature
	if (result.maxResponseTokens !== undefined) {
		prepared.maxResponseTokens = result.maxResponseTokens
	}

	return prepared
}

export async function selectContextModel(
	shaping: StepShaping,
	model: string | undefined,
): Promise<void> {
	const { ctx } = shaping

	if (model !== (ctx.contextModel ?? ctx.runConfig.model)) {
		// A measurement from another tokenizer cannot price the new request.
		ctx.runMgr.clearLastPromptTokens()
	}
	ctx.contextModel = model
	ctx.activeProviderContextWindow =
		model && model !== ctx.runConfig.model && !ctx.compactionConfig?.contextWindowTokens
			? await ctx.resolveModelContextWindow?.(model)
			: undefined
}
