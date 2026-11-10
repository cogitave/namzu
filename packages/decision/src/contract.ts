/**
 * The decision-model contract: what a System-1 decision *is*, independent of
 * which service answers it. A driver (Azure AI Foundry, a local HTTP server,
 * …) implements {@link DecisionModel}; the behaviour that consumes it — the
 * `decide` tool, fail-open handling — lives in this package too, so a host
 * only ever wires a configured model to an agent.
 */

export interface DecisionRequestOptions {
	signal?: AbortSignal
	/**
	 * For a yes/no question: what makes the answer yes, in plain words. Some hosted decision
	 * models refuse a yes/no question that carries none. A driver sends it only where the service
	 * is known to take the field; the others leave it out, so the request they send is unchanged.
	 */
	criteria?: string
}

/** P(true), 0..1. */
export interface YesNoDecision {
	p: number
}

export interface ChoiceDecision<T extends string> {
	option: T
	probabilities: Record<T, number>
	/** 1 minus the answer's normalised entropy: how peaked it is, not how often it is right. */
	confidence?: number
}

export interface ScoreDecision {
	/** Index into the `levels` array passed to `score`: the most probable level. */
	level: number
	probabilities: number[]
	/** The probability-weighted average of the level indices, so it can fall between levels. */
	score?: number
	/** 1 minus the answer's normalised entropy: how peaked it is, not how often it is right. */
	confidence?: number
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
