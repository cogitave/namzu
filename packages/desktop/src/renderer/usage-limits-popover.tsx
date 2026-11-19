import { useState } from 'react'
import type { LimitsNotification } from '../shared/limits-protocol.js'
import type { ThreadUsage } from '../shared/projection.js'
import { type ContextRingModel, contextRingModel, piePath } from './context-ring.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import {
	type LimitRow,
	type LimitTone,
	type UsageLimitsModel,
	usageLimitsModel,
	worseTone,
} from './usage-limits-model.js'
import './usage-limits-popover.css'

/** What the indicator needs to open the usage limits popover; absent where nothing is known. */
export interface UsageLimitsControl {
	view: LimitsNotification | undefined
	/** The provider of this conversation: listed first. */
	currentProvider?: string | undefined
	budgets: Readonly<Record<string, number>>
	onBudget: (provider: string, usd: number | undefined) => void
	/** Called when the popover opens; the host asks a vendor at most once a minute. */
	onOpen: () => void
	/** The clock the reset words are read against. */
	now: () => number
	/** Opens Settings at Usage, where every provider's limits are listed; the link is absent when it cannot. */
	onSeeAll?: () => void
	/** Opens the Session panel, where the full breakdown of the context is; absent when it cannot. */
	onDetails?: () => void
}

export function Bar({ fraction, tone }: { fraction: number; tone: LimitTone }) {
	return (
		<span className="limits-bar" data-tone={tone} aria-hidden="true">
			<span style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }} />
		</span>
	)
}

/** One limit row: a window with its percent, reset or start line and bar, or a credit or spend line. */
export function LimitRowView({ row }: { row: LimitRow }) {
	if (row.shape === 'window') {
		const note = [row.reset, row.state, row.asOf].filter(Boolean).join(' · ')
		return (
			<div className="limits-row" data-row="window" data-tone={row.tone}>
				<div className="limits-line">
					<span className="limits-label">{row.label}</span>
					<span className="limits-percent">{row.percent}</span>
				</div>
				{note && (
					<span className="limits-note" data-tone={row.tone}>
						{note}
					</span>
				)}
				<Bar fraction={row.fraction} tone={row.tone} />
			</div>
		)
	}
	return (
		<div className="limits-row" data-row={row.shape} data-tone={row.tone}>
			<div className="limits-line">
				<span className="limits-label">{row.text}</span>
			</div>
			{row.fraction !== undefined && <Bar fraction={row.fraction} tone={row.tone} />}
		</div>
	)
}

export function UsageLimitsPanel({
	model,
	context,
	control,
}: {
	model: UsageLimitsModel
	context: ContextRingModel | undefined
	control: UsageLimitsControl
}) {
	// One provider: its plan goes in the title, as "Your usage limits · Team". Several: each is named.
	const only = model.sections.length === 1 ? model.sections[0] : undefined
	return (
		<div className="limits-panel" data-testid="usage-limits">
			{model.sections.length > 0 && (
				<>
					<div className="limits-heading">
						<h2 className="limits-title">
							Your usage limits
							{only?.plan ? <span className="limits-plan"> · {only.plan}</span> : null}
						</h2>
						{control.onSeeAll && (
							<button type="button" className="limits-link" onClick={control.onSeeAll}>
								See all <span aria-hidden="true">→</span>
							</button>
						)}
					</div>
					{model.sections.map((section) => (
						<section key={section.provider} className="limits-section" aria-label={section.title}>
							{model.sections.length > 1 && <h3 className="limits-provider">{section.title}</h3>}
							{section.rows.map((row) => (
								<LimitRowView key={row.key} row={row} />
							))}
						</section>
					))}
				</>
			)}
			{context && (
				<section
					className="limits-section"
					data-divided={model.sections.length > 0 || undefined}
					aria-label="Context"
				>
					<div className="limits-row" data-row="context" data-tone={context.tone}>
						<div className="limits-line">
							<span className="limits-label">Context</span>
							<span className="limits-percent">{context.percent}%</span>
							{control.onDetails && (
								<button type="button" className="limits-link" onClick={control.onDetails}>
									Details
								</button>
							)}
						</div>
						<Bar fraction={context.fraction} tone={context.tone} />
					</div>
				</section>
			)}
		</div>
	)
}

/** The tone and share the indicator shows: the worse of the context and the account limits. */
export function indicatorState(
	usage: ThreadUsage | undefined,
	control: UsageLimitsControl | undefined,
):
	| { context: ContextRingModel | undefined; limits: UsageLimitsModel | undefined; tone: LimitTone }
	| undefined {
	const context = contextRingModel(usage)
	const limits = control
		? usageLimitsModel({
				view: control.view,
				currentProvider: control.currentProvider,
				now: control.now(),
				budgets: control.budgets,
			})
		: undefined
	const measured = limits !== undefined && limits.worst !== undefined
	if (!context && !measured) return undefined
	return {
		context,
		limits,
		tone: worseTone(context?.tone ?? 'normal', limits?.tone ?? 'normal'),
	}
}

/**
 * The small indicator beside the model, as a ring or a pie, that opens the usage limits popover.
 * It turns amber at 75 percent of the context or of any account window, and red at 90.
 */
export function UsageIndicator({
	usage,
	control,
	variant,
}: {
	usage: ThreadUsage | undefined
	control: UsageLimitsControl
	variant: 'ring' | 'readout'
}) {
	const [open, setOpen] = useState(false)
	const state = indicatorState(usage, control)
	if (!state) return null
	const model = usageLimitsModel({
		view: control.view,
		currentProvider: control.currentProvider,
		now: control.now(),
		budgets: control.budgets,
	})
	const fraction = Math.max(state.context?.fraction ?? 0, model.worst ?? 0)
	const label = [
		state.context?.label,
		model.worst !== undefined
			? `Usage limits: the most used is ${Math.round(model.worst * 100)}%.`
			: undefined,
	]
		.filter(Boolean)
		.join(' ')
	// The share beside the pie is the one the pie draws: the account's when it is the fuller.
	const text =
		model.worst !== undefined && model.worst > (state.context?.fraction ?? 0)
			? `${Math.round(model.worst * 100)}%`
			: (state.context?.readout ?? '')
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next)
				if (next) control.onOpen()
			}}
		>
			<PopoverTrigger
				render={
					<button
						type="button"
						className={variant === 'ring' ? 'context-ring' : 'context-readout'}
						data-context-ring={state.tone}
						data-usage-indicator=""
						aria-label={`${label} Usage limits`}
					/>
				}
			>
				{variant === 'ring' ? (
					<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">
						<circle className="context-ring-track" cx="9" cy="9" r={7} />
						<circle
							className="context-ring-fill"
							cx="9"
							cy="9"
							r={7}
							strokeDasharray={2 * Math.PI * 7}
							strokeDashoffset={2 * Math.PI * 7 * (1 - fraction)}
							transform="rotate(-90 9 9)"
						/>
					</svg>
				) : (
					<>
						<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
							<circle className="context-readout-track" cx="8" cy="8" r="7" />
							{fraction >= 0.999 ? (
								<circle className="context-readout-fill" cx="8" cy="8" r="5.5" />
							) : fraction > 0 ? (
								<path className="context-readout-fill" d={piePath(fraction, 5.5, 8)} />
							) : null}
						</svg>
						<span className="context-readout-text">{text}</span>
					</>
				)}
			</PopoverTrigger>
			<PopoverPopup
				aria-label="Your usage limits"
				align="end"
				side="top"
				padding="none"
				className="limits-popup"
				// Opening it does not move focus onto the Details link, which would draw a ring nobody asked for.
				initialFocus={false}
			>
				<UsageLimitsPanel
					model={model}
					context={state.context}
					control={{
						...control,
						// Following the link leaves the popover behind it.
						...(control.onSeeAll
							? {
									onSeeAll: () => {
										setOpen(false)
										control.onSeeAll?.()
									},
								}
							: {}),
					}}
				/>
			</PopoverPopup>
		</Popover>
	)
}
