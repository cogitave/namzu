import type { PalView, ProviderView } from '../shared/protocol.js'
import type { ModelChoice } from './model-picker.js'

/** A landing uses today's Pal default; a conversation owns its pinned route. */
export function resolveComposerModelChoice({
	providers,
	draftChoice,
	palModel,
	sessionId,
}: {
	providers: ProviderView
	draftChoice?: ModelChoice
	palModel?: PalView['model']
	sessionId: string
}): ModelChoice {
	if (draftChoice) return draftChoice
	const profile = sessionId ? undefined : palModel
	const provider = profile?.provider ?? providers.selected?.id ?? providers.available[0]?.id ?? ''
	return {
		provider,
		model:
			profile?.model ||
			providers.selected?.model ||
			providers.available.find((item) => item.id === provider)?.defaultModel ||
			'',
	}
}
