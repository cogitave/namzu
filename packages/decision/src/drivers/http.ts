import type {
	ChoiceDecision,
	DecisionModel,
	DecisionRequestOptions,
	ScoreDecision,
	YesNoDecision,
} from '../contract.js'
import {
	type Question,
	choiceQuestion,
	parseChoice,
	parseScore,
	parseYesNo,
	postDecision,
	scoreQuestion,
	yesnoQuestion,
} from './wire.js'

export interface HttpDecisionConfig {
	/**
	 * Full URL of a decision endpoint that speaks the System One request shape
	 * — a local self-hosted server (e.g. Laya behind a small HTTP wrapper) or an
	 * OpenRouter-style `/decisions` endpoint.
	 */
	url: string
	/** Optional model name sent as the `model` field (for multi-model servers). */
	model?: string
	/** Optional bearer token; when set, sent as `Authorization: Bearer <apiKey>`. */
	apiKey?: string
	/** Extra headers to merge onto every request. */
	headers?: Record<string, string>
	/** Injectable for tests; defaults to `globalThis.fetch`. */
	fetch?: typeof fetch
}

/**
 * A provider-agnostic decision driver for local or self-hosted models reached
 * over plain HTTP. Keyless by default (no `apiKey`), which suits an offline
 * box or a Pal's own machine.
 */
export class HttpDecisionModel implements DecisionModel {
	constructor(private readonly config: HttpDecisionConfig) {}

	async yesno(
		state: string,
		instructions: string,
		opts?: DecisionRequestOptions,
	): Promise<YesNoDecision> {
		return parseYesNo(await this.ask(state, yesnoQuestion(instructions), opts))
	}

	async choice<const T extends string>(
		state: string,
		instructions: string,
		options: readonly T[],
		opts?: DecisionRequestOptions,
	): Promise<ChoiceDecision<T>> {
		return parseChoice<T>(await this.ask(state, choiceQuestion(instructions, options), opts))
	}

	async score(
		state: string,
		instructions: string,
		levels: readonly string[],
		opts?: DecisionRequestOptions,
	): Promise<ScoreDecision> {
		return parseScore(await this.ask(state, scoreQuestion(instructions, levels), opts))
	}

	private async ask(
		state: string,
		question: Question,
		opts?: DecisionRequestOptions,
	): Promise<unknown> {
		return postDecision({
			url: this.config.url,
			headers: {
				...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
				...this.config.headers,
			},
			body: {
				...(this.config.model ? { model: this.config.model } : {}),
				state,
				questions: { q: question },
			},
			fetch: this.config.fetch ?? globalThis.fetch,
			...(opts?.signal ? { signal: opts.signal } : {}),
		})
	}
}
