import {
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useLayoutEffect,
	useRef,
} from 'react'
import { FileDiffIcon, PlusIcon, TerminalIcon, XIcon } from '../icons.js'
import { Button } from '../ui/button.js'
import { FileIcon } from './file-icons.js'
import type { FileTabsState } from './file-tabs.js'
import { baseNameOf } from './project-refs.js'

export type PanelView = 'changes' | 'jobs' | 'file' | 'browse'

/** Changes and Activity first, then one tab per open file, then "+" for quick open. */
export function PanelTabStrip({
	view,
	files,
	canBrowse,
	onChanges,
	onJobs,
	onFile,
	onCloseFile,
	onBrowse,
	panelId,
}: {
	/** The element id of the body this strip switches, for aria-controls. */
	panelId?: string
	view: PanelView
	files: FileTabsState
	canBrowse: boolean
	onChanges: () => void
	onJobs: () => void
	onFile: (path: string) => void
	onCloseFile: (path: string) => void
	onBrowse: () => void
}) {
	const strip = useRef<HTMLDivElement>(null)
	const activeFile = view === 'file' ? files.active : undefined
	// A tab opened or chosen out of sight must come into view, or nothing says it opened.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these changes are what bring a tab into view.
	useLayoutEffect(() => {
		const tab = strip.current?.querySelector<HTMLElement>('.panel-file-tab[data-active]')
		tab?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
	}, [activeFile, files.paths.length])
	// One tab stop for the whole strip; the arrow keys move between tabs, as in a tab list.
	const roving = (event: KeyboardEvent<HTMLDivElement>) => {
		const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
		if (!keys.includes(event.key)) return
		const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
		const at = tabs.findIndex((tab) => tab === document.activeElement)
		if (at < 0) return
		event.preventDefault()
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? tabs.length - 1
					: (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
		tabs[next]?.focus()
		tabs[next]?.click()
	}
	const stop = (selected: boolean) => (selected ? 0 : -1)
	return (
		// biome-ignore lint/a11y/useSemanticElements: a tab list has no native element.
		<div
			ref={strip}
			className="panel-tab-strip"
			role="tablist"
			aria-label="Side panel"
			onKeyDown={roving}
		>
			<div className="panel-tab-scroll">
				<Button
					size="xs"
					variant="ghost-muted"
					role="tab"
					aria-selected={view === 'changes'}
					aria-controls={panelId}
					tabIndex={stop(view === 'changes')}
					data-active={view === 'changes' || undefined}
					onClick={onChanges}
				>
					<FileDiffIcon className="size-3.5" />
					Changes
				</Button>
				<Button
					size="xs"
					variant="ghost-muted"
					role="tab"
					aria-selected={view === 'jobs'}
					aria-controls={panelId}
					tabIndex={stop(view === 'jobs')}
					data-active={view === 'jobs' || undefined}
					onClick={onJobs}
				>
					<TerminalIcon className="size-3.5" />
					Activity
				</Button>
				{files.paths.map((path) => {
					const active = view === 'file' && files.active === path
					const name = baseNameOf(path)
					return (
						// The tab is the name button; the close button sits beside it, never inside a tab.
						<div
							key={path}
							className="panel-file-tab"
							role="presentation"
							data-active={active || undefined}
							title={path}
							// A middle click closes, as in a browser; mousedown would otherwise start autoscroll.
							onMouseDown={(event) => event.button === 1 && event.preventDefault()}
							onAuxClick={(event) => {
								if (event.button !== 1) return
								event.preventDefault()
								onCloseFile(path)
							}}
						>
							<button
								type="button"
								role="tab"
								aria-selected={active}
								aria-controls={panelId}
								tabIndex={stop(active)}
								className="panel-file-tab-name"
								onClick={() => onFile(path)}
							>
								<FileIcon aria-hidden="true" />
								<span>{name}</span>
							</button>
							<button
								type="button"
								className="panel-file-tab-close"
								aria-label={`Close ${name}`}
								onClick={() => onCloseFile(path)}
							>
								<XIcon aria-hidden="true" />
							</button>
						</div>
					)
				})}
			</div>
			{canBrowse && (
				<Button
					size="icon-xs"
					variant="ghost-muted"
					role="tab"
					aria-selected={view === 'browse'}
					aria-controls={panelId}
					tabIndex={stop(view === 'browse')}
					aria-label="Open a file"
					title="Open a file"
					data-active={view === 'browse' || undefined}
					onClick={onBrowse}
				>
					<PlusIcon aria-hidden="true" />
				</Button>
			)}
		</div>
	)
}

/** A thin edge on the panel's left that resizes it; arrow keys do the same for the keyboard. */
export function PanelResizeHandle({
	width,
	onResize,
	onCommit,
	onDragging,
	now,
	min,
	max,
}: {
	/** The width last measured, and the bounds it moves within, for assistive technology. */
	now: number
	min: number
	max: () => number
	width: () => number
	onResize: (width: number) => void
	onCommit: (width: number) => void
	/** True while the edge is held, so the page can skip its width transition. */
	onDragging?: (dragging: boolean) => void
}) {
	const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null)
	const move = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = drag.current
		if (!state) return
		// The panel sits on the right, so dragging left makes it wider.
		state.last = state.startWidth + (state.startX - event.clientX)
		onResize(state.last)
	}
	const end = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = drag.current
		if (!state) return
		drag.current = null
		onDragging?.(false)
		event.currentTarget.releasePointerCapture?.(event.pointerId)
		onCommit(state.last)
	}
	return (
		// biome-ignore lint/a11y/useSemanticElements: an hr cannot take focus and keys as a separator can.
		<div
			className="panel-resize-handle"
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize side panel"
			aria-valuenow={Math.round(now)}
			aria-valuemin={min}
			aria-valuemax={Math.max(min, Math.round(max()))}
			tabIndex={0}
			onPointerDown={(event) => {
				if (event.button !== 0) return
				event.preventDefault()
				event.currentTarget.setPointerCapture?.(event.pointerId)
				const startWidth = width()
				drag.current = { startX: event.clientX, startWidth, last: startWidth }
				onDragging?.(true)
			}}
			onPointerMove={move}
			onPointerUp={end}
			onPointerCancel={end}
			onKeyDown={(event) => {
				const step = event.shiftKey ? 80 : 24
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
				event.preventDefault()
				const next = width() + (event.key === 'ArrowLeft' ? step : -step)
				onResize(next)
				onCommit(next)
			}}
		/>
	)
}
