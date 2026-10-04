import { AlertDialog } from '@base-ui/react/alert-dialog'
import type { ReasoningEffort } from '@namzu/sdk'
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { ComposerControl } from './composer-control.js'
import { CheckIcon, ChevronRightIcon, ShieldQuestionIcon } from './icons.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Select, SelectItem, SelectPopup, SelectTrigger } from './ui/select.js'
import './composer-settings.css'

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

const effortOrder: readonly ReasoningEffort[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
]

function stopEffortNavigation(event: KeyboardEvent) {
	if (
		event.key.startsWith('Arrow') ||
		event.key === 'Home' ||
		event.key === 'End' ||
		event.key === 'PageUp' ||
		event.key === 'PageDown' ||
		event.key === '/'
	)
		event.stopPropagation()
}

/** Model-scoped effort; late callbacks cannot modify a different model or conversation. */
export function ComposerEffort({
	scope,
	effortLevels,
	effortDefault,
	effort,
	disabled,
	onChange,
	positionerClassName,
}: {
	scope: string
	effortLevels?: readonly ReasoningEffort[]
	effortDefault?: ReasoningEffort
	effort?: ReasoningEffort
	disabled: boolean
	onChange: (effort: ReasoningEffort | undefined) => void
	positionerClassName?: string
}) {
	const [openFor, setOpenFor] = useState<{ scope: string; generation: number } | null>(null)
	const [narrow, setNarrow] = useState(false)
	const trigger = useRef<HTMLButtonElement>(null)
	const mounted = useRef(true)
	const authority = useRef({ scope, generation: 0, disabled, effortLevels, onChange })
	const generation =
		authority.current.scope === scope
			? authority.current.generation
			: authority.current.generation + 1
	authority.current = { scope, generation, disabled, effortLevels, onChange }
	useEffect(() => {
		mounted.current = true
		const media =
			typeof window !== 'undefined' ? window.matchMedia('(max-width: 600px)') : undefined
		const update = () => setNarrow(media?.matches ?? false)
		update()
		media?.addEventListener('change', update)
		return () => {
			mounted.current = false
			media?.removeEventListener('change', update)
		}
	}, [])
	useEffect(() => {
		if (disabled) setOpenFor(null)
	}, [disabled])
	const change = (value: ReasoningEffort | undefined) => {
		const current = authority.current
		if (
			!mounted.current ||
			current.scope !== scope ||
			current.generation !== generation ||
			current.disabled ||
			(value !== undefined && !current.effortLevels?.includes(value))
		)
			return
		current.onChange(value)
	}
	const levels = [...new Set(effortLevels ?? [])].sort(
		(left, right) => effortOrder.indexOf(left) - effortOrder.indexOf(right),
	)
	const knownDefault = effortDefault && levels.includes(effortDefault) ? effortDefault : undefined
	const defaultLabel = knownDefault ? `Default · ${effortLabel(knownDefault)}` : 'Provider default'
	const current = effort && levels.includes(effort) ? effort : knownDefault
	const index = current ? levels.indexOf(current) : undefined
	const valueLabel = current ? effortLabel(current) : 'Provider default'
	if (effort && !levels.includes(effort))
		return (
			<ComposerControl
				size="xs"
				disabled={disabled}
				onClick={() => change(undefined)}
				onKeyDown={stopEffortNavigation}
				aria-label="Reset reasoning effort"
				className="model-picker-effort-trigger model-picker-effort-reset"
			>
				Reset {effortLabel(effort)}
			</ComposerControl>
		)
	if (levels.length === 0) return null
	return (
		<Popover
			open={openFor?.scope === scope && openFor.generation === generation && !disabled}
			onOpenChange={(next) => setOpenFor(next ? { scope, generation } : null)}
		>
			<PopoverTrigger
				ref={trigger}
				render={<ComposerControl size="xs" disabled={disabled} />}
				aria-label="Reasoning effort"
				className="model-picker-effort-trigger"
				title={!effort ? defaultLabel : valueLabel}
				onKeyDown={stopEffortNavigation}
			>
				<span>{valueLabel}</span>
				<ChevronRightIcon aria-hidden="true" />
			</PopoverTrigger>
			<PopoverPopup
				side={narrow ? 'bottom' : 'right'}
				align={narrow ? 'end' : 'start'}
				sideOffset={8}
				padding="none"
				aria-label="Reasoning effort"
				className="model-picker-effort-popup"
				positionerClassName={positionerClassName}
				anchor={() =>
					narrow
						? trigger.current
						: (trigger.current?.closest('.model-picker-row-wrap') ?? trigger.current)
				}
			>
				<div
					className="model-picker-effort-panel"
					// Native range navigation must not select another model through
					// the parent radio group. Base UI handles Escape dismissal.
					onKeyDown={stopEffortNavigation}
				>
					<div className="model-picker-effort-heading">
						<span>Effort</span>
						<output className="model-picker-effort-value">{valueLabel}</output>
					</div>
					{index !== undefined ? (
						<>
							<div
								className="model-picker-effort-track"
								style={
									{
										'--effort-progress': `${levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0}%`,
									} as CSSProperties
								}
							>
								<div className="model-picker-effort-ticks" aria-hidden="true">
									{levels.map((level) => (
										<i key={level} />
									))}
								</div>
								<input
									type="range"
									min={0}
									max={levels.length - 1}
									step={1}
									value={index}
									disabled={disabled || levels.length === 1}
									aria-label="Reasoning effort"
									aria-valuetext={valueLabel}
									onChange={(event) => {
										const next = Number(event.currentTarget.value)
										if (
											event.currentTarget.value.trim() &&
											Number.isInteger(next) &&
											next >= 0 &&
											next < levels.length
										)
											change(levels[next])
									}}
								/>
							</div>
							<div className="model-picker-effort-scale" aria-hidden="true">
								<span>Faster</span>
								<span>Smarter</span>
							</div>
						</>
					) : (
						<div className="model-picker-effort-options" aria-label="Choose reasoning effort">
							{levels.map((level) => (
								<Button
									key={level}
									variant="ghost"
									size="xs"
									disabled={disabled}
									onClick={() => change(level)}
								>
									{effortLabel(level)}
								</Button>
							))}
						</div>
					)}
					<Button
						variant="ghost-muted"
						size="xs"
						className="model-picker-effort-default"
						disabled={disabled || effort === undefined}
						aria-label="Use model default effort"
						onClick={() => change(undefined)}
					>
						{defaultLabel}
					</Button>
				</div>
			</PopoverPopup>
		</Popover>
	)
}

/** Controlled per-conversation permissions in the Pal's message settings. */
export function ComposerSettings({
	permissionMode,
	disabled,
	onPermissionModeChange,
	reviewModes,
	engine,
	permissionScope,
}: {
	permissionMode: ComposerPermissionMode
	disabled: boolean
	onPermissionModeChange: (mode: ComposerPermissionMode) => void
	reviewModes?: readonly ComposerPermissionMode[]
	engine?: ComposerPermissionEngine
	permissionScope?: string
}) {
	return (
		<ComposerPermissions
			engine={engine}
			permissionScope={permissionScope}
			reviewModes={reviewModes}
			permissionMode={permissionMode}
			disabled={disabled}
			onChange={onPermissionModeChange}
		/>
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
					sideOffset={8}
					alignItemWithTrigger={false}
					matchTriggerWidth={false}
					className="composer-permission-menu"
				>
					{choices.map(({ value, label, description }) => (
						<SelectItem
							key={value}
							value={value}
							disabled={!supportedModes.includes(value)}
							className="composer-permission-option"
						>
							<span className="composer-permission-copy">
								<span className="composer-permission-label">{label}</span>
								<span className="composer-permission-description">{description}</span>
							</span>
							<span className="composer-permission-check" aria-hidden="true">
								{value === permissionMode && <CheckIcon />}
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
