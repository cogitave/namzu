import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { useState } from 'react'
import type { HarnessView } from '../shared/protocol.js'
import { ComposerControl, ComposerControlChevron } from './composer-control.js'
import { CheckIcon, LoaderCircleIcon, ProviderIcons } from './icons.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Wordmark } from './wordmark.js'
import './harness-picker.css'
import { commitsOnKey } from './picker-commit.js'

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

export function HarnessPicker({
	view,
	selectedEngine,
	busy,
	disabled,
	onSelect,
}: {
	view?: HarnessView
	selectedEngine?: HarnessView['selected']
	busy: boolean
	disabled: boolean
	onSelect: (engine: HarnessView['selected']) => void
}) {
	const [open, setOpen] = useState(false)
	const selected = view?.selected ?? selectedEngine ?? 'namzu'
	const label =
		view?.engines.find((engine) => engine.id === selected)?.label ??
		{ namzu: 'Namzu', 'codex-cli': 'Codex CLI', 'claude-code': 'Claude Code' }[selected]
	const commit = (value: string) => {
		const engine = committableEngine(view, value, { busy, disabled })
		if (!engine) return
		setOpen(false)
		onSelect(engine)
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={<ComposerControl size="xs" disabled={disabled || busy || !view} />}
				className="composer-harness-control"
				aria-label="Execution engine"
				title={label}
			>
				<HarnessMark engine={selected} />
				{selected !== 'namzu' && <span className="truncate">{label}</span>}
				{busy ? <LoaderCircleIcon className="size-3 animate-spin" /> : <ComposerControlChevron />}
			</PopoverTrigger>
			<PopoverPopup
				side="top"
				align="end"
				padding="compact"
				className="harness-picker-popup"
				aria-label="Execution engine"
			>
				<h2 className="harness-picker-title">Execution engine</h2>
				<RadioGroup
					className="harness-picker-list"
					aria-label="Available engines"
					value={selected}
					// Arrow keys only move focus; a choice is committed by click, Enter or Space (a native click).
					onValueChange={() => {}}
				>
					{(view?.engines ?? [{ id: 'namzu' as const, label: 'Namzu', available: true }]).map(
						(engine) => (
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
								{engine.id === 'namzu' ? (
									<span className="sr-only">Namzu</span>
								) : (
									<span>{engine.label}</span>
								)}
								{!engine.available && (
									<span className="harness-picker-unavailable">Not installed</span>
								)}
								<span className="harness-picker-selection" aria-hidden="true">
									{selected === engine.id && <CheckIcon />}
								</span>
							</Radio.Root>
						),
					)}
				</RadioGroup>
				{view?.locked && (
					<p className="harness-picker-notice">
						Choosing another engine opens a new conversation tab.
					</p>
				)}
			</PopoverPopup>
		</Popover>
	)
}
