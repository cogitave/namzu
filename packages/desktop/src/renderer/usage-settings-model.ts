import {
	type LimitRow,
	type UsageLimitsInput,
	type UsageLimitsModel,
	usageLimitsModel,
} from './usage-limits-model.js'

/** One provider in the Usage section: its limit rows, its plan when the vendor named one. */
export interface UsageSettingsSection {
	provider: string
	label: string
	/** The plan the vendor named; absent when it named none. */
	plan?: string
	rows: LimitRow[]
	/** Present only where a spend estimate is shown, the one thing a budget can be set against. */
	budget?: { provider: string; usd?: number }
}

export interface UsageSettingsModel {
	/** Every provider that reported something, the conversation's own first. A silent one is absent. */
	sections: UsageSettingsSection[]
	/** The same reading the popover draws, so the two never disagree. */
	limits: UsageLimitsModel
}

/**
 * What the Usage section in Settings says: the rows of the popover for every provider, with each
 * provider's plan and, where there is a spend estimate, its optional budget. Pure.
 */
export function usageSettingsModel(input: UsageLimitsInput): UsageSettingsModel {
	const limits = usageLimitsModel(input)
	return {
		limits,
		sections: limits.sections.map((section) => {
			const spend = section.rows.find((row) => row.shape === 'spend')
			return {
				provider: section.provider,
				label: section.label,
				...(section.plan ? { plan: section.plan } : {}),
				rows: section.rows,
				...(spend && spend.shape === 'spend'
					? {
							budget: {
								provider: spend.provider,
								...(spend.budgetUsd === undefined ? {} : { usd: spend.budgetUsd }),
							},
						}
					: {}),
			}
		}),
	}
}

/**
 * A typed budget: empty clears it, a positive number in dollars sets it, anything else is refused
 * (the field keeps what was typed and the stored value is untouched).
 */
export function parseBudgetDraft(
	draft: string,
): { ok: true; usd: number | undefined } | { ok: false } {
	if (draft.trim() === '') return { ok: true, usd: undefined }
	const value = Number(draft.trim().replace(/^\$/, ''))
	return Number.isFinite(value) && value > 0 && value < 1e9
		? { ok: true, usd: value }
		: { ok: false }
}
