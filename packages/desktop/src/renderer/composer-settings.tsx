import { AlertDialog } from '@base-ui/react/alert-dialog'
import type { ReasoningEffort } from '@namzu/sdk'
import { useEffect, useRef, useState } from 'react'
import { ComposerControl } from './composer-control.js'
import { ShieldQuestionIcon } from './icons.js'
import { Button } from './ui/button.js'
import { Select, SelectItem, SelectPopup, SelectTrigger } from './ui/select.js'

export type ComposerPermissionMode = 'prompt' | 'accept-edits' | 'auto' | 'strict' | 'plan'
export type ComposerPermissionEngine = 'namzu' | 'codex-cli' | 'claude-code'
type PermissionConfirmation = {
	engine: ComposerPermissionEngine
	scope?: string
	mode: ComposerPermissionMode
}

const permissionChoices: readonly {
	value: ComposerPermissionMode
	label: string
	description: string
}[] = [
	{
		value: 'prompt',
		label: 'Ask first',
		description: 'Ask before changes and commands.',
	},
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
	{
		value: 'plan',
		label: 'Plan',
		description: 'Read and plan; do not make changes.',
	},
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
	showPermissions = true,
	reviewModes,
	engine,
	permissionScope,
}: {
	effortLevels?: readonly ReasoningEffort[]
	effortDefault?: ReasoningEffort
	effort?: ReasoningEffort
	permissionMode: ComposerPermissionMode
	disabled: boolean
	onEffortChange: (effort: ReasoningEffort | undefined) => void
	onPermissionModeChange: (mode: ComposerPermissionMode) => void
	showPermissions?: boolean
	reviewModes?: readonly ComposerPermissionMode[]
	engine?: ComposerPermissionEngine
	permissionScope?: string
}) {
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
			{showPermissions && (
				<ComposerPermissions
					engine={engine}
					permissionScope={permissionScope}
					reviewModes={reviewModes}
					permissionMode={permissionMode}
					disabled={disabled}
					onChange={onPermissionModeChange}
				/>
			)}
		</>
	)
}

/** Uses the same controlled permission policy in the footer and message settings. */
export function ComposerPermissions({
	reviewModes,
	permissionMode,
	disabled,
	onChange,
	engine = 'namzu',
	permissionScope,
}: {
	reviewModes?: readonly ComposerPermissionMode[]
	permissionMode: ComposerPermissionMode
	disabled: boolean
	onChange: (mode: ComposerPermissionMode) => void
	engine?: ComposerPermissionEngine
	permissionScope?: string
}) {
	const trigger = useRef<HTMLButtonElement>(null)
	const cancel = useRef<HTMLButtonElement>(null)
	const [confirmation, setConfirmation] = useState<PermissionConfirmation | null>(null)
	const pendingConfirmation = useRef<PermissionConfirmation | null>(null)
	const supportedModes =
		reviewModes ?? (engine === 'claude-code' ? ['prompt', 'plan'] : ['prompt', 'auto', 'plan'])
	const supportsAuto = supportedModes.includes('auto')
	const authority = useRef({ engine, permissionScope, permissionMode, disabled, supportsAuto })
	authority.current = { engine, permissionScope, permissionMode, disabled, supportsAuto }
	const choices = permissionChoices
		.filter(
			({ value }) =>
				value === permissionMode ||
				(supportedModes.includes(value) &&
					(value === 'prompt' || value === 'auto' || value === 'plan')),
		)
		.map((choice) =>
			engine === 'codex-cli' && choice.value === 'auto'
				? {
						...choice,
						label: 'Full access',
						description:
							'Access files across this computer, run commands and use the network without asking.',
					}
				: engine === 'codex-cli' && choice.value === 'strict'
					? {
							...choice,
							label: 'Read-only, no approvals',
							description: 'Use native read-only access; refuse actions that require approval.',
						}
					: engine === 'codex-cli' && choice.value === 'prompt'
						? {
								...choice,
								description: 'Review commands and file changes; starts with read-only access.',
							}
						: choice,
		)
	const selectedMode = choices.find(({ value }) => value === permissionMode) ?? permissionChoices[0]
	const currentConfirmation = Boolean(
		confirmation &&
			confirmation.engine === engine &&
			confirmation.scope === permissionScope &&
			confirmation.mode === permissionMode &&
			engine === 'codex-cli' &&
			!disabled &&
			supportsAuto,
	)
	useEffect(() => {
		if (confirmation && !currentConfirmation && pendingConfirmation.current === confirmation) {
			pendingConfirmation.current = null
			setConfirmation(null)
		}
	}, [confirmation, currentConfirmation])
	const dismiss = () => {
		pendingConfirmation.current = null
		setConfirmation(null)
	}
	return (
		<>
			<Select
				value={permissionMode}
				disabled={disabled}
				onValueChange={(value) => {
					const selected = choices.find((choice) => choice.value === value)
					if (
						!selected ||
						disabled ||
						!supportedModes.includes(selected.value) ||
						selected.value === permissionMode
					)
						return
					if (engine === 'codex-cli' && selected.value === 'auto') {
						const request = { engine, scope: permissionScope, mode: permissionMode }
						pendingConfirmation.current = request
						setConfirmation(request)
						return
					}
					onChange(selected.value)
				}}
			>
				<SelectTrigger
					ref={trigger}
					render={<ComposerControl />}
					variant="ghost"
					size="sm"
					aria-label="Tool permissions"
					data-composer-permission={permissionMode}
					className="composer-permission-control"
					title={selectedMode?.description}
				>
					<ShieldQuestionIcon className="size-4" />
					<span className="truncate">{selectedMode?.label}</span>
				</SelectTrigger>
				<SelectPopup
					side="top"
					alignItemWithTrigger={false}
					matchTriggerWidth={false}
					className="w-72"
				>
					{choices.map(({ value, label, description }) => (
						<SelectItem key={value} value={value} disabled={!supportedModes.includes(value)}>
							<span className="block">{label}</span>
							<span className="block whitespace-normal text-xs text-muted-foreground">
								{description}
							</span>
						</SelectItem>
					))}
				</SelectPopup>
			</Select>
			<AlertDialog.Root
				open={currentConfirmation}
				onOpenChange={(open) => {
					if (!open) dismiss()
				}}
			>
				<AlertDialog.Portal>
					<AlertDialog.Backdrop className="fixed inset-0 z-[160] bg-black/50" />
					<AlertDialog.Viewport className="fixed inset-0 z-[161] grid place-items-center overflow-y-auto p-4">
						<AlertDialog.Popup
							initialFocus={cancel}
							finalFocus={trigger}
							className="w-full max-w-md rounded-2xl border border-border bg-background p-5 text-foreground shadow-xl outline-none"
						>
							<AlertDialog.Title className="text-lg font-semibold">
								Allow Codex full access?
							</AlertDialog.Title>
							<AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
								Codex CLI can access files across this computer, run commands and use the network
								without asking for approval. Access is not restricted to this project. This choice
								applies only to this conversation.
							</AlertDialog.Description>
							<div className="mt-5 flex flex-wrap justify-end gap-2">
								<AlertDialog.Close
									render={<Button ref={cancel} variant="outline" />}
									onClick={dismiss}
								>
									Keep current permissions
								</AlertDialog.Close>
								<Button
									variant="destructive"
									disabled={!currentConfirmation}
									onClick={() => {
										const now = authority.current
										if (
											!currentConfirmation ||
											pendingConfirmation.current !== confirmation ||
											now.engine !== confirmation?.engine ||
											now.permissionScope !== confirmation?.scope ||
											now.permissionMode !== confirmation?.mode ||
											now.disabled ||
											!now.supportsAuto
										)
											return
										dismiss()
										onChange('auto')
									}}
								>
									Enable full access
								</Button>
							</div>
						</AlertDialog.Popup>
					</AlertDialog.Viewport>
				</AlertDialog.Portal>
			</AlertDialog.Root>
		</>
	)
}
