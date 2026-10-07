import type { ReasoningEffort } from '@namzu/sdk'
import type {
	ComposerModelSettings,
	ModelCatalogueView,
	PalView,
	ProviderView,
} from '../shared/protocol.js'

export interface ModelChoice {
	provider: string
	model: string
	label?: string
	/** `default` follows the engine's own recommended model as its catalogue changes. */
	preset?: 'default'
}

type Row = ModelCatalogueView['models'][number]

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

/**
 * The name to show for a model: the catalogue's own label for the chosen id, else the label saved
 * with the choice, else the id. Saved labels go stale when an engine renames a model.
 */
export function modelDisplayLabel(
	choice: Pick<ModelChoice, 'model' | 'label'>,
	rows: readonly Pick<Row, 'id' | 'label'>[] | undefined,
): string {
	const listed = rows?.find((row) => row.id === choice.model)?.label
	return listed?.trim() || choice.label?.trim() || choice.model
}

/**
 * The engine's own recommended model: the row its catalogue flags, else the row the provider
 * names as its default model.
 */
export function defaultModelRow(
	rows: readonly Row[] | undefined,
	providerDefault?: string,
): Row | undefined {
	return (
		rows?.find((row) => row.default === true) ??
		(providerDefault ? rows?.find((row) => row.id === providerDefault) : undefined)
	)
}

/**
 * A choice that follows the engine default moves with it. Returns the choice to save, or
 * undefined when nothing changes (including a saved label that already matches).
 */
export function followCatalogue(
	choice: ModelChoice,
	rows: readonly Row[] | undefined,
	providerDefault?: string,
): ModelChoice | undefined {
	if (!rows?.length) return undefined
	if (choice.preset === 'default') {
		const fallback = defaultModelRow(rows, providerDefault)
		if (fallback && (fallback.id !== choice.model || fallback.label !== choice.label))
			return {
				provider: choice.provider,
				model: fallback.id,
				label: fallback.label,
				preset: 'default',
			}
		return undefined
	}
	const listed = rows.find((row) => row.id === choice.model)
	if (listed && choice.label !== undefined && listed.label !== choice.label)
		return { ...choice, label: listed.label }
	return undefined
}

export const effortOrder: readonly ReasoningEffort[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
]

export function effortLabel(effort: ReasoningEffort): string {
	return {
		none: 'None',
		minimal: 'Minimal',
		low: 'Low',
		medium: 'Medium',
		high: 'High',
		xhigh: 'Extra High',
		max: 'Max',
		ultra: 'Ultra',
	}[effort]
}

/** The levels a model offers, in canonical order and without duplicates. */
export function orderedEffortLevels(
	levels: readonly ReasoningEffort[] | undefined,
): ReasoningEffort[] {
	return effortOrder.filter((level) => levels?.includes(level))
}

/**
 * What the composer shows and sends for effort: the saved choice while the model offers it, else
 * the model's default. `explicit` tells the two apart so the default can be drawn muted.
 */
export function resolveEffort(
	settings: Pick<ComposerModelSettings, 'effortLevels' | 'effortDefault'> | null | undefined,
	saved: ReasoningEffort | undefined,
): { levels: ReasoningEffort[]; value?: ReasoningEffort; explicit: boolean } {
	const levels = orderedEffortLevels(settings?.effortLevels)
	if (saved && levels.includes(saved)) return { levels, value: saved, explicit: true }
	const fallback = settings?.effortDefault
	if (fallback && levels.includes(fallback)) return { levels, value: fallback, explicit: false }
	return { levels, explicit: false }
}

/** A read that failed says nothing about the model's levels: only a notice came back. */
function settingsUnknown(settings: ComposerModelSettings): boolean {
	return settings.effortLevels === undefined && settings.notice !== undefined
}

/**
 * A saved effort survives a model change when the new model offers it. Once the new model's
 * settings are really known, an effort it does not offer is stale and is cleared. A failed or
 * pending read decides nothing, so a transient error never erases the saved choice.
 */
export function staleEffort(
	settings: ComposerModelSettings | null | undefined,
	saved: ReasoningEffort | undefined,
): boolean {
	if (!saved || !settings || settingsUnknown(settings)) return false
	return !settings.effortLevels?.includes(saved)
}

/**
 * The effort one turn may carry. A stale effort, or one the composer cannot confirm because the
 * read failed, is left off that turn without touching the saved choice.
 */
export function effortToSend(
	settings: ComposerModelSettings | null | undefined,
	saved: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
	if (!saved || !settings) return saved
	if (settingsUnknown(settings)) return undefined
	return staleEffort(settings, saved) ? undefined : saved
}
