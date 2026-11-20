import { Menu } from '@base-ui/react/menu'
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import { ArrowLeftIcon, Maximize2Icon, Minimize2Icon, MoreHorizontalIcon, XIcon } from './icons.js'
import { MENU_OFFSET } from './menu-metrics.js'
import {
	CARD_GAP,
	CARD_TOP,
	COL_MIN,
	type Fit,
	type GridKind,
	type Layout,
	ROW_MIN,
	closePane,
	dragColumns,
	dragRows,
	dragSide,
	fit,
	movePane,
	openKinds,
	resetColumns,
	resetRows,
	resetSide,
	setMaximised,
} from './pane-grid.js'
import { PaneMenuItemsContext } from './pane-menu-context.js'
import { Button } from './ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import './pane-grid.css'

/** The one word each pane goes by: its title, its button's name and its tooltip. */
export const PANE_LABEL: Record<GridKind, string> = {
	terminal: 'Terminal',
	changes: 'Changes',
	browser: 'Browser',
	files: 'Files',
	tasks: 'Background tasks',
}

/** What a pane puts in its tile: the left of the header, its own actions, and the body. */
export interface PaneContent {
	title: ReactNode
	/** Controls that sit before the pane's "…" menu. */
	actions?: ReactNode
	/** The pane draws its own "…" menu and adds the pane's rows to it, so the tile draws none. */
	ownMenu?: boolean
	body: ReactNode
}

const NUDGE = 16

type Update = (change: (layout: Layout) => Layout) => void

function PaneDivider({
	orientation,
	style,
	label,
	now,
	min,
	max,
	onMove,
	onNudge,
	onReset,
}: {
	orientation: 'vertical' | 'horizontal'
	style: CSSProperties
	label: string
	now: number
	min: number
	max: number
	/** The pointer's position in the window while the seam is held. */
	onMove: (x: number, y: number) => void
	/** A key step, positive toward the end of the axis (right or down). */
	onNudge: (delta: number) => void
	onReset: () => void
}) {
	const held = useRef(false)
	const vertical = orientation === 'vertical'
	return (
		// biome-ignore lint/a11y/useSemanticElements: an hr cannot take focus and keys as a separator can.
		<div
			className="pane-divider"
			data-orientation={orientation}
			role="separator"
			aria-orientation={orientation}
			aria-label={label}
			aria-valuenow={Math.round(now)}
			aria-valuemin={Math.round(min)}
			aria-valuemax={Math.round(Math.max(min, max))}
			tabIndex={0}
			style={style}
			onPointerDown={(event) => {
				if (event.button !== 0) return
				event.preventDefault()
				event.currentTarget.setPointerCapture?.(event.pointerId)
				held.current = true
				document.documentElement.dataset.paneDragging = orientation
			}}
			onPointerMove={(event) => held.current && onMove(event.clientX, event.clientY)}
			onPointerUp={(event) => {
				held.current = false
				delete document.documentElement.dataset.paneDragging
				event.currentTarget.releasePointerCapture?.(event.pointerId)
			}}
			onPointerCancel={() => {
				held.current = false
				delete document.documentElement.dataset.paneDragging
			}}
			onDoubleClick={onReset}
			onKeyDown={(event) => {
				const keys = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
				const at = keys.indexOf(event.key)
				if (at < 0) return
				event.preventDefault()
				onNudge(at === 0 ? -NUDGE : NUDGE)
			}}
		/>
	)
}

function TileMenuItems({
	kind,
	layout,
	update,
}: {
	kind: GridKind
	layout: Layout
	update: Update
}) {
	const can = (direction: 'left' | 'right' | 'up' | 'down') =>
		movePane(layout, kind, direction) !== layout
	return (
		<>
			{(['left', 'right', 'up', 'down'] as const).map((direction) => (
				<Menu.Item
					key={direction}
					className="conversation-actions-item"
					disabled={!can(direction)}
					onClick={() => update((value) => movePane(value, kind, direction))}
				>
					<span className="conversation-actions-label">Move {direction}</span>
				</Menu.Item>
			))}
			<Menu.Separator className="conversation-actions-separator" />
			<Menu.Item
				className="conversation-actions-item"
				disabled={openKinds(layout).length < 2}
				onClick={() =>
					update((value) =>
						openKinds(value)
							.filter((other) => other !== kind)
							.reduce((next, other) => closePane(next, other), value),
					)
				}
			>
				<span className="conversation-actions-label">Close other panes</span>
			</Menu.Item>
		</>
	)
}

function TileMenu({
	kind,
	layout,
	update,
}: {
	kind: GridKind
	layout: Layout
	update: Update
}) {
	return (
		<Menu.Root>
			<Tooltip>
				<TooltipTrigger
					render={
						<Menu.Trigger
							render={<Button size="icon-xs" variant="ghost-muted" className="pane-control" />}
							aria-label={`${PANE_LABEL[kind]} options`}
						/>
					}
				>
					<MoreHorizontalIcon aria-hidden="true" />
				</TooltipTrigger>
				<TooltipPopup side="bottom">More</TooltipPopup>
			</Tooltip>
			<Menu.Portal>
				<Menu.Positioner
					className="conversation-actions-positioner"
					align="end"
					sideOffset={MENU_OFFSET}
				>
					<Menu.Popup
						className="conversation-actions-popup"
						aria-label={`${PANE_LABEL[kind]} options`}
					>
						<TileMenuItems kind={kind} layout={layout} update={update} />
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}

function PaneTile({
	kind,
	content,
	layout,
	update,
	style,
	maximised,
	second,
	onClosed,
}: {
	kind: GridKind
	content: PaneContent
	layout: Layout
	update: Update
	style: CSSProperties
	maximised: boolean
	second: boolean
	onClosed: (kind: GridKind) => void
}) {
	const label = PANE_LABEL[kind]
	return (
		<section
			className="pane-tile"
			data-pane={kind}
			data-second={second || undefined}
			aria-label={label}
			style={style}
		>
			<div className="section-heading panel-heading pane-header">
				<div className="pane-title">{content.title}</div>
				<div className="pane-actions">
					<PaneMenuItemsContext.Provider
						value={<TileMenuItems kind={kind} layout={layout} update={update} />}
					>
						{content.actions}
					</PaneMenuItemsContext.Provider>
					{!content.ownMenu && <TileMenu kind={kind} layout={layout} update={update} />}
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									type="button"
									size="icon-xs"
									variant="ghost-muted"
									className="pane-control"
									aria-label={maximised ? `Restore ${label}` : `Maximise ${label}`}
									data-pane-maximise
									onClick={() =>
										update((value) => setMaximised(value, maximised ? undefined : kind))
									}
								/>
							}
						>
							{maximised ? (
								<Minimize2Icon aria-hidden="true" />
							) : (
								<Maximize2Icon aria-hidden="true" />
							)}
						</TooltipTrigger>
						<TooltipPopup side="bottom">{maximised ? 'Restore' : 'Maximise'}</TooltipPopup>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									type="button"
									size="icon-xs"
									variant="ghost-muted"
									className="pane-control"
									aria-label={`Close ${label}`}
									data-pane-close
									onClick={() => {
										update((value) => closePane(value, kind))
										onClosed(kind)
									}}
								/>
							}
						>
							<XIcon aria-hidden="true" />
						</TooltipTrigger>
						<TooltipPopup side="bottom">Close</TooltipPopup>
					</Tooltip>
				</div>
			</div>
			<div className="pane-body">{content.body}</div>
		</section>
	)
}

export interface PaneGridProps {
	layout: Layout
	update: Update
	/** The element the conversation lives in: the grid tells it how much to leave free. */
	host: RefObject<HTMLElement | null>
	render: (kind: GridKind) => PaneContent
	/** The Session pane, drawn docked or as a card; absent when there is nothing to show. */
	session?: ReactNode
	onCloseSession: () => void
	/** Which pane the narrow overlay shows. */
	shown?: GridKind
	onShow: (kind: GridKind) => void
	/** The way back from the overlay: the conversation again. */
	onHide: () => void
	/** A pane's close put focus back where its button is. */
	onClosed: (kind: GridKind) => void
}

/** The panes beside a conversation, drawn from `fit(layout, width, height)`. */
export function PaneGrid({
	layout,
	update,
	host,
	render,
	session,
	onCloseSession,
	shown,
	onShow,
	onHide,
	onClosed,
}: PaneGridProps) {
	const root = useRef<HTMLDivElement>(null)
	const [size, setSize] = useState({ width: 0, height: 0 })
	useLayoutEffect(() => {
		const node = root.current
		if (!node) return
		const read = () => {
			const box = node.getBoundingClientRect()
			setSize((old) =>
				old.width === Math.round(box.width) && old.height === Math.round(box.height)
					? old
					: { width: Math.round(box.width), height: Math.round(box.height) },
			)
		}
		read()
		if (typeof ResizeObserver === 'undefined') return
		const watch = new ResizeObserver(read)
		watch.observe(node)
		return () => watch.disconnect()
	}, [])
	const measured = size.width > 0 && size.height > 0
	const drawn: Fit | undefined = measured ? fit(layout, size.width, size.height, shown) : undefined
	const dock = drawn?.session.mode === 'dock' ? drawn.session.width : 0
	const reserved =
		drawn && drawn.mode !== 'overlay' && drawn.mode !== 'maximised' ? drawn.side + dock : 0
	const mode = drawn?.mode ?? 'none'
	// The conversation is told how much room the panes leave it; it is never removed.
	useLayoutEffect(() => {
		const node = host.current
		if (!node) return
		node.style.setProperty('--pane-reserved', `${reserved}px`)
		node.dataset.paneMode = mode
		return () => {
			node.style.removeProperty('--pane-reserved')
			delete node.dataset.paneMode
		}
	}, [host, reserved, mode])

	const columns = drawn?.columns ?? []
	const overlay = drawn?.mode === 'overlay'
	const maximisedKind = drawn?.mode === 'maximised' ? drawn.front : undefined
	const sideLeft = drawn ? (overlay || maximisedKind ? 0 : drawn.conversation) : 0
	const barHeight = overlay ? 40 : 0
	const rect = () => root.current?.getBoundingClientRect()
	const room = size.width - dock

	return (
		<div ref={root} className="pane-grid" data-mode={mode}>
			{drawn && overlay && (
				<div className="pane-overlay-bar" role="toolbar" aria-label="Panes">
					<Button type="button" size="sm" variant="ghost-muted" onClick={onHide}>
						<ArrowLeftIcon aria-hidden="true" />
						Back to conversation
					</Button>
					<div className="pane-overlay-tabs">
						{openKinds(layout).map((kind) => (
							<Button
								key={kind}
								type="button"
								size="xs"
								variant="ghost-muted"
								aria-pressed={drawn.front === kind}
								onClick={() => onShow(kind)}
							>
								{PANE_LABEL[kind]}
							</Button>
						))}
					</div>
				</div>
			)}
			{drawn &&
				drawn.mode !== 'none' &&
				columns.flatMap((column) =>
					column.tiles.map((tile, row) => (
						<PaneTile
							key={tile.kind}
							kind={tile.kind}
							content={render(tile.kind)}
							layout={layout}
							update={update}
							maximised={maximisedKind === tile.kind}
							second={row > 0}
							onClosed={onClosed}
							style={{
								left: sideLeft + column.left,
								top: tile.top + barHeight,
								width: column.width,
								height: Math.max(0, tile.height - barHeight),
							}}
						/>
					)),
				)}
			{drawn?.mode === 'grid' && (
				<>
					<PaneDivider
						orientation="vertical"
						label="Resize panes"
						now={drawn.side}
						min={columns.length === 2 ? 2 * COL_MIN : COL_MIN}
						max={room - 360}
						style={{ left: drawn.conversation, top: 0, height: size.height }}
						onMove={(x) => {
							const box = rect()
							if (box)
								update((value) => dragSide(value, room, columns.length, room - (x - box.left)))
						}}
						onNudge={(delta) =>
							update((value) => dragSide(value, room, columns.length, drawn.side - delta))
						}
						onReset={() => update((value) => resetSide(value, columns.length))}
					/>
					{columns.length === 2 && !drawn.folded && (
						<PaneDivider
							orientation="vertical"
							label="Resize columns"
							now={columns[0]?.width ?? 0}
							min={COL_MIN}
							max={drawn.side - COL_MIN}
							style={{
								left: drawn.conversation + (columns[0]?.width ?? 0),
								top: 0,
								height: size.height,
							}}
							onMove={(x) => {
								const box = rect()
								if (box)
									update((value) =>
										dragColumns(value, drawn.side, x - box.left - drawn.conversation),
									)
							}}
							onNudge={(delta) =>
								update((value) => dragColumns(value, drawn.side, (columns[0]?.width ?? 0) + delta))
							}
							onReset={() => update(resetColumns)}
						/>
					)}
					{!drawn.folded &&
						columns.map((column) =>
							column.tiles.length === 2 ? (
								<PaneDivider
									key={column.id}
									orientation="horizontal"
									label="Resize panes in this column"
									now={column.tiles[0]?.height ?? 0}
									min={ROW_MIN}
									max={size.height - ROW_MIN}
									style={{
										left: drawn.conversation + column.left,
										width: column.width,
										top: column.tiles[0]?.height ?? 0,
									}}
									onMove={(_x, y) => {
										const box = rect()
										if (box) update((value) => dragRows(value, column.id, size.height, y - box.top))
									}}
									onNudge={(delta) =>
										update((value) =>
											dragRows(
												value,
												column.id,
												size.height,
												(column.tiles[0]?.height ?? 0) + delta,
											),
										)
									}
									onReset={() => update((value) => resetRows(value, column.id))}
								/>
							) : null,
						)}
				</>
			)}
			{drawn && session && drawn.session.mode !== 'off' && (
				<aside
					className="pane-session"
					aria-label="Session"
					data-mode={drawn.session.mode}
					style={
						drawn.session.mode === 'dock'
							? {
									left: size.width - drawn.session.width,
									width: drawn.session.width,
									top: 0,
									height: size.height,
								}
							: {
									left: Math.max(
										CARD_GAP,
										(overlay ? size.width : drawn.conversation) - CARD_GAP - drawn.session.width,
									),
									width: drawn.session.width,
									top: CARD_TOP,
								}
					}
					onKeyDown={(event) => {
						if (event.key === 'Escape' && drawn.session.mode === 'card') {
							event.stopPropagation()
							onCloseSession()
						}
					}}
				>
					{session}
				</aside>
			)}
		</div>
	)
}
