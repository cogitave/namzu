import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { ChevronDown, ChevronLeft } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { HarnessView } from '../shared/protocol.js'
import { engineUpdateNote } from './engine-updates-model.js'
import { CheckIcon, ProviderIcons } from './icons.js'
import { Wordmark } from './wordmark.js'
import './harness-picker.css'
import { commitsOnKey } from './picker-commit.js'
import { useEngineUpdates } from './use-engine-updates.js'

export function HarnessMark({ engine }: { engine: HarnessView['selected'] }) {
	if (engine === 'namzu')
		return (
			<span className="composer-harness-mark" aria-hidden="true">
				<Wordmark />
			</span>
		)
	const Icon = ProviderIcons.get(engine === 'codex-cli' ? 'openai' : 'anthropic')
	return Icon ? <Icon aria-hidden="true" className="size-4" /> : null
}

/** The engine a row may commit, or undefined when it is unavailable or the picker is locked. */
export function committableEngine(
	view: HarnessView | undefined,
	value: string,
	locked: { busy: boolean; disabled: boolean },
): HarnessView['selected'] | undefined {
	if (locked.busy || locked.disabled) return undefined
	return view?.engines.find((engine) => engine.id === value && engine.available)?.id
}

const ENGINE_LABELS: Record<HarnessView['selected'], string> = {
	namzu: 'Namzu',
	'codex-cli': 'Codex CLI',
	'claude-code': 'Claude Code',
}

export function engineLabel(
	view: HarnessView | undefined,
	engine: HarnessView['selected'],
): string {
	return view?.engines.find((item) => item.id === engine)?.label ?? ENGINE_LABELS[engine]
}

/**
 * The line under an engine row. A started conversation keeps its engine, so choosing another one
 * opens a new tab instead of switching this one.
 */
export function engineRowNote(
	view: HarnessView | undefined,
	engine: HarnessView['engines'][number],
): 'Not installed' | 'Opens in a new tab' | undefined {
	if (!engine.available) return 'Not installed'
	if (view?.locked && engine.id !== view.selected) return 'Opens in a new tab'
	return undefined
}

/** The engine mark and a small chevron: the way into the engine view of the model popup. */
export function EngineChip({
	engine,
	label,
	disabled,
	onClick,
}: {
	engine: HarnessView['selected']
	label: string
	disabled: boolean
	onClick: () => void
}) {
	const note = engineUpdateNote(useEngineUpdates()?.state, engine)
	return (
		<button
			type="button"
			className="engine-chip"
			aria-label={note ? `Engine: ${label}. ${note}` : `Engine: ${label}`}
			title={note ? `${label} — ${note}` : label}
			data-update={note ? 'available' : undefined}
			disabled={disabled}
			onClick={onClick}
		>
			<HarnessMark engine={engine} />
			<ChevronDown aria-hidden="true" />
		</button>
	)
}

/** The engine view of the model popup: choose which engine runs the conversation. */
export function EnginePanel({
	view,
	selectedEngine,
	backLabel,
	busy,
	disabled,
	onBack,
	onSelect,
}: {
	view?: HarnessView
	selectedEngine?: HarnessView['selected']
	/** Where Back leads: the view the engine view was opened from. */
	backLabel: 'Effort' | 'Models'
	busy: boolean
	disabled: boolean
	onBack: () => void
	onSelect: (engine: HarnessView['selected']) => void
}) {
	const selected = view?.selected ?? selectedEngine ?? 'namzu'
	const updates = useEngineUpdates()?.state
	const commit = (value: string) => {
		const engine = committableEngine(view, value, { busy, disabled })
		if (engine) onSelect(engine)
	}
	const panel = useRef<HTMLDivElement>(null)
	// Focus lands on the current engine so the arrow keys and Enter work straight away. The popup
	// reclaims focus once the control that opened this view unmounts, so it is placed again after.
	useEffect(() => {
		const row = () =>
			panel.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? null
		row()?.focus({ preventScroll: true })
		const frame = requestAnimationFrame(() => {
			const target = row()
			if (target && document.activeElement !== target) target.focus({ preventScroll: true })
		})
		return () => cancelAnimationFrame(frame)
	}, [])
	return (
		<div className="engine-panel" ref={panel}>
			<header className="engine-panel-heading">
				<button type="button" className="engine-panel-back" onClick={onBack}>
					<ChevronLeft aria-hidden="true" />
					{backLabel}
				</button>
				<h2 className="engine-panel-title">Choose an engine</h2>
			</header>
			<RadioGroup
				className="harness-picker-list"
				aria-label="Available engines"
				value={selected}
				// Arrow keys only move focus; a choice is committed by click, Enter or Space (a native click).
				onValueChange={() => {}}
			>
				{(view?.engines ?? [{ id: 'namzu' as const, label: 'Namzu', available: true }]).map(
					(engine) => {
						const note = engineRowNote(view, engine)
						const updateNote = engineUpdateNote(updates, engine.id)
						return (
							<Radio.Root
								key={engine.id}
								value={engine.id}
								disabled={!engine.available}
								nativeButton
								render={<button type="button" />}
								className="harness-picker-row"
								onClick={(event) => {
									event.preventDefault()
									commit(engine.id)
								}}
								onKeyDown={(event) => {
									if (commitsOnKey(event.key)) {
										event.preventDefault()
										commit(engine.id)
									}
								}}
							>
								<HarnessMark engine={engine.id} />
								<span className="harness-picker-name">
									<span>{engine.label}</span>
									{note && <small>{note}</small>}
									{updateNote && <small className="harness-picker-update">{updateNote}</small>}
								</span>
								<span className="harness-picker-selection" aria-hidden="true">
									{selected === engine.id && <CheckIcon />}
								</span>
							</Radio.Root>
						)
					},
				)}
			</RadioGroup>
		</div>
	)
}

export type EngineSurface = 'desktop' | 'cli'

/** The switch's state and what it may do, as the composer hands it down. */
export interface EngineSurfaceControl {
	value: EngineSurface
	onChange: (value: EngineSurface) => void
	disabled: boolean
	/** Why the switch is unavailable, when it is. */
	reason?: string
}

/**
 * "Desktop | CLI": where the chosen engine runs. Desktop is the conversation in this window; CLI opens
 * the engine's own command line in a terminal tab with the composer's choices.
 */
export function SurfaceSwitch({
	value,
	onChange,
	disabled = false,
	reason,
}: {
	value: EngineSurface
	onChange: (value: EngineSurface) => void
	disabled?: boolean
	/** Why the switch is unavailable, when it is. */
	reason?: string
}) {
	const choices: { id: EngineSurface; label: string }[] = [
		{ id: 'desktop', label: 'Desktop' },
		{ id: 'cli', label: 'CLI' },
	]
	return (
		<RadioGroup
			className="surface-switch"
			aria-label="Where this engine runs"
			title={reason}
			value={value}
			disabled={disabled}
			onValueChange={(next) => {
				if (next === 'desktop' || next === 'cli') onChange(next)
			}}
		>
			{choices.map((choice) => (
				<Radio.Root
					key={choice.id}
					value={choice.id}
					nativeButton
					render={<button type="button" />}
					data-selected={value === choice.id || undefined}
				>
					{choice.label}
				</Radio.Root>
			))}
		</RadioGroup>
	)
}
