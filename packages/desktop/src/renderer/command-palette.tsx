/* Command surface adapted from the user's local design-system composition. */
import { Autocomplete } from '@base-ui/react/autocomplete'
import { Dialog } from '@base-ui/react/dialog'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { matchesCommandQuery, matchesCommandShortcut } from './command-palette-filter.js'
import './command-palette.css'

export interface CommandPaletteItem {
	id: string
	label: string
	group: string
	keywords?: readonly string[]
	icon?: ReactNode
	meta?: string
	/** Chords work while open; the application registers global shortcuts. */
	shortcut?: readonly string[]
	disabled?: boolean
	onAction: () => void
}

export interface CommandPaletteProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	items: readonly CommandPaletteItem[]
	triggerRef?: RefObject<HTMLElement | null>
	loading?: boolean
	notice?: string
	onRetry?: () => void
}

export function CommandPalette({
	open,
	onOpenChange,
	items,
	triggerRef,
	loading,
	notice,
	onRetry,
}: CommandPaletteProps) {
	const input = useRef<HTMLInputElement>(null)
	const invoked = useRef(false)
	useEffect(() => {
		if (open) invoked.current = false
	}, [open])
	const run = (item: CommandPaletteItem) => {
		if (item.disabled) return
		invoked.current = true
		onOpenChange(false)
		item.onAction()
	}
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className="command-palette-backdrop" />
				<Dialog.Viewport className="command-palette-viewport">
					<Dialog.Popup
						className="command-palette-popup"
						initialFocus={input}
						finalFocus={() => (invoked.current ? false : (triggerRef?.current ?? true))}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing || event.keyCode === 229) return
							const item = items.find((item) => matchesCommandShortcut(item.shortcut, event))
							if (!item) return
							event.preventDefault()
							event.stopPropagation()
							run(item)
						}}
					>
						<Dialog.Title className="command-palette-accessible">
							Search chats and actions
						</Dialog.Title>
						<Dialog.Close className="command-palette-accessible" tabIndex={-1}>
							Close search
						</Dialog.Close>
						<CommandResults
							items={items}
							inputRef={input}
							loading={loading}
							notice={notice}
							onRetry={onRetry}
							onRun={run}
						/>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

function CommandResults({
	items,
	inputRef,
	loading,
	notice,
	onRetry,
	onRun,
}: {
	items: readonly CommandPaletteItem[]
	inputRef: RefObject<HTMLInputElement | null>
	loading?: boolean
	notice?: string
	onRetry?: () => void
	onRun: (item: CommandPaletteItem) => void
}) {
	const [query, setQuery] = useState('')
	const { contains } = Autocomplete.useFilter({ sensitivity: 'base' })
	const groups = new Map<string, CommandPaletteItem[]>()
	for (const item of items) {
		const members = groups.get(item.group)
		if (members) members.push(item)
		else groups.set(item.group, [item])
	}
	const grouped = [...groups].map(([label, members]) => ({ label, items: members }))
	return (
		<Autocomplete.Root
			inline
			open
			items={grouped}
			value={query}
			onValueChange={setQuery}
			itemToStringValue={(item: CommandPaletteItem) => item.label}
			filter={(item: CommandPaletteItem, value) => matchesCommandQuery(item, value, contains)}
			autoHighlight="always"
			keepHighlight
			loopFocus={false}
		>
			<div className="command-palette-search">
				<Autocomplete.Input
					ref={inputRef}
					className="command-palette-input"
					aria-label="Search chats"
					placeholder="Search chats"
					autoComplete="off"
					spellCheck={false}
					onKeyDown={(event) => {
						// Let input methods commit text without selecting a command or
						// dismissing the enclosing modal.
						if (event.nativeEvent.isComposing || event.keyCode === 229) {
							event.preventBaseUIHandler()
							event.stopPropagation()
						} else if (event.key === 'Home' || event.key === 'End') {
							// These keys edit the focused text field, including Shift and
							// platform modifiers. Keep the browser's default selection.
							event.preventBaseUIHandler()
							event.stopPropagation()
						}
					}}
				/>
			</div>
			<Autocomplete.List className="command-palette-list" aria-label="Chats and quick actions">
				{(group: { label: string; items: readonly CommandPaletteItem[] }) => (
					<Autocomplete.Group
						key={group.label}
						items={group.items}
						className="command-palette-group"
					>
						<Autocomplete.GroupLabel className="command-palette-group-label">
							{group.label}
						</Autocomplete.GroupLabel>
						<Autocomplete.Collection>
							{(item: CommandPaletteItem) => (
								<Autocomplete.Item
									key={item.id}
									value={item}
									disabled={item.disabled}
									className="command-palette-item"
									data-command-id={item.id}
									aria-label={item.label}
									onClick={() => onRun(item)}
								>
									<span className="command-palette-icon" aria-hidden="true">
										{item.icon}
									</span>
									<span className="command-palette-label">{item.label}</span>
									{item.meta && <span className="command-palette-meta">{item.meta}</span>}
									{item.shortcut?.length ? (
										<span className="command-palette-shortcut" aria-hidden="true">
											{item.shortcut.map((key, index) => (
												<kbd key={`${index}:${key}`}>{key}</kbd>
											))}
										</span>
									) : null}
								</Autocomplete.Item>
							)}
						</Autocomplete.Collection>
					</Autocomplete.Group>
				)}
			</Autocomplete.List>
			<Autocomplete.Empty className="command-palette-empty">
				{loading ? 'Loading conversations…' : 'No matching chats or actions.'}
			</Autocomplete.Empty>
			{loading || notice ? (
				<div className="command-palette-status">
					<output>{loading ? 'Loading conversations…' : notice}</output>
					{!loading && notice && onRetry ? (
						<button type="button" onClick={onRetry}>
							Retry
						</button>
					) : null}
				</div>
			) : null}
		</Autocomplete.Root>
	)
}
