/**
 * A developer-authored step list, and deliberately not a model-authored
 * one.
 *
 * This distinction has been attributed to a `packages/sdk/src/agents/
 * AGENTS.md` that does not exist, so it is written here instead. The
 * proposal it answers is a model that emits an orchestration SCRIPT --
 * `agent()`, `parallel()`, `pipeline()` as globals -- executed in an
 * isolate, so that control flow between steps costs no model turns.
 *
 * The saving is real and this class already realises most of it: the steps
 * below run with zero model turns between them, and `SupervisorAgent`
 * delegates without one. What a script would add is orchestration a
 * developer did not anticipate, invented at runtime -- which is also the
 * case where a wrong one is hardest to review before it runs.
 *
 * The blocking question is the trust boundary, not the value. `bash` from
 * a model is mediated by `packages/sandbox` because code from a model is
 * untrusted; a model-authored script is the same input through another
 * door, and a strictly more powerful one, since it can call back into the
 * agent surface. Running it in-process would leave the kernel's one clear
 * confinement boundary covering the weaker case and not the stronger. So
 * an isolate is mandatory rather than an optimisation, and the capability
 * costs a second execution surface to secure, audit and version.
 *
 * That is the bar a reopen has to clear.
 */

import { withTokenBudget } from '../provider/token-budget.js'
import type { SessionTokenBudget } from '../store/budget/index.js'
import type {
	AgentInput,
	AgentMetadata,
	PipelineAgentConfig,
	PipelineAgentResult,
	PipelineStepResult,
	StepContext,
} from '../types/agent/index.js'
import type { SessionId, TurnId } from '../types/ids/index.js'
import type { SessionEvent, SessionEventListener } from '../types/session/events.js'
import type { TurnSettlement } from '../types/session/turn.js'
import { ZERO_COST } from '../utils/cost.js'
import { toErrorMessage } from '../utils/error.js'
import { generateMessageId } from '../utils/id.js'
import type { Logger } from '../utils/logger.js'
import { AbstractAgent } from './AbstractAgent.js'
import { resolveAgentBudget } from './budget.js'

export class PipelineAgent extends AbstractAgent<PipelineAgentConfig, PipelineAgentResult> {
	readonly type = 'pipeline' as const

	constructor(metadata: Omit<AgentMetadata, 'type' | 'capabilities'>, log?: Logger) {
		super(
			{
				...metadata,
				type: 'pipeline',
				capabilities: {
					supportsTools: false,
					supportsStreaming: false,
					supportsConcurrency: false,
					supportsSubAgents: false,
				},
			},
			log,
		)
	}

	/**
	 * One turn at a time per instance.
	 *
	 * `abortController` and `currentSessionId` are instance state, so two
	 * overlapping turns share one abort controller — cancelling either kills
	 * both — and the second clobbers the first's session, so a later
	 * `cancel()` cancels the wrong children. Neither failure announces itself.
	 * A host that wants parallelism constructs a second instance.
	 */
	async run(
		input: AgentInput,
		config: PipelineAgentConfig,
		listener?: SessionEventListener,
	): Promise<PipelineAgentResult> {
		return await this.underIdempotencyKey(config.idempotencyKey, () =>
			this.underInvocationLock(() => this.runExclusive(input, config, listener)),
		)
	}

	private async runExclusive(
		input: AgentInput,
		config: PipelineAgentConfig,
		listener?: SessionEventListener,
	): Promise<PipelineAgentResult> {
		if (config.sandbox) {
			throw new Error(
				'PipelineAgent cannot enforce a turn-level sandbox around developer-authored step callbacks. Configure confinement inside each step or use a tool-running agent.',
			)
		}
		const startTime = Date.now()
		const sessionId = this.resolveSessionId(config.sessionId)
		const turnId = this.createTurnId()
		this.bindTurn(sessionId, turnId, config.logger)
		const budget = await resolveAgentBudget(input, config, { sessionId, turnId })
		const settlement = (status: TurnSettlement['status'], iterations: number): TurnSettlement => ({
			status,
			iterations,
			usage: budget.ownUsage,
			cost: { ...ZERO_COST, unpricedTokens: budget.ownTokens },
			durationMs: Date.now() - startTime,
			resultSource: 'model',
			abandonedTaskIds: [],
			abandonedJobIds: [],
		})
		const provider = config.provider ? withTokenBudget(config.provider, budget) : undefined
		try {
			const stepResults: PipelineStepResult[] = []
			const previousResults = new Map<string, unknown>()
			let completedSteps = 0

			await this.emitEvent(turnStarted(sessionId, turnId, config, budget), listener)

			let currentInput: unknown = input.messages
				.filter((m) => m.role === 'user')
				.map((m) => m.content)
				.filter((c): c is string => c !== null)
				.join('\n')

			for (let i = 0; i < config.steps.length; i++) {
				const step = config.steps[i]
				if (!step) throw new Error(`Pipeline step at index ${i} is undefined`)
				const stepStart = Date.now()

				if (this.abortController.signal.aborted) {
					stepResults.push({
						stepName: step.name,
						status: 'skipped',
						durationMs: 0,
					})
					continue
				}

				await this.emitEvent(
					{ type: 'iteration_started', sessionId, turnId, iteration: i + 1 },
					listener,
				)

				const context: StepContext = {
					sessionId,
					turnId,
					stepIndex: i,
					totalSteps: config.steps.length,
					previousResults,
					provider,
					budget,
					signal: this.abortController.signal,
					env: config.env ?? {},
				}

				try {
					if (step.validate && !step.validate(currentInput)) {
						throw new Error(`Validation failed for step "${step.name}"`)
					}

					const output = await step.execute(currentInput, context)
					previousResults.set(step.name, output)
					currentInput = output
					completedSteps++

					stepResults.push({
						stepName: step.name,
						status: 'completed',
						output,
						durationMs: Date.now() - stepStart,
					})
				} catch (err) {
					const errorMsg = toErrorMessage(err)

					stepResults.push({
						stepName: step.name,
						status: 'failed',
						error: errorMsg,
						durationMs: Date.now() - stepStart,
					})

					if (step.rollback) {
						try {
							await step.rollback(currentInput, context)
						} catch (rollbackErr) {
							this.log.error('Rollback failed for a step', {
								'namzu.pipeline.step_name': step.name,
								'exception.message': toErrorMessage(rollbackErr),
							})
						}
					}

					if (!config.continueOnError) {
						await this.emitEvent(
							{
								type: 'turn_failed',
								sessionId,
								turnId,
								error: errorMsg,
								budget: budget.summary(),
								settlement: settlement('failed', i + 1),
							},
							listener,
						)

						return {
							sessionId,
							turnId,
							status: 'failed',
							stopReason: 'error',
							usage: budget.ownUsage,
							budget: budget.summary(),
							cost: { ...ZERO_COST, unpricedTokens: budget.ownTokens },
							iterations: i + 1,
							durationMs: Date.now() - startTime,
							messages: input.messages,
							lastError: errorMsg,
							stepResults,
							completedSteps,
							totalSteps: config.steps.length,
						}
					}
				}
			}

			const finalStatus = completedSteps === config.steps.length ? 'completed' : 'failed'
			const lastOutput = stepResults[stepResults.length - 1]?.output

			const result = typeof lastOutput === 'string' ? lastOutput : JSON.stringify(lastOutput)

			// A pipeline that finished with failed steps (under `continueOnError`)
			// did not complete its turn, so it settles as `turn_failed`: the
			// terminal verdict is the event type (spec §2.10).
			await this.emitEvent(
				finalStatus === 'completed'
					? {
							type: 'turn_completed',
							sessionId,
							turnId,
							budget: budget.summary(),
							result,
							stopReason: 'end_turn',
							settlement: settlement('completed', config.steps.length),
						}
					: {
							type: 'turn_failed',
							sessionId,
							turnId,
							budget: budget.summary(),
							error: `${config.steps.length - completedSteps} of ${config.steps.length} pipeline steps failed`,
							settlement: settlement('failed', config.steps.length),
						},
				listener,
			)

			return {
				sessionId,
				turnId,
				status: finalStatus,
				stopReason: 'end_turn',
				usage: budget.ownUsage,
				budget: budget.summary(),
				cost: { ...ZERO_COST, unpricedTokens: budget.ownTokens },
				iterations: config.steps.length,
				durationMs: Date.now() - startTime,
				messages: input.messages,
				result,
				stepResults,
				completedSteps,
				totalSteps: config.steps.length,
			}
		} finally {
			budget.settle()
			await budget.flush()
		}
	}
}

/**
 * The turn a pipeline runs, announced the way `query()` announces one. The
 * user message id names the input the steps were handed; nothing is written
 * to a session log, because the steps are callbacks, not model calls.
 */
function turnStarted(
	sessionId: SessionId,
	turnId: TurnId,
	config: PipelineAgentConfig,
	budget: SessionTokenBudget,
): SessionEvent {
	return {
		type: 'turn_started',
		sessionId,
		turnId,
		userMessageId: generateMessageId(),
		config: {
			model: config.model,
			tokenBudget: config.tokenBudget,
			timeoutMs: config.timeoutMs,
		},
		...(budget.binding ? { budget: budget.binding } : {}),
	}
}
