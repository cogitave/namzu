import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { useState } from 'react'
import type { HarnessView } from '../shared/protocol.js'
import { ComposerControl, ComposerControlChevron } from './composer-control.js'
import { CheckIcon, LoaderCircleIcon, ProviderIcons } from './icons.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Wordmark } from './wordmark.js'

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

export function HarnessPicker({
	view,
	busy,
	disabled,
	onSelect,
}: {
	view?: HarnessView
	busy: boolean
	disabled: boolean
	onSelect: (engine: HarnessView['selected']) => void
}) {
	const [open, setOpen] = useState(false)
	const selected = view?.selected ?? 'namzu'
	const label = view?.engines.find((engine) => engine.id === selected)?.label ?? 'Namzu'
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={<ComposerControl size="xs" disabled={disabled || busy} />}
				className="composer-harness-control"
				aria-label="Execution engine"
				title={label}
			>
				<HarnessMark engine={selected} />
				{selected !== 'namzu' && <span className="truncate">{label}</span>}
				{busy ? <LoaderCircleIcon className="size-3 animate-spin" /> : <ComposerControlChevron />}
			</PopoverTrigger>
			<PopoverPopup side="top" align="end" width="md" aria-label="Execution engine">
				<h2 className="text-sm font-medium">Execution engine</h2>
				<RadioGroup
					className="mt-2 grid gap-1"
					aria-label="Available engines"
					value={selected}
					onValueChange={(value) => {
						if (
							!view?.engines.some((engine) => engine.id === value && engine.available) ||
							busy ||
							disabled
						)
							return
						setOpen(false)
						onSelect(value as HarnessView['selected'])
					}}
				>
					{(view?.engines ?? [{ id: 'namzu' as const, label: 'Namzu', available: true }]).map(
						(engine) => (
							<Radio.Root
								key={engine.id}
								value={engine.id}
								disabled={!engine.available}
								className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm hover:bg-muted disabled:opacity-50"
							>
								<HarnessMark engine={engine.id} />
								{engine.id === 'namzu' ? (
									<span className="sr-only">Namzu</span>
								) : (
									<span>{engine.label}</span>
								)}
								{!engine.available && (
									<span className="ml-auto text-xs text-muted-foreground">Not installed</span>
								)}
								{selected === engine.id && <CheckIcon className="ml-auto size-4" />}
							</Radio.Root>
						),
					)}
				</RadioGroup>
				{view?.locked && (
					<p className="mt-2 text-xs text-muted-foreground">
						Choosing another engine opens a new conversation tab.
					</p>
				)}
			</PopoverPopup>
		</Popover>
	)
}
