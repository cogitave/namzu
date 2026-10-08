import { Slider } from '@base-ui/react/slider'
import type { ReasoningEffort } from '@namzu/sdk'
import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { HarnessView } from '../shared/protocol.js'
import { EffortShader } from './effort-shader/effort-shader.js'
import { EngineChip, type EngineSurfaceControl, SurfaceSwitch } from './harness-picker.js'
import { LoaderCircleIcon } from './icons.js'
import { effortLabel } from './model-choice.js'
import './composer-effort-panel.css'

/** The stop that is the model's own default, or -1 when it has none among the offered levels. */
export function defaultStop(
	levels: readonly ReasoningEffort[],
	defaultValue: ReasoningEffort | undefined,
): number {
	return defaultValue ? levels.indexOf(defaultValue) : -1
}

/** What a screen reader hears at a stop; the default stop says so, as the reset icon once did. */
export function effortValueText(
	levels: readonly ReasoningEffort[],
	position: number,
	defaultValue: ReasoningEffort | undefined,
	fallback: string,
): string {
	const level = levels[position]
	if (!level) return fallback
	return position === defaultStop(levels, defaultValue)
		? `${effortLabel(level)} (default)`
		: effortLabel(level)
}

/**
 * The effort popover body: a stop per level the model offers, and a way into the model list.
 * Every move commits at once, like the menus around it. Double-clicking the slider returns to the
 * model's default.
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
	engine,
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
	/** The engine in force and the way into the engine view; absent where engines are not offered. */
	engine?: {
		id: HarnessView['selected']
		label: string
		disabled: boolean
		onOpen: () => void
		surface?: EngineSurfaceControl
	}
}) {
	const slider = useRef<HTMLDivElement>(null)
	// The CSS fill stays until the shader's first frame lands, and returns if WebGL is lost.
	const [shaderReady, setShaderReady] = useState(false)
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
	const defaultIndex = defaultStop(levels, defaultValue)
	return (
		<div
			className="composer-effort-panel"
			data-scope={scope}
			data-unset={!value || undefined}
			data-shader={shaderReady ? 'on' : undefined}
		>
			<div className="composer-effort-header">
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
				{engine && (
					<span className="engine-controls">
						<EngineChip
							engine={engine.id}
							label={engine.label}
							disabled={engine.disabled}
							onClick={engine.onOpen}
						/>
						{engine.surface && (
							<SurfaceSwitch
								value={engine.surface.value}
								onChange={engine.surface.onChange}
								disabled={engine.surface.disabled}
								reason={engine.surface.reason}
							/>
						)}
					</span>
				)}
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
						<Slider.Control
							className="composer-effort-control"
							onDoubleClick={() => {
								if (!disabled) onChange(undefined)
							}}
							// Keyboard users have no double-click, so Backspace or Delete resets as well.
							onKeyDown={(event) => {
								if (disabled || (event.key !== 'Backspace' && event.key !== 'Delete')) return
								event.preventDefault()
								onChange(undefined)
							}}
						>
							<Slider.Track className="composer-effort-track">
								<Slider.Indicator className="composer-effort-fill" />
								<EffortShader
									progress={index / Math.max(1, levels.length - 1)}
									level={index / Math.max(1, levels.length - 1)}
									visible={Boolean(value)}
									onReady={setShaderReady}
								/>
								<span className="composer-effort-stops" aria-hidden="true">
									{levels.map((level, stop) => (
										<i
											key={level}
											className="composer-effort-stop"
											data-passed={stop <= index || undefined}
											data-default={stop === defaultIndex || undefined}
											style={{ left: `${(stop / Math.max(1, levels.length - 1)) * 100}%` }}
										/>
									))}
								</span>
								<Slider.Thumb
									className="composer-effort-thumb"
									aria-label="Effort"
									getAriaValueText={(_formatted, position) =>
										effortValueText(levels, position, defaultValue, label)
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
