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
	postYesNo,
	scoreQuestion,
} from './wire.js'

export interface AzureFoundryConfig {
	/** e.g. https://<res>.services.ai.azure.com */
	endpoint: string
	/** Foundry deployment name, e.g. "decision-1". */
	deployment: string
	/**
	 * Returns an Entra bearer token. The host supplies it, which keeps this package free of an
	 * Azure SDK. Not needed when `getApiKey` is given.
	 */
	getToken?: () => Promise<string>
	/**
	 * Returns an API key for a resource that allows key authentication, sent as `api-key`. Read at
	 * each call, so a rotated key is picked up. Wins over `getToken` when both are given.
	 */
	getApiKey?: () => string | Promise<string>
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
		// `criteria` goes as the optional object with `true` and `false` keys that the vendor's
		// published page describes (`{ true: <sentence> }`). No live call was made against this
		// endpoint, so a 400 naming `criteria` is asked again once with the sentence folded into
		// `instructions`, and that is remembered for this endpoint and deployment.
		return parseYesNo(
			await postYesNo({
				post: (question) => this.ask(state, question, opts),
				instructions,
				...(opts?.criteria !== undefined ? { criteria: opts.criteria } : {}),
				memoryKey: `${this.config.endpoint}\n${this.config.deployment}`,
			}),
		)
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
		const headers = await this.authHeaders()
		return postDecision({
			url: `${this.config.endpoint.replace(/\/$/, '')}/providers/microsoft/v1/systemone`,
			headers,
			body: { model: this.config.deployment, state, questions: { q: question } },
			fetch: this.config.fetch ?? globalThis.fetch,
			...(opts?.signal ? { signal: opts.signal } : {}),
		})
	}

	private async authHeaders(): Promise<Record<string, string>> {
		if (this.config.getApiKey) return { 'api-key': await this.config.getApiKey() }
		if (!this.config.getToken) {
			throw new Error('The Azure decision provider needs getToken or getApiKey')
		}
		return { Authorization: `Bearer ${await this.config.getToken()}` }
	}
}
