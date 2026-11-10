import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import {
	type RejectedParameter,
	rejectedSamplingParameters,
	withoutSamplingParameters,
} from './request-repair.js'

/**
 * What each model was found to refuse, for the life of the provider object.
 * Weakly keyed so a dropped provider takes its entry with it.
 */
const refused = new WeakMap<object, Map<string, Set<RejectedParameter>>>()

/**
 * A model call made outside the turn loop (a compaction summary, its verifier,
 * the auto-review classifier) that asks for a deterministic answer with
 * `temperature: 0`. Current models refuse sampling parameters outright, and
 * the turn loop already recovers from that; this gives side calls the same
 * recovery instead of letting the call fail and the feature with it.
 *
 * The request goes out as asked. If the provider refuses a sampling parameter
 * BEFORE any output arrived, it is resent without exactly those parameters,
 * and the finding is kept for the model so later calls omit them up front.
 * Nothing is kept unless the resend was accepted, and any other failure is
 * thrown unchanged.
 */
export async function* chatStreamWithSamplingRepair(
	provider: LLMProvider,
	params: ChatCompletionParams,
): AsyncGenerator<StreamChunk> {
	const perModel = refused.get(provider) ?? new Map<string, Set<RejectedParameter>>()
	refused.set(provider, perModel)
	const known = perModel.get(params.model)
	let request = known ? withoutSamplingParameters(params, known) : params
	let stripped: Set<RejectedParameter> | undefined
	for (;;) {
		let yielded = false
		try {
			for await (const chunk of provider.chatStream(request)) {
				yielded = true
				yield chunk
			}
			if (stripped) {
				const merged = new Set([...(perModel.get(params.model) ?? []), ...stripped])
				perModel.set(params.model, merged)
			}
			return
		} catch (error) {
			if (yielded || stripped) throw error
			const names = rejectedSamplingParameters(error, request)
			if (names.length === 0) throw error
			stripped = new Set(names)
			request = withoutSamplingParameters(request, stripped)
		}
	}
}
