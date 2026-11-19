import { useEffect, useState } from 'react'
import { Row } from './settings-row.js'
import { Button } from './ui/button.js'
import { LimitRowView, type UsageLimitsControl } from './usage-limits-popover.js'
import { parseBudgetDraft, usageSettingsModel } from './usage-settings-model.js'
import './usage-section.css'

function BudgetRow({
	provider,
	label,
	current,
	onBudget,
}: {
	provider: string
	label: string
	current: number | undefined
	onBudget: UsageLimitsControl['onBudget']
}) {
	const [draft, setDraft] = useState(current === undefined ? '' : String(current))
	const [refused, setRefused] = useState(false)
	// A change from outside (another window's save, a clear) is what the field shows.
	useEffect(() => setDraft(current === undefined ? '' : String(current)), [current])
	const parsed = parseBudgetDraft(draft)
	const changed = parsed.ok && parsed.usd !== current
	return (
		<Row
			id={`usage-budget-${provider}`}
			label="Spending budget"
			description={`Optional. In US dollars for ${label}, measured against the estimate above. Empty means none.`}
		>
			<form
				className="usage-budget"
				onSubmit={(event) => {
					event.preventDefault()
					if (!parsed.ok) return setRefused(true)
					setRefused(false)
					onBudget(provider, parsed.usd)
				}}
			>
				<label>
					<span className="sr-only">Spending budget in US dollars</span>
					<span aria-hidden="true">$</span>
					<input
						inputMode="decimal"
						value={draft}
						placeholder="No budget"
						aria-invalid={refused || undefined}
						onChange={(event) => {
							setDraft(event.target.value)
							setRefused(false)
						}}
					/>
				</label>
				<Button type="submit" variant="ghost-muted" size="sm" disabled={!changed}>
					Save
				</Button>
			</form>
		</Row>
	)
}

/**
 * Settings, Usage: every provider's limit windows with the popover's rows, the plan when known, and
 * the optional spending budget. A provider that reports nothing has no heading and no sentence.
 */
export function UsageSection({ control }: { control: UsageLimitsControl | undefined }) {
	const onOpen = control?.onOpen
	// Showing the section asks a vendor that has to be asked; the host answers at most once a minute.
	// biome-ignore lint/correctness/useExhaustiveDependencies: opening the section is the trigger.
	useEffect(() => onOpen?.(), [])
	const model = control
		? usageSettingsModel({
				view: control.view,
				currentProvider: control.currentProvider,
				now: control.now(),
				budgets: control.budgets,
			})
		: undefined
	return (
		<div id="setting-usage-limits" className="usage-section">
			{/* A page with nothing on it reads as broken: say plainly that nothing has come in yet. */}
			{model && model.sections.length === 0 && (
				<p className="settings-note">
					Nothing to show yet. Limits appear here after a reply from an account that shares them.
				</p>
			)}
			{model?.sections.map((section) => (
				<section key={section.provider} className="usage-provider" aria-label={section.label}>
					<h2 className="settings-section-title">
						{section.label}
						{section.plan ? <span className="usage-plan"> · {section.plan}</span> : null}
					</h2>
					<div className="usage-rows">
						{section.rows.map((row) => (
							<LimitRowView key={row.key} row={row} variant="settings" />
						))}
					</div>
					{section.budget && control && (
						<BudgetRow
							provider={section.budget.provider}
							label={section.label}
							current={section.budget.usd}
							onBudget={control.onBudget}
						/>
					)}
				</section>
			))}
		</div>
	)
}
