import { AlertDialog } from '@base-ui/react/alert-dialog'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { ComposerControl } from './composer-control.js'
import {
	CheckIcon,
	FilePenIcon,
	HandIcon,
	type IconComponent,
	ListChecksIcon,
	ShieldCheckIcon,
	TriangleAlertIcon,
} from './icons.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from './ui/popover.js'
import './composer-settings.css'

export type ComposerPermissionMode = 'prompt' | 'accept-edits' | 'auto' | 'strict' | 'plan'
export type ComposerPermissionEngine = 'namzu' | 'codex-cli' | 'claude-code'
type PermissionConfirmation = {
	engine: ComposerPermissionEngine
	scope?: string
	mode: ComposerPermissionMode
}

export type PermissionRow = {
	value: ComposerPermissionMode
	label: string
	description: string
	icon: IconComponent
	/** Full access reads as a warning in the chip and in the menu. */
	warning: boolean
	/** Saved by an older version or another engine; shown, never offered as a new choice. */
	selectable: boolean
}

const engineNames: Record<ComposerPermissionEngine, string> = {
	namzu: 'Namzu',
	'codex-cli': 'Codex',
	'claude-code': 'Claude Code',
}

export function permissionMenuTitle(engine: ComposerPermissionEngine): string {
	return `When should ${engineNames[engine]} check with you?`
}

type RowCopy = { label: string; description: string }
const rowCopy: Record<
	ComposerPermissionMode,
	Record<ComposerPermissionEngine, RowCopy | undefined>
> = {
	prompt: {
		namzu: { label: 'Ask first', description: 'Asks before changing files or running commands.' },
		'codex-cli': {
			label: 'Ask first',
			description: 'Starts read-only and asks before commands or file changes.',
		},
		'claude-code': {
			label: 'Ask first',
			description: 'Asks before editing files or running commands.',
		},
	},
	'accept-edits': {
		namzu: {
			label: 'Edit automatically',
			description: 'Edits files on its own and asks before commands.',
		},
		'codex-cli': {
			label: 'Edit automatically',
			description: 'Edits files in this project on its own; asks before commands. No internet.',
		},
		'claude-code': undefined,
	},
	auto: {
		namzu: {
			label: 'Full access',
			description: 'Uses tools without asking, except what your rules block.',
		},
		'codex-cli': {
			label: 'Full access',
			description: 'Works anywhere on this computer and online without asking.',
		},
		'claude-code': undefined,
	},
	plan: {
		namzu: { label: 'Plan only', description: 'Reads and plans; changes nothing.' },
		'codex-cli': { label: 'Read only', description: 'Reads files; changes nothing.' },
		'claude-code': { label: 'Plan only', description: 'Reads and plans; changes nothing.' },
	},
	strict: {
		namzu: { label: 'Preapproved only', description: 'Uses only tools your rules allow.' },
		'codex-cli': { label: 'Preapproved only', description: 'Uses only tools your rules allow.' },
		'claude-code': { label: 'Preapproved only', description: 'Uses only tools your rules allow.' },
	},
}

const rowIcon: Record<ComposerPermissionMode, IconComponent> = {
	prompt: HandIcon,
	'accept-edits': FilePenIcon,
	auto: TriangleAlertIcon,
	plan: ListChecksIcon,
	strict: ShieldCheckIcon,
}

// Order the menu shows; strict is never part of it unless it is the saved mode.
const menuOrder: readonly ComposerPermissionMode[] = ['prompt', 'accept-edits', 'auto', 'plan']

/** The modes an engine offers when its capabilities do not say otherwise. */
export function defaultPermissionModes(
	engine: ComposerPermissionEngine,
): readonly ComposerPermissionMode[] {
	// Namzu and Codex run every mode (the main process accepts them all); the second external engine only two.
	return engine === 'claude-code'
		? ['prompt', 'plan']
		: ['prompt', 'accept-edits', 'auto', 'strict', 'plan']
}

/**
 * Rows for one engine. Support comes from `supportedModes` (the engine's capabilities);
 * a saved mode the engine no longer supports stays visible but cannot be picked again.
 */
export function permissionRows(
	engine: ComposerPermissionEngine,
	supportedModes: readonly ComposerPermissionMode[],
	saved: ComposerPermissionMode,
): PermissionRow[] {
	const modes = menuOrder.filter(
		(mode) => mode === saved || (supportedModes.includes(mode) && rowCopy[mode][engine]),
	)
	if (saved === 'strict') modes.push('strict')
	return modes.map((value) => {
		const copy = rowCopy[value][engine] ?? rowCopy[value].namzu
		return {
			value,
			label: copy?.label ?? value,
			description: copy?.description ?? '',
			icon: rowIcon[value],
			warning: value === 'auto',
			selectable: supportedModes.includes(value),
		}
	})
}

/** Arrow keys only move the highlight; Enter, Space or a click commits. */
function moveHighlight(event: KeyboardEvent<HTMLElement>) {
	const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
	if (!keys.includes(event.key)) return
	const items = [
		...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]'),
	].filter((item) => !item.disabled)
	if (items.length === 0) return
	event.preventDefault()
	event.stopPropagation()
	const at = items.indexOf(document.activeElement as HTMLButtonElement)
	const next =
		event.key === 'Home'
			? 0
			: event.key === 'End'
				? items.length - 1
				: event.key === 'ArrowDown'
					? (at + 1) % items.length
					: (at <= 0 ? items.length : at) - 1
	items[next]?.focus()
}

/** Permission chip and its menu. Shared by the footer and the Pal's "+" popover. */
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
	const menu = useRef<HTMLDivElement>(null)
	const [open, setOpen] = useState(false)
	const [confirmation, setConfirmation] = useState<PermissionConfirmation | null>(null)
	const pendingConfirmation = useRef<PermissionConfirmation | null>(null)
	const supportedModes = reviewModes ?? defaultPermissionModes(engine)
	const supportsAuto = supportedModes.includes('auto')
	const authority = useRef({ engine, permissionScope, permissionMode, disabled, supportsAuto })
	authority.current = { engine, permissionScope, permissionMode, disabled, supportsAuto }
	const rows = permissionRows(engine, supportedModes, permissionMode)
	const selected = rows.find(({ value }) => value === permissionMode) ?? rows[0]
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
	useEffect(() => {
		if (disabled) setOpen(false)
	}, [disabled])
	const dismiss = () => {
		pendingConfirmation.current = null
		setConfirmation(null)
	}
	const choose = (row: PermissionRow) => {
		setOpen(false)
		if (disabled || !row.selectable || row.value === permissionMode) return
		if (engine === 'codex-cli' && row.value === 'auto') {
			// Codex full access reaches beyond the project, so it needs an explicit yes.
			const request = { engine, scope: permissionScope, mode: permissionMode }
			pendingConfirmation.current = request
			setConfirmation(request)
			return
		}
		onChange(row.value)
	}
	const SelectedIcon = selected?.warning ? TriangleAlertIcon : (selected?.icon ?? HandIcon)
	return (
		<>
			<Popover open={open && !disabled} onOpenChange={setOpen}>
				<PopoverTrigger
					ref={trigger}
					render={<ComposerControl size="sm" disabled={disabled} />}
					aria-label={`Permissions: ${selected?.label ?? ''}`}
					data-composer-permission={permissionMode}
					className="composer-permission-control"
					title={selected?.description}
				>
					<SelectedIcon className="size-4" />
					<span className="truncate">{selected?.label}</span>
				</PopoverTrigger>
				<PopoverPopup
					side="top"
					align="start"
					sideOffset={8}
					padding="none"
					className="composer-permission-menu"
					initialFocus={() =>
						menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? true
					}
				>
					<div className="composer-permission-panel">
						<PopoverTitle className="composer-permission-title">
							{permissionMenuTitle(engine)}
						</PopoverTitle>
						<div
							ref={menu}
							role="menu"
							aria-label={permissionMenuTitle(engine)}
							onKeyDown={moveHighlight}
						>
							{rows.map((row) => {
								const Icon = row.icon
								return (
									<button
										key={row.value}
										type="button"
										role="menuitemradio"
										aria-checked={row.value === permissionMode}
										disabled={!row.selectable && row.value !== permissionMode}
										data-warning={row.warning || undefined}
										className="composer-permission-option"
										onClick={() => choose(row)}
									>
										<Icon className="composer-permission-icon" />
										<span className="composer-permission-copy">
											<span className="composer-permission-label">{row.label}</span>
											<span className="composer-permission-description">{row.description}</span>
										</span>
										<span className="composer-permission-check" aria-hidden="true">
											{row.value === permissionMode && <CheckIcon />}
										</span>
									</button>
								)
							})}
						</div>
					</div>
				</PopoverPopup>
			</Popover>
			<AlertDialog.Root
				open={currentConfirmation}
				onOpenChange={(next) => {
					if (!next) dismiss()
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
