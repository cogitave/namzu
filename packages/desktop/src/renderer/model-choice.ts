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
	/**
	 * Only read from older saved choices: `default` once followed the engine's recommended model.
	 * It is resolved to that row once and dropped on the next save.
	 */
	preset?: 'default'
	/** The picker settled on this model by itself rather than the person choosing it. */
	auto?: true
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
 * True when nothing was ever chosen for a conversation that has not started: no saved choice, no
 * Pal model and no model in the preferences. Such a conversation starts from the source's
 * recommended model, not a registry literal.
 */
export function isUnchosen({
	providers,
	draftChoice,
	palModel,
	started,
}: {
	providers: ProviderView
	draftChoice?: ModelChoice
	palModel?: PalView['model']
	started: boolean
}): boolean {
	return !draftChoice && !started && !palModel?.model && !providers.selected?.model
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

/** A date such as 20251101 is a snapshot of a version, never part of it. */
const DATE_RUN = /(?<!\d)(?:19|20)\d{6}(?!\d)/g
const VERSION_RUN = /\d+(?:[.-]\d+)*/

/** The family (name without its version) and numeric version of a row, or no version at all. */
function parseModel(row: Pick<Row, 'id' | 'label'>): { family: string; version?: number[] } {
	for (const text of [row.label, row.id]) {
		const clean = text.replace(DATE_RUN, ' ')
		const run = VERSION_RUN.exec(clean)
		if (!run) continue
		const family = (clean.slice(0, run.index) + clean.slice(run.index + run[0].length))
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim()
		return { family, version: run[0].split(/[.-]/).map(Number) }
	}
	return { family: row.label.toLowerCase() }
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const delta = (a[index] ?? 0) - (b[index] ?? 0)
		if (delta !== 0) return delta
	}
	return 0
}

/** A list this short is shown whole; folding it would hide more than it saves. */
const COMPACT_LIST = 6

/**
 * Splits one provider's rows into the ones worth showing first and the older ones, each in
 * source order. The source's own statement (`current`) always counts. Otherwise a family's
 * newest version is current when its major version is not behind its maker's newest major, so
 * a single stale generation folds away while every family of the latest one stays. A short or
 * unversioned list is all current.
 */
export function splitModels<T extends Pick<Row, 'id' | 'label' | 'current'>>(
	rows: readonly T[],
): { current: T[]; older: T[] } {
	const parsed = rows.map((row) => ({ row, ...parseModel(row) }))
	const versions = parsed.flatMap((item) => (item.version ? [item.version] : []))
	if (rows.length <= COMPACT_LIST || versions.length === 0) return { current: [...rows], older: [] }
	// The newest generation is judged within one maker's models: a list that mixes makers (a
	// router, a free tier) must not fold one maker's latest because another is on a higher number.
	const vendorOf = (family: string) => family.split(' ')[0] ?? ''
	const maxMajor = new Map<string, number>()
	const newest = new Map<string, number[]>()
	for (const { family, version } of parsed) {
		if (!version) continue
		const vendor = vendorOf(family)
		maxMajor.set(vendor, Math.max(maxMajor.get(vendor) ?? 0, version[0] ?? 0))
		const known = newest.get(family)
		if (!known || compareVersions(version, known) > 0) newest.set(family, version)
	}
	const current: T[] = []
	const older: T[] = []
	for (const { row, family, version } of parsed) {
		const isCurrent =
			row.current === true ||
			!version ||
			((version[0] ?? 0) >= (maxMajor.get(vendorOf(family)) ?? 0) &&
				compareVersions(version, newest.get(family) ?? []) >= 0)
		;(isCurrent ? current : older).push(row)
	}
	return current.length ? { current, older } : { current: [...rows], older: [] }
}

/**
 * The model a source recommends: the row its catalogue flags as its own default when that row
 * is current, else nothing. A provider default the catalogue merely echoes can be stale, so it
 * is never shown as a recommendation.
 */
export function recommendedRow<T extends Row>(rows: readonly T[] | undefined): T | undefined {
	if (!rows?.length) return undefined
	const { current } = splitModels(rows)
	return current.find((row) => row.default === true)
}

/** Where a conversation with nothing chosen starts: the recommendation, else the first current row. */
export function startingRow<T extends Row>(rows: readonly T[] | undefined): T | undefined {
	if (!rows?.length) return undefined
	return recommendedRow(rows) ?? splitModels(rows).current[0]
}

/**
 * Brings a saved choice up to date. A choice saved under the retired `default` preset resolves
 * once to the row that preset pointed at and becomes an ordinary choice. Otherwise only a stale
 * label is corrected. Returns undefined when nothing changes.
 */
export function followCatalogue(
	choice: ModelChoice,
	rows: readonly Row[] | undefined,
	providerDefault?: string,
): ModelChoice | undefined {
	if (!rows?.length) return undefined
	if (choice.preset === 'default') {
		const target = defaultModelRow(rows, providerDefault)
		return {
			provider: choice.provider,
			model: target?.id ?? choice.model,
			...(target || choice.label !== undefined ? { label: target?.label ?? choice.label } : {}),
		}
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

export type ModelSection = 'free' | 'key' | 'other'

export const SECTION_HEADINGS: Record<ModelSection, string> = {
	free: 'Free',
	key: 'API key',
	other: 'Other models',
}

/**
 * Which heading each row of one provider's full list sits under, or `undefined` when the list
 * holds fewer than both groups and so shows no headings. A row after the first grouped one that
 * carries no group (no published price) sits under `other`; a row before every grouped one sits
 * under none. Rows are keyed by id, so a search that drops rows leaves the rest where they were.
 */
export function modelSections(rows: readonly Row[]): Map<string, ModelSection> | undefined {
	if (!rows.some((row) => row.group === 'free') || !rows.some((row) => row.group === 'key'))
		return undefined
	const sections = new Map<string, ModelSection>()
	let grouped = false
	for (const row of rows) {
		if (row.group) {
			grouped = true
			sections.set(row.id, row.group)
		} else if (grouped) sections.set(row.id, 'other')
	}
	return sections
}
