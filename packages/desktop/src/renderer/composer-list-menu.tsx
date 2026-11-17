import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './composer-menus.css'

export interface ListMenuPlace {
	/** The menu's left edge, in window pixels. */
	left: number
	/** The window height minus the menu's bottom edge, so it grows upward from there. */
	bottom: number
	width: number
	/** The tallest the menu may be before its list scrolls. */
	maxHeight: number
}

/**
 * A list that sits above the message box and never takes its focus: the caret stays in the box,
 * and the box's own key handler moves the highlight. Rows are options of a listbox the box points
 * at. The highlighted row may carry a tooltip, drawn to the right of the list (or to its left when
 * the window has no room), level with the row.
 */
export function ComposerListMenu<T>({
	id,
	label,
	place,
	items,
	highlight,
	onHighlight,
	onPick,
	rowKey,
	renderRow,
	tooltipFor,
	header,
	footer,
	className,
}: {
	id: string
	label: string
	place: ListMenuPlace
	items: readonly T[]
	highlight: number
	onHighlight: (index: number) => void
	onPick: (item: T) => void
	rowKey: (item: T) => string
	renderRow: (item: T) => ReactNode
	tooltipFor?: (item: T) => string | undefined
	header?: ReactNode
	footer?: ReactNode
	className?: string
}) {
	const frame = useRef<HTMLDivElement>(null)
	const list = useRef<HTMLDivElement>(null)
	const [tip, setTip] = useState<{ top: number; flip: boolean } | null>(null)
	const active = items[highlight]
	const tipText = active && tooltipFor ? tooltipFor(active) : undefined
	// A move of the highlight keeps its row in view; a move of the pointer never scrolls.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the row to show is the highlighted one.
	useLayoutEffect(() => {
		const row = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
		row?.scrollIntoView({ block: 'nearest' })
		const box = frame.current
		if (!row || !box || !tipText) {
			setTip(null)
			return
		}
		const rowRect = row.getBoundingClientRect()
		const boxRect = box.getBoundingClientRect()
		const top = Math.max(0, rowRect.top - boxRect.top)
		const flip = boxRect.right + 2 + 210 > window.innerWidth - 8
		setTip((current) =>
			current && current.top === top && current.flip === flip ? current : { top, flip },
		)
	}, [highlight, items, tipText, place.left, place.bottom])
	return createPortal(
		<div
			ref={frame}
			className={`composer-list-frame${className ? ` ${className}` : ''}`}
			style={{ left: place.left, bottom: place.bottom, width: place.width }}
			data-composer-list-menu
		>
			<div
				ref={list}
				id={id}
				// biome-ignore lint/a11y/useSemanticElements: the options are rows of text a select cannot draw.
				role="listbox"
				tabIndex={-1}
				aria-label={label}
				className="composer-list-menu"
				style={{ maxHeight: place.maxHeight }}
				// A press on a row must not take the focus from the box.
				onMouseDown={(event) => event.preventDefault()}
			>
				{header}
				{items.map((item, index) => (
					<div
						key={rowKey(item)}
						id={`${id}-${index}`}
						// biome-ignore lint/a11y/useSemanticElements: an option of a listbox the box points at.
						role="option"
						aria-selected={index === highlight}
						tabIndex={-1}
						className="composer-list-row"
						// Only a pointer that moved counts: a list that appears or scrolls under a resting
						// pointer makes the browser send a move with no distance, and that must not take the
						// highlight from the keys.
						onMouseMove={(event) => {
							if (event.movementX === 0 && event.movementY === 0) return
							if (index !== highlight) onHighlight(index)
						}}
						onClick={() => onPick(item)}
						onKeyDown={undefined}
					>
						{renderRow(item)}
					</div>
				))}
				{footer}
			</div>
			{tip && tipText && (
				<div
					role="tooltip"
					className="composer-list-tip"
					data-flip={tip.flip || undefined}
					style={{ top: tip.top }}
				>
					{tipText}
				</div>
			)}
		</div>,
		document.body,
	)
}

/**
 * Where a list sits: the left at a given x, the bottom on a given y, held 8 px from the window's
 * edges and as tall as the room above it allows, up to 384.
 */
export function placeListMenu(input: {
	left: number
	bottomEdge: number
	width: number
}): ListMenuPlace {
	const width = Math.min(input.width, window.innerWidth - 16)
	const left = Math.max(8, Math.min(input.left, window.innerWidth - 8 - width))
	return {
		left,
		width,
		bottom: Math.max(0, window.innerHeight - input.bottomEdge),
		maxHeight: Math.max(96, Math.min(384, input.bottomEdge - 16)),
	}
}
