import {
	type ChoiceDecision,
	DecisionError,
	type DecisionModel,
	type DecisionRequestOptions,
	type ScoreDecision,
	type YesNoDecision,
} from './index.js'

export interface AzureFoundryConfig {
	/** e.g. https://<res>.services.ai.azure.com */
	endpoint: string
	/** Foundry deployment name, e.g. "decision-1". */
	deployment: string
	/** Returns an Entra bearer token. The caller supplies it, which keeps this package dependency-free. */
	getToken: () => Promise<string>
	/** Injectable for tests; defaults to `globalThis.fetch`. */
	fetch?: typeof fetch
}

type Question = Record<string, unknown>

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function numberRecord(v: unknown): Record<string, number> {
	const out: Record<string, number> = {}
	if (isRecord(v)) {
		for (const [k, val] of Object.entries(v)) if (typeof val === 'number') out[k] = val
	}
	return out
}

export class AzureFoundryDecisionModel implements DecisionModel {
	constructor(private readonly config: AzureFoundryConfig) {}

	async yesno(
		state: string,
		instructions: string,
		opts?: DecisionRequestOptions,
	): Promise<YesNoDecision> {
		const answer = await this.ask(state, { type: 'noul', instructions }, opts)
		const noul = isRecord(answer) ? answer.noul : undefined
		if (typeof noul !== 'number') {
			throw new DecisionError('Decision response carried no "noul" probability')
		}
		return { p: noul }
	}

	async choice<const T extends string>(
		state: string,
		instructions: string,
		options: readonly T[],
		opts?: DecisionRequestOptions,
	): Promise<ChoiceDecision<T>> {
		// TODO(decision): confirm the live wire field for choice options against the Foundry OpenAPI schema (yesno is verified; choice/score request shape is provisional)
		const answer = await this.ask(
			state,
			{ type: 'choice', instructions, options: [...options] },
			opts,
		)
		const body = isRecord(answer) && isRecord(answer.choice) ? answer.choice : answer
		const probabilities = numberRecord(isRecord(body) ? body.probabilities : undefined)
		let option = isRecord(body) ? body.option : undefined
		if (typeof option !== 'string') {
			// Defensive: fall back to the most probable option.
			option = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0]
		}
		if (typeof option !== 'string') {
			throw new DecisionError('Decision response carried no "choice" answer')
		}
		return { option: option as T, probabilities: probabilities as Record<T, number> }
	}

	async score(
		state: string,
		instructions: string,
		levels: readonly string[],
		opts?: DecisionRequestOptions,
	): Promise<ScoreDecision> {
		// TODO(decision): confirm the live wire field for score levels against the Foundry OpenAPI schema (yesno is verified; choice/score request shape is provisional)
		const answer = await this.ask(state, { type: 'score', instructions, levels: [...levels] }, opts)
		const body = isRecord(answer) && isRecord(answer.score) ? answer.score : answer
		const raw = isRecord(body) ? body : {}
		const probabilities = Array.isArray(raw.probabilities)
			? raw.probabilities.filter((x): x is number => typeof x === 'number')
			: []
		let level = raw.level
		if (typeof level !== 'number') {
			let best = -1
			probabilities.forEach((p, i) => {
				if (best < 0 || p > (probabilities[best] ?? 0)) best = i
			})
			level = best >= 0 ? best : undefined
		}
		if (typeof level !== 'number') {
			throw new DecisionError('Decision response carried no "score" answer')
		}
		return { level, probabilities }
	}

	private async ask(
		state: string,
		question: Question,
		opts?: DecisionRequestOptions,
	): Promise<unknown> {
		const doFetch = this.config.fetch ?? globalThis.fetch
		const token = await this.config.getToken()
		const url = `${this.config.endpoint.replace(/\/$/, '')}/providers/microsoft/v1/systemone`
		const res = await doFetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: this.config.deployment,
				state,
				questions: { q: question },
			}),
			signal: opts?.signal,
		})
		let json: unknown
		try {
			json = await res.json()
		} catch {
			json = undefined
		}
		if (!res.ok) {
			const err = isRecord(json) && isRecord(json.error) ? json.error : {}
			throw new DecisionError(
				typeof err.message === 'string' ? err.message : `Decision request failed (${res.status})`,
				res.status,
				typeof err.code === 'string' ? err.code : undefined,
			)
		}
		const answers = isRecord(json) ? json.answers : undefined
		return isRecord(answers) ? answers.q : undefined
	}
}
