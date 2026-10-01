import type { ReasoningEffort } from '@namzu/sdk'
import { ComposerControl } from './composer-control.js'
import { ShieldQuestionIcon } from './icons.js'
import { Select, SelectItem, SelectPopup, SelectTrigger } from './ui/select.js'

export type ComposerPermissionMode = 'prompt' | 'accept-edits' | 'auto' | 'strict' | 'plan'

const permissionChoices: readonly {
	value: ComposerPermissionMode
	label: string
	description: string
}[] = [
	{ value: 'prompt', label: 'Ask first', description: 'Ask before changes and commands.' },
	{
		value: 'accept-edits',
		label: 'Allow edits',
		description: 'Allow file edits; ask before commands and other changes.',
	},
	{
		value: 'auto',
		label: 'Allow tools',
		description: 'Use tools without asking, within your configured rules.',
	},
	{
		value: 'strict',
		label: 'Preapproved only',
		description: 'Use preapproved tools; refuse other calls.',
	},
	{ value: 'plan', label: 'Plan', description: 'Read and plan; do not make changes.' },
]

function effortLabel(effort: ReasoningEffort): string {
	return {
		none: 'None',
		minimal: 'Minimal',
		low: 'Low',
		medium: 'Medium',
		high: 'High',
		xhigh: 'Extra high',
		max: 'Max',
		ultra: 'Ultra',
	}[effort]
}

/** Controlled per-conversation settings. The host snapshots these with each accepted message. */
export function ComposerSettings({
	effortLevels,
	effortDefault,
	effort,
	permissionMode,
	disabled,
	onEffortChange,
	onPermissionModeChange,
}: {
	effortLevels?: readonly ReasoningEffort[]
	effortDefault?: ReasoningEffort
	effort?: ReasoningEffort
	permissionMode: ComposerPermissionMode
	disabled: boolean
	onEffortChange: (effort: ReasoningEffort | undefined) => void
	onPermissionModeChange: (mode: ComposerPermissionMode) => void
}) {
	const selectedMode =
		permissionChoices.find(({ value }) => value === permissionMode) ?? permissionChoices[0]
	return (
		<>
			{effort && !effortLevels?.includes(effort) && (
				<ComposerControl
					disabled={disabled}
					onClick={() => onEffortChange(undefined)}
					aria-label="Reset reasoning effort"
				>
					Reset {effortLabel(effort)} effort
				</ComposerControl>
			)}
			{effortLevels && effortLevels.length > 0 && (
				<Select
					value={effort && effortLevels.includes(effort) ? effort : 'provider-default'}
					disabled={disabled}
					onValueChange={(value) => {
						if (value === 'provider-default') onEffortChange(undefined)
						else if (effortLevels.includes(value as ReasoningEffort))
							onEffortChange(value as ReasoningEffort)
					}}
				>
					<SelectTrigger
						render={<ComposerControl />}
						variant="ghost"
						size="sm"
						aria-label="Reasoning effort"
					>
						{effort && effortLevels.includes(effort) ? effortLabel(effort) : 'Default effort'}
					</SelectTrigger>
					<SelectPopup
						side="top"
						alignItemWithTrigger={false}
						matchTriggerWidth={false}
						className="min-w-44"
					>
						<SelectItem value="provider-default">
							{effortDefault ? `Default · ${effortLabel(effortDefault)}` : 'Provider default'}
						</SelectItem>
						{effortLevels.map((level) => (
							<SelectItem key={level} value={level}>
								{effortLabel(level)}
							</SelectItem>
						))}
					</SelectPopup>
				</Select>
			)}
			<Select
				value={permissionMode}
				disabled={disabled}
				onValueChange={(value) => {
					const selected = permissionChoices.find((choice) => choice.value === value)
					if (selected) onPermissionModeChange(selected.value)
				}}
			>
				<SelectTrigger
					render={<ComposerControl />}
					variant="ghost"
					size="sm"
					aria-label="Tool permissions"
					title={selectedMode?.description}
				>
					<ShieldQuestionIcon className="size-4" />
					{selectedMode?.label}
				</SelectTrigger>
				<SelectPopup
					side="top"
					alignItemWithTrigger={false}
					matchTriggerWidth={false}
					className="w-72"
				>
					{permissionChoices.map(({ value, label, description }) => (
						<SelectItem key={value} value={value}>
							<span className="block">{label}</span>
							<span className="block whitespace-normal text-xs text-muted-foreground">
								{description}
							</span>
						</SelectItem>
					))}
				</SelectPopup>
			</Select>
		</>
	)
}
