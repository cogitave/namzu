import type { LLMProvider } from '@namzu/sdk'

/** Some drivers populate exact model reasoning profiles from their catalogue. */
export async function prepareDelegatedEffort(
	provider: LLMProvider,
	model: string,
	signal?: AbortSignal,
): Promise<void> {
	if (
		(provider.reasoningEffortLevelsFor?.(model) ?? provider.effortLevelsFor?.(model)) !== undefined
	)
		return
	if (!provider.listModels) return
	const deadline = AbortSignal.timeout(3000)
	const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline
	await provider.listModels(bounded)
	bounded.throwIfAborted()
}
