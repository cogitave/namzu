import type { RunId } from '../ids/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { BaseAgentConfig, BaseAgentResult } from './base.js'

export interface StepContext {
	runId: RunId
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

export interface PipelineAgentResult extends BaseAgentResult {
	stepResults: PipelineStepResult[]
	completedSteps: number
	totalSteps: number
}
