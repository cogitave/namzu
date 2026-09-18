import { z } from 'zod'
import { StreamTextAccumulator } from '../../provider/stream-text.js'
import { type TokenUsage, mergeTokenUsage } from '../../types/common/index.js'
import { createSystemMessage, createUserMessage } from '../../types/message/index.js'
import type { PreparationTextRequest, PreparationTextResult } from '../../types/run/prepare-step.js'
import type { IterationContext } from './iteration/phases/context.js'

const requestSchema = z
	.object({
		system: z.string().min(1).max(12_000),
		prompt: z.string().min(1).max(12_000),
		maxTokens: z.number().int().min(1).max(1024).default(256),
		timeoutMs: z.number().int().min(1).max(10_000).default(10_000),
	})
	.strict()

/** The provider already owns retry, fallback, cancellation and budget admission. */
export function createCallbackInference(
	ctx: IterationContext,
	model: string,
	phase: 'preparation' | 'review',
) {
	const label = phase === 'preparation' ? 'Preparation' : 'Review'
	const owner = phase === 'preparation' ? 'preparation stage' : 'answer reviewer'
	const lifetime = new AbortController()
	let used = false
	return {
		close: () => lifetime.abort(new Error(`The ${owner} has ended.`)),
		async generateText(request: PreparationTextRequest): Promise<PreparationTextResult> {
			lifetime.signal.throwIfAborted()
			ctx.abortController.signal.throwIfAborted()
			request.signal?.throwIfAborted()
			const { signal: requestedSignal, ...fields } = request
			const input = requestSchema.parse(fields)
			if (input.system.length + input.prompt.length > 12_000)
				throw new Error(`${label} inference input exceeds 12,000 characters.`)
			if (used)
				throw new Error(
					`${phase === 'preparation' ? 'A' : 'An'} ${owner} may make only one inference call.`,
				)
			used = true
			// No deadline of our own on the request — see the note on
			// `PreparationTextRequest.timeoutMs`. The two bounds that remain are
			// the ones every other model request in the run has: the run's own
			// cancellation, and the provider's request timeout. An expired local
			// deadline here would abort a CONTACTED request, and a request that
			// ends without its usage receipt leaves the shared ledger unresolved,
			// which stops the whole run — so a stage that gave up on its own
			// optional inference would take the operator's turn with it. That is
			// not hypothetical: it is what a 10s deadline did to every turn
			// against a reasoning model slower than 10s per auxiliary answer.
			const signal = AbortSignal.any([
				ctx.abortController.signal,
				lifetime.signal,
				...(requestedSignal ? [requestedSignal] : []),
			])
			const requested = ctx.servingMember?.() ?? { index: 0, providerId: ctx.provider.id }
			const route = () => {
				const member = ctx.servingMember?.() ?? requested
				return {
					providerId: member.providerId,
					model: member.model ?? model,
					chainIndex: member.index,
				}
			}
			const text = new StreamTextAccumulator()
			let invalidOutput: string | undefined
			let usage: TokenUsage | undefined
			try {
				for await (const chunk of ctx.provider.chatStream({
					model,
					providerRoute: route(),
					messages: [createSystemMessage(input.system), createUserMessage(input.prompt)],
					maxTokens: input.maxTokens,
					...(ctx.runConfig.effort ? { effort: ctx.runConfig.effort } : {}),
					signal,
				})) {
					if (chunk.usage) usage = usage ? mergeTokenUsage(usage, chunk.usage) : { ...chunk.usage }
					if (chunk.error) throw new Error(chunk.error)
					signal.throwIfAborted()
					if (chunk.delta.toolCalls?.length) invalidOutput = `${label} inference cannot call tools.`
					if (!invalidOutput) {
						text.push(chunk)
						if (text.characters > 8192)
							invalidOutput = `${label} inference output exceeds 8,192 characters.`
					}
				}
				signal.throwIfAborted()
				if (!usage) throw new Error(`${label} inference ended without usage.`)
				if (invalidOutput) throw new Error(invalidOutput)
				return { text: text.text, usage, servedBy: route() }
			} finally {
				if (usage) ctx.runMgr.accumulateUsage(usage, route())
			}
		},
	}
}
