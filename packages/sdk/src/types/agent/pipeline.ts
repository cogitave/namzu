import type { SessionTokenBudget } from '../../store/budget/index.js'
import type { SessionId, TurnId } from '../ids/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { BaseAgentConfig, BaseAgentResult } from './base.js'

export interface StepContext {
	/** Shared authority; reserve a child scope before invoking another agent. */
	budget: SessionTokenBudget
	sessionId: SessionId
	turnId: TurnId
	stepIndex: number
	totalSteps: number
	previousResults: Map<string, unknown>
	provider?: LLMProvider
	signal?: AbortSignal
	env: Record<string, string>
}

export interface PipelineStep<TInput = unknown, TOutput = unknown> {
	name: string
	description?: string
	execute(input: TInput, context: StepContext): Promise<TOutput>
	rollback?(input: TInput, context: StepContext): Promise<void>
	validate?(input: TInput): boolean
}

/** @deprecated Configuration for the pipeline example; define application orchestration as needed. */
export interface PipelineAgentConfig extends BaseAgentConfig {
	steps: PipelineStep[]
	provider?: LLMProvider
	continueOnError?: boolean
}

export interface PipelineStepResult {
	stepName: string
	status: 'completed' | 'failed' | 'skipped'
	output?: unknown
	error?: string
	durationMs: number
}

/** @deprecated Result of the pipeline example. */
export interface PipelineAgentResult extends BaseAgentResult {
	stepResults: PipelineStepResult[]
	completedSteps: number
	totalSteps: number
}
