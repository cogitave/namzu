export interface DecisionRequestOptions {
	signal?: AbortSignal
}

/** P(true), 0..1. */
export interface YesNoDecision {
	p: number
}

export interface ChoiceDecision<T extends string> {
	option: T
	probabilities: Record<T, number>
}

export interface ScoreDecision {
	/** Index into the `levels` array passed to `score`. */
	level: number
	probabilities: number[]
}

export interface DecisionModel {
	yesno(state: string, instructions: string, opts?: DecisionRequestOptions): Promise<YesNoDecision>
	choice<const T extends string>(
		state: string,
		instructions: string,
		options: readonly T[],
		opts?: DecisionRequestOptions,
	): Promise<ChoiceDecision<T>>
	score(
		state: string,
		instructions: string,
		levels: readonly string[],
		opts?: DecisionRequestOptions,
	): Promise<ScoreDecision>
}

export class DecisionError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly code?: string,
	) {
		super(message)
		this.name = 'DecisionError'
	}
}

export { AzureFoundryDecisionModel, type AzureFoundryConfig } from './azure-foundry.js'
