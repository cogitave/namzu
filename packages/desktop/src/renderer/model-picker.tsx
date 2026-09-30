import { CheckIcon, ChevronDownIcon, CpuIcon } from 'lucide-react'
import { useState } from 'react'
import type { ProviderView } from '../shared/protocol.js'
import { Button } from './ui/button.js'
import { Input } from './ui/input.js'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from './ui/popover.js'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select.js'

export interface ModelChoice {
	provider: string
	model: string
}
export function ModelPicker({
	providers,
	choice,
	disabled,
	onChange,
}: {
	providers: ProviderView
	choice: ModelChoice
	disabled: boolean
	onChange: (choice: ModelChoice) => void
}) {
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState(choice)
	const provider = providers.available.find((item) => item.id === choice.provider)
	const model = choice.model || provider?.defaultModel || 'Select model'
	return (
		<Popover
			open={open}
			onOpenChange={(value) => {
				setOpen(value)
				if (value) setPending(choice)
			}}
		>
			<PopoverTrigger
				render={
					<Button
						variant="ghost-muted"
						size="sm"
						className="model-picker-trigger"
						disabled={disabled || providers.available.length === 0}
						aria-label="Select model"
					/>
				}
			>
				<CpuIcon />
				<span className="truncate">{model}</span>
				<ChevronDownIcon className="size-3" />
			</PopoverTrigger>
			<PopoverPopup side="top" align="start" width="md" className="model-picker-popup">
				<PopoverTitle>Choose a model</PopoverTitle>
				<form
					onSubmit={(event) => {
						event.preventDefault()
						onChange(pending)
						setOpen(false)
					}}
					className="mt-4 grid gap-4"
				>
					<div className="grid gap-1.5">
						<label className="text-xs text-muted-foreground" htmlFor="provider-choice">
							Provider
						</label>
						<Select
							value={pending.provider}
							onValueChange={(value) => {
								if (value)
									setPending({
										provider: value,
										model:
											providers.available.find((item) => item.id === value)?.defaultModel ?? '',
									})
							}}
						>
							<SelectTrigger id="provider-choice" aria-label="Provider">
								<SelectValue>
									{(value: string) =>
										providers.available.find((item) => item.id === value)?.label ?? value
									}
								</SelectValue>
							</SelectTrigger>
							<SelectPopup alignItemWithTrigger={false}>
								{providers.available.map((item) => (
									<SelectItem key={item.id} value={item.id}>
										{item.label}
									</SelectItem>
								))}
							</SelectPopup>
						</Select>
					</div>
					<div className="grid gap-1.5">
						<label className="text-xs text-muted-foreground" htmlFor="model-choice">
							Model
						</label>
						<Input
							nativeInput
							id="model-choice"
							aria-label="Model"
							value={pending.model}
							placeholder={
								providers.available.find((item) => item.id === pending.provider)?.defaultModel ??
								'Default model'
							}
							onChange={(event) => setPending({ ...pending, model: event.target.value })}
						/>
					</div>
					<p className="text-xs leading-relaxed text-muted-foreground">
						Uses your connected provider. The next message will use this model.
					</p>
					<Button type="submit" size="sm" disabled={!pending.provider}>
						<CheckIcon />
						Use model
					</Button>
				</form>
			</PopoverPopup>
		</Popover>
	)
}
