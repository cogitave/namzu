import { Slider } from '@base-ui/react/slider'
import type { ReasoningEffort } from '@namzu/sdk'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { LoaderCircleIcon } from './icons.js'
import { effortLabel } from './model-choice.js'
import { Button } from './ui/button.js'
import './composer-effort-panel.css'

/**
 * The effort popover body: a stop per level the model offers, and a way into the model list.
 * Every move commits at once, like the menus around it.
 */
export function ComposerEffortPanel({
	scope,
	modelLabel,
	levels,
	value,
	defaultValue,
	loading,
	disabled,
	onChange,
	onShowModels,
	onUnavailable,
}: {
	/** Identifies the model and conversation the levels belong to. */
	scope: string
	modelLabel: string
	/** Offered levels, easiest first. */
	levels: readonly ReasoningEffort[]
	/** The level in force: the saved one, else the model's default. */
	value?: ReasoningEffort
	defaultValue?: ReasoningEffort
	/** The model's settings are still being read. */
	loading: boolean
	disabled: boolean
	onChange: (effort: ReasoningEffort | undefined) => void
	onShowModels: () => void
	/** The model turned out to offer no choice of effort. */
	onUnavailable: () => void
}) {
	const slider = useRef<HTMLDivElement>(null)
	const unavailable = !loading && levels.length < 2
	useEffect(() => {
		if (unavailable) onUnavailable()
	}, [unavailable, onUnavailable])
	// The slider takes the keyboard whenever it appears, so arrows work straight away; it is absent
	// while the levels are still being read. The popup reclaims focus when the control that was
	// clicked to get here unmounts, so focus is placed again once that has settled.
	useEffect(() => {
		if (loading) return
		const input = slider.current?.querySelector<HTMLElement>('input[type="range"]')
		input?.focus({ preventScroll: true })
		const frame = requestAnimationFrame(() => {
			if (document.activeElement !== input) input?.focus({ preventScroll: true })
		})
		return () => cancelAnimationFrame(frame)
	}, [loading])
	const index = value ? Math.max(0, levels.indexOf(value)) : 0
	const label = value ? effortLabel(value) : 'Model default'
	const atDefault = !defaultValue || value === defaultValue
	return (
		<div className="composer-effort-panel" data-scope={scope} data-unset={!value || undefined}>
			<div className="composer-effort-header">
				<Button
					variant="ghost-muted"
					size="icon-xs"
					className="composer-effort-reset"
					aria-label="Use default effort"
					disabled={disabled || atDefault}
					onClick={() => onChange(undefined)}
				>
					<RotateCcw aria-hidden="true" />
				</Button>
				<div className="composer-effort-title">
					<output className="composer-effort-value" aria-live="polite">
						{label}
					</output>
					<button type="button" className="composer-effort-model" onClick={onShowModels}>
						<span>{modelLabel}</span>
						<ChevronRight aria-hidden="true" />
						<span className="sr-only">, change model</span>
					</button>
				</div>
			</div>
			{loading ? (
				<output className="composer-effort-status">
					<LoaderCircleIcon className="composer-effort-spinner" aria-hidden="true" />
					Loading effort levels…
				</output>
			) : (
				<>
					<Slider.Root
						ref={slider}
						className="composer-effort-slider"
						min={0}
						max={Math.max(1, levels.length - 1)}
						step={1}
						value={index}
						disabled={disabled}
						onValueChange={(next) => {
							const level = levels[next]
							if (level && level !== value) onChange(level)
						}}
					>
						<Slider.Control className="composer-effort-control">
							<Slider.Track className="composer-effort-track">
								<Slider.Indicator className="composer-effort-fill" />
								<span className="composer-effort-stops" aria-hidden="true">
									{levels.map((level, stop) => (
										<i
											key={level}
											className="composer-effort-stop"
											data-passed={stop <= index || undefined}
											style={{ left: `${(stop / Math.max(1, levels.length - 1)) * 100}%` }}
										/>
									))}
								</span>
								<Slider.Thumb
									className="composer-effort-thumb"
									aria-label="Effort"
									getAriaValueText={(_formatted, position) =>
										levels[position] ? effortLabel(levels[position]) : label
									}
								/>
							</Slider.Track>
						</Slider.Control>
					</Slider.Root>
					<div className="composer-effort-scale" aria-hidden="true">
						<span>Faster</span>
						<span>Smarter</span>
					</div>
				</>
			)}
		</div>
	)
}
