import { Menu } from '@base-ui/react/menu'
import { useEffect, useState } from 'react'
import type { DesktopApi } from '../../shared/protocol.js'
import '../conversation-actions-menu.css'
import { ChevronDownIcon, FolderIcon, TerminalIcon } from '../icons.js'
import { Button } from '../ui/button.js'
import { CodeIcon, VsCodeIcon } from './file-icons.js'

export type Editor = { id: 'vscode' | 'cursor'; label: string }
export type OpenTarget = 'editor' | 'file-manager' | 'terminal'

const found = new WeakMap<object, Promise<Editor[]>>()
const MAX_ATTEMPTS = 3
const RETRY_MS = 1000

/**
 * Editors on this machine, asked once per window and remembered; empty while unknown or when
 * there are none. A failed ask is not remembered, and is repeated a few times, because a pane's
 * bridge can refuse a call made in its very first moments.
 */
export function useEditors(api: DesktopApi, wanted = true): Editor[] {
	const [editors, setEditors] = useState<Editor[]>([])
	const [attempt, setAttempt] = useState(0)
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt asks again.
	useEffect(() => {
		if (!wanted || !api.projectEditors) return
		let current = true
		let timer: ReturnType<typeof setTimeout> | undefined
		let pending = found.get(api)
		if (!pending) {
			pending = api.projectEditors()
			found.set(api, pending)
		}
		pending.then(
			(value) => current && setEditors(value),
			() => {
				found.delete(api)
				if (current && attempt + 1 < MAX_ATTEMPTS)
					timer = setTimeout(() => setAttempt(attempt + 1), RETRY_MS)
			},
		)
		return () => {
			current = false
			clearTimeout(timer)
		}
	}, [api, wanted, attempt])
	return editors
}

/** What the menus offer. The host opens the first editor it found, so only that one is named. */
export function openInEntries(editors: readonly Editor[]): { target: OpenTarget; label: string }[] {
	const [editor] = editors
	return [
		...(editor ? [{ target: 'editor' as const, label: `Open in ${editor.label}` }] : []),
		{ target: 'file-manager', label: 'Show in folder' },
		{ target: 'terminal', label: 'Open terminal here' },
	]
}

export function EditorIcon({ editor }: { editor?: Editor }) {
	return editor?.id === 'vscode' ? (
		<VsCodeIcon className="size-4" />
	) : (
		<CodeIcon className="size-4" />
	)
}

const TARGET_ICON = {
	editor: CodeIcon,
	'file-manager': FolderIcon,
	terminal: TerminalIcon,
} as const

/** "Open" with the editor mark opens the file there; the arrow lists the other places. */
export function OpenInButton({
	editors,
	onOpen,
}: {
	editors: readonly Editor[]
	onOpen: (target: OpenTarget) => void
}) {
	const [editor] = editors
	const entries = openInEntries(editors)
	return (
		<div className="open-in" title="Open file">
			<Button
				type="button"
				variant="ghost"
				size="xs"
				className="open-in-main"
				disabled={!editor}
				title={editor ? `Open in ${editor.label}` : 'No editor was found on this computer.'}
				onClick={() => onOpen('editor')}
			>
				<EditorIcon editor={editor} />
				Open
			</Button>
			<Menu.Root>
				<Menu.Trigger
					render={<Button variant="ghost" size="icon-xs" className="open-in-more" />}
					aria-label="More ways to open"
				>
					<ChevronDownIcon className="size-3.5" aria-hidden="true" />
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner className="conversation-actions-positioner" align="end" sideOffset={6}>
						<Menu.Popup className="conversation-actions-popup" aria-label="Open file">
							{entries.map((entry) => {
								const Icon = TARGET_ICON[entry.target]
								return (
									<Menu.Item
										key={entry.target}
										className="conversation-actions-item"
										onClick={() => onOpen(entry.target)}
									>
										{entry.target === 'editor' ? (
											<EditorIcon editor={editor} />
										) : (
											<Icon aria-hidden="true" />
										)}
										<span className="conversation-actions-label">{entry.label}</span>
									</Menu.Item>
								)
							})}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		</div>
	)
}
