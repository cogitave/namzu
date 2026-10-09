import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { ChevronDown, ChevronLeft } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { HarnessView } from '../shared/protocol.js'
import { copyPlainText } from './copy-button.js'
import { type ExternalEngine, engineSetup, setupPlatform } from './engine-setup.js'
import { engineUpdateNote } from './engine-updates-model.js'
import { CheckIcon, ProviderIcons } from './icons.js'
import { Wordmark } from './wordmark.js'
import './harness-picker.css'
import { commitsOnKey } from './picker-commit.js'
import { Button } from './ui/button.js'
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

/** A command a person copies into a terminal, with its Copy button. */
export function CopyableCommand({ command, label }: { command: string; label: string }) {
	const [copied, setCopied] = useState(false)
	return (
		<div className="engine-command">
			<span className="engine-command-label">{label}</span>
			<div className="engine-command-line">
				<code>{command}</code>
				<Button
					size="xs"
					variant="outline"
					aria-label={`Copy: ${command}`}
					onClick={() => {
						void copyPlainText(command)
							.then(() => setCopied(true))
							.catch(() => setCopied(false))
					}}
				>
					{copied ? 'Copied' : 'Copy'}
				</Button>
			</div>
		</div>
	)
}

/** What to do about an engine that is not on this computer: the commands, and a way to look again. */
export function EngineInstallHelp({
	engine,
	platform,
	onRecheck,
}: {
	engine: ExternalEngine
	platform: ReturnType<typeof setupPlatform>
	/** Looks for the program again; resolves once the list of engines has been read. */
	onRecheck?: () => Promise<void>
}) {
	const setup = engineSetup(engine, platform)
	const [state, setState] = useState<'idle' | 'checking' | 'missing'>('idle')
	const root = useRef<HTMLDivElement>(null)
	// The steps open at the foot of a scrolling list: bring them, Check again included, into view.
	useEffect(() => {
		root.current?.scrollIntoView?.({ block: 'nearest' })
	}, [])
	return (
		<div className="engine-install-help" ref={root}>
			<p>
				{setup.name} is not installed on this computer. Install it in a terminal, then check again.
			</p>
			{setup.install.map((item) => (
				<CopyableCommand key={item.command} command={item.command} label={item.label} />
			))}
			{onRecheck && (
				<div className="engine-install-actions">
					<Button
						size="xs"
						variant="outline"
						disabled={state === 'checking'}
						onClick={() => {
							setState('checking')
							void onRecheck()
								.then(() => setState('missing'))
								.catch(() => setState('missing'))
						}}
					>
						{state === 'checking' ? 'Checking…' : 'Check again'}
					</Button>
					<output className="engine-install-result">
						{state === 'missing' ? 'Still not found. Finish the install, then check again.' : ''}
					</output>
				</div>
			)}
		</div>
	)
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
			{/* The Namzu mark is its own name; another engine's logo gets its name beside it. */}
			{engine !== 'namzu' && <span className="engine-chip-label">{label}</span>}
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
	onRecheck,
}: {
	view?: HarnessView
	selectedEngine?: HarnessView['selected']
	/** Where Back leads: the view the engine view was opened from. */
	backLabel: 'Effort' | 'Models'
	busy: boolean
	disabled: boolean
	onBack: () => void
	onSelect: (engine: HarnessView['selected']) => void
	/** Reads the list of engines again, so a program installed since is picked up. */
	onRecheck?: () => Promise<void>
}) {
	const selected = view?.selected ?? selectedEngine ?? 'namzu'
	const helpId = useId()
	const [helpFor, setHelpFor] = useState<ExternalEngine>()
	const platform = setupPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent)
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
						const id = engine.id
						if (!engine.available && id !== 'namzu') {
							const open = helpFor === id
							return (
								<div key={engine.id} className="harness-picker-setup">
									<button
										type="button"
										className="harness-picker-row"
										aria-expanded={open}
										aria-controls={`${helpId}-${engine.id}`}
										onClick={() => setHelpFor(open ? undefined : id)}
									>
										<HarnessMark engine={engine.id} />
										<span className="harness-picker-name">
											<span>{engine.label}</span>
											<small>Not installed</small>
										</span>
										<span className="harness-picker-howto">
											How to install
											<ChevronDown aria-hidden="true" data-open={open || undefined} />
										</span>
									</button>
									{open && (
										<div id={`${helpId}-${engine.id}`}>
											<EngineInstallHelp engine={id} platform={platform} onRecheck={onRecheck} />
										</div>
									)}
								</div>
							)
						}
						return (
							<Radio.Root
								key={engine.id}
								value={engine.id}
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

/** What the switch means, in one short line that follows the side in force. */
export function surfaceCaption(value: EngineSurface): string {
	return value === 'cli'
		? 'CLI: sending opens this engine in a terminal tab.'
		: 'Desktop: you chat with this engine in this window.'
}

export function SurfaceCaption({ value }: { value: EngineSurface }) {
	return <p className="surface-caption">{surfaceCaption(value)}</p>
}
