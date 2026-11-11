import type { ThreadUsage } from '../shared/projection.js'
import { contextRingModel, piePath } from './context-ring.js'
import './context-ring.css'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'

const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * How full the conversation is, as a small ring beside the send controls. It is drawn only when the
 * engine has reported both a context size and a window; otherwise nothing takes its place.
 */
export function ContextRing({ usage }: { usage: ThreadUsage | undefined }) {
	const model = contextRingModel(usage)
	if (!model) return null
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						className="context-ring"
						data-context-ring={model.tone}
						aria-label={model.label}
					/>
				}
			>
				<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">
					<circle className="context-ring-track" cx="9" cy="9" r={RADIUS} />
					<circle
						className="context-ring-fill"
						cx="9"
						cy="9"
						r={RADIUS}
						strokeDasharray={CIRCUMFERENCE}
						strokeDashoffset={CIRCUMFERENCE * (1 - model.fraction)}
						transform="rotate(-90 9 9)"
					/>
				</svg>
			</TooltipTrigger>
			<TooltipPopup>
				{model.lines.map((line) => (
					<div key={line}>{line}</div>
				))}
			</TooltipPopup>
		</Tooltip>
	)
}

/**
 * The same facts for the conversation bar: a filled pie (it cannot be mistaken for a spinner)
 * with the share and the cost beside it. Nothing is drawn without a measured context.
 */
export function ContextReadout({ usage }: { usage: ThreadUsage | undefined }) {
	const model = contextRingModel(usage)
	if (!model) return null
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						className="context-readout"
						data-context-ring={model.tone}
						aria-label={model.label}
					/>
				}
			>
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
					<circle className="context-readout-track" cx="8" cy="8" r="7" />
					{model.fraction >= 0.999 ? (
						<circle className="context-readout-fill" cx="8" cy="8" r="5.5" />
					) : model.fraction > 0 ? (
						<path className="context-readout-fill" d={piePath(model.fraction, 5.5, 8)} />
					) : null}
				</svg>
				<span className="context-readout-text">{model.readout}</span>
			</TooltipTrigger>
			<TooltipPopup>
				{model.lines.map((line) => (
					<div key={line}>{line}</div>
				))}
			</TooltipPopup>
		</Tooltip>
	)
}
