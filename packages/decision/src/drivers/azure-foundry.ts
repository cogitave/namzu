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

export interface AzureFoundryConfig {
	/** e.g. https://<res>.services.ai.azure.com */
	endpoint: string
	/** Foundry deployment name, e.g. "decision-1". */
	deployment: string
	/** Returns an Entra bearer token. The host supplies it, which keeps this package free of an Azure SDK. */
	getToken: () => Promise<string>
	/** Injectable for tests; defaults to `globalThis.fetch`. */
	fetch?: typeof fetch
}

export class AzureFoundryDecisionModel implements DecisionModel {
	constructor(private readonly config: AzureFoundryConfig) {}

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
		const token = await this.config.getToken()
		return postDecision({
			url: `${this.config.endpoint.replace(/\/$/, '')}/providers/microsoft/v1/systemone`,
			headers: { Authorization: `Bearer ${token}` },
			body: { model: this.config.deployment, state, questions: { q: question } },
			fetch: this.config.fetch ?? globalThis.fetch,
			...(opts?.signal ? { signal: opts.signal } : {}),
		})
	}
}
