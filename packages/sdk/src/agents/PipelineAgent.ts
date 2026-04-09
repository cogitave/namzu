import type {
	AgentInput,
	AgentMetadata,
	PipelineAgentConfig,
	PipelineAgentResult,
	PipelineStepResult,
	StepContext,
} from '../types/agent/index.js'
import { EMPTY_TOKEN_USAGE } from '../types/common/index.js'
import type { RunEventListener } from '../types/run/index.js'
import { ZERO_COST } from '../utils/cost.js'
import { toErrorMessage } from '../utils/error.js'
import { AbstractAgent } from './AbstractAgent.js'

export class PipelineAgent extends AbstractAgent<PipelineAgentConfig, PipelineAgentResult> {
	readonly type = 'pipeline' as const

	constructor(metadata: Omit<AgentMetadata, 'type' | 'capabilities'>) {
		super({
			...metadata,
			type: 'pipeline',
			capabilities: {
				supportsTools: false,
				supportsStreaming: false,
				supportsConcurrency: false,
				supportsSubAgents: false,
			},
		})
	}

	async run(
		input: AgentInput,
		config: PipelineAgentConfig,
		listener?: RunEventListener,
	): Promise<PipelineAgentResult> {
		const startTime = Date.now()
		const runId = this.createRunId()
		const stepResults: PipelineStepResult[] = []
		const previousResults = new Map<string, unknown>()
		let completedSteps = 0

		await this.emitEvent({ type: 'run_started', runId }, listener)

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

			await this.emitEvent({ type: 'iteration_started', runId, iteration: i + 1 }, listener)

			const context: StepContext = {
				runId,
				stepIndex: i,
				totalSteps: config.steps.length,
				previousResults,
				provider: config.provider,
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
						this.log.error(`Rollback failed for step "${step.name}"`, {
							error: toErrorMessage(rollbackErr),
						})
					}
				}

				if (!config.continueOnError) {
					await this.emitEvent({ type: 'run_failed', runId, error: errorMsg }, listener)

					return {
						runId,
						status: 'failed',
						stopReason: 'error',
						usage: { ...EMPTY_TOKEN_USAGE },
						cost: { ...ZERO_COST },
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

		await this.emitEvent(
			{
				type: 'run_completed',
				runId,
				result: typeof lastOutput === 'string' ? lastOutput : JSON.stringify(lastOutput),
			},
			listener,
		)

		return {
			runId,
			status: finalStatus,
			stopReason: 'end_turn',
			usage: { ...EMPTY_TOKEN_USAGE },
			cost: { ...ZERO_COST },
			iterations: config.steps.length,
			durationMs: Date.now() - startTime,
			messages: input.messages,
			result: typeof lastOutput === 'string' ? lastOutput : JSON.stringify(lastOutput),
			stepResults,
			completedSteps,
			totalSteps: config.steps.length,
		}
	}
}
