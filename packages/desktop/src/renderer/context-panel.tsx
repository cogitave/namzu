import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import type { ContextDetail, ContextReport } from '../shared/context-protocol.js'
import type { ThreadUsage } from '../shared/projection.js'
import {
	type PanelItem,
	type PanelModel,
	type PanelRow,
	contextPanelModel,
} from './context-panel-model.js'
import { type ContextRead, ContextReader } from './context-panel-reader.js'
import { contextRingModel } from './context-ring.js'
import { ChevronDownIcon, ChevronRightIcon } from './icons.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import './context-panel.css'

/** What a conversation hands the ring so it can open the panel. */
export interface ContextPanelSource {
	ask: (detail: ContextDetail) => Promise<ContextReport | null>
	/** A shortening is running now. */
	compacting?: boolean
}

const ITEMS_SHOWN = 8

function Items({ items }: { items: PanelItem[] }) {
	const [all, setAll] = useState(false)
	const shown = all ? items : items.slice(0, ITEMS_SHOWN)
	return (
		<div className="context-panel-sublist">
			{shown.map((item, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the same name can appear under two sources
				<div className="context-panel-subrow" key={`${item.name}-${index}`}>
					<span className="context-panel-name">
						{item.name}
						{item.note ? <span className="context-panel-note"> {item.note}</span> : null}
					</span>
					<span className="context-panel-size">{item.size}</span>
				</div>
			))}
			{items.length > ITEMS_SHOWN && !all ? (
				<button type="button" className="context-panel-more" onClick={() => setAll(true)}>
					Show {items.length - ITEMS_SHOWN} more
				</button>
			) : null}
		</div>
	)
}

function Row({
	row,
	groupStart,
	groupHint,
}: { row: PanelRow; groupStart?: boolean; groupHint?: string }) {
	const [open, setOpen] = useState(false)
	const body = (
		<>
			<span
				className="context-panel-square"
				data-slot-colour={row.slot}
				style={row.slot ? { background: `var(--context-c${row.slot})` } : undefined}
				aria-hidden="true"
			/>
			<span className="context-panel-name">{row.name}</span>
			<span className="context-panel-size">{row.size}</span>
			<span className="context-panel-share">{row.share}</span>
		</>
	)
	return (
		<>
			{row.items ? (
				<button
					type="button"
					className="context-panel-row context-panel-row-open"
					title={row.title}
					data-group-start={groupStart || undefined}
					aria-expanded={open}
					onClick={() => setOpen(!open)}
				>
					{body}
				</button>
			) : (
				<div
					className="context-panel-row"
					data-kind={row.id === 'buffer' ? 'reserve' : row.id === 'free' ? 'free' : undefined}
					data-group-start={groupStart || undefined}
					title={groupHint ? `${groupHint} ${row.title}` : row.title}
				>
					{body}
				</div>
			)}
			{row.items && open ? <Items items={row.items} /> : null}
		</>
	)
}

function Servers({ servers }: { servers: NonNullable<PanelModel['servers']> }) {
	const [open, setOpen] = useState(false)
	const [openServer, setOpenServer] = useState<string>()
	return (
		<div className="context-panel-servers">
			<button
				type="button"
				className="context-panel-group"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				{open ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
				<span className="context-panel-group-name">Tool servers</span>
				<span className="context-panel-group-count">{servers.total}</span>
			</button>
			{open
				? servers.list.map((server) => (
						<div key={server.name}>
							<button
								type="button"
								className="context-panel-row context-panel-row-server"
								aria-expanded={openServer === server.name}
								onClick={() => setOpenServer(openServer === server.name ? undefined : server.name)}
							>
								<span className="context-panel-name">{server.name}</span>
								<span className="context-panel-size">
									{server.count} {server.count === 1 ? 'tool' : 'tools'}
								</span>
								<span className="context-panel-size">{server.size}</span>
							</button>
							{openServer === server.name ? <Items items={server.tools} /> : null}
						</div>
					))
				: null}
		</div>
	)
}

/**
 * The panel's content: figures, the bar and the rows. It has no frame of its own and fills the width it
 * is given, so the popover and the details column hold the same body. What the old notes said is
 * hover text now; the sentence about shortening is drawn only from 80% used.
 */
export function ContextPanelView({ model }: { model: PanelModel }) {
	const [details, setDetails] = useState(true)
	return (
		<div className="context-panel" data-tone={model.tone}>
			<button
				type="button"
				className="context-panel-header"
				aria-expanded={details}
				title={model.footnote}
				onClick={() => setDetails(!details)}
			>
				<span>Context</span>
				{/* Like every heading of a panel: a chevron only while it is folded. */}
				{!details && <ChevronRightIcon aria-hidden="true" />}
			</button>
			<div className="context-panel-figures">
				<span className="context-panel-percent">{model.headline}</span>
				<span className="context-panel-total">
					{model.estimated ? (
						<span className="context-panel-estimate" title="Estimated by Namzu">
							{model.size.slice(0, 1)}
						</span>
					) : null}
					{model.estimated ? model.size.slice(1) : model.size}
				</span>
			</div>
			{model.showSentence ? <p className="context-panel-sentence">{model.sentence}</p> : null}
			<div
				className="context-panel-bar"
				role="img"
				aria-label={model.bar.label}
				title={model.showSentence ? undefined : model.sentence}
			>
				{model.bar.segments.map((segment) => (
					<i
						key={segment.id}
						className={segment.kind === 'reserve' ? 'context-panel-reserve' : undefined}
						style={{
							width: `${segment.width}%`,
							...(segment.slot ? { background: `var(--context-c${segment.slot})` } : {}),
						}}
						title={segment.title}
					/>
				))}
			</div>
			{details ? (
				<>
					{model.used.map((row) => (
						<Row key={row.id} row={row} />
					))}
					{model.reserve.map((row, index) => (
						<Row
							key={row.id}
							row={row}
							groupStart={index === 0}
							groupHint={index === 0 ? model.groupHints.reserve : undefined}
						/>
					))}
					{model.deferred.map((row, index) => (
						<div
							className="context-panel-row"
							data-kind="deferred"
							data-group-start={index === 0 || undefined}
							title={index === 0 ? `${model.groupHints.deferred} ${row.title}` : row.title}
							key={row.id}
						>
							<span className="context-panel-square" aria-hidden="true" />
							<span className="context-panel-name">
								{row.name}
								<span className="context-panel-note"> (deferred)</span>
							</span>
							<span className="context-panel-size">{row.size}</span>
							<span className="context-panel-share">
								<span className="sr-only">Not counted</span>
								<span aria-hidden="true">-</span>
							</span>
						</div>
					))}
					{model.servers ? <Servers servers={model.servers} /> : null}
				</>
			) : null}
		</div>
	)
}

/**
 * Reads the answer while `open`, and again after each usage notice. The reader is rebuilt only when
 * the conversation changes; the latest `ask` is always the one it calls.
 */
export function useContextPanel(
	source: ContextPanelSource,
	usage: ThreadUsage | undefined,
	open: boolean,
): ContextRead {
	const [read, setRead] = useState<ContextRead>({ loading: false })
	const ask = useRef(source.ask)
	ask.current = source.ask
	const reader = useMemo(
		() =>
			new ContextReader({
				ask: (detail) => ask.current(detail),
				publish: setRead,
				schedule: (run, ms) => {
					const timer = setTimeout(run, ms)
					return () => clearTimeout(timer)
				},
			}),
		[],
	)
	useEffect(() => {
		if (!open) return
		reader.open()
		return () => reader.close()
	}, [open, reader])
	// biome-ignore lint/correctness/useExhaustiveDependencies: each new usage object is a notice
	useEffect(() => {
		if (open) reader.usageChanged()
	}, [usage, open, reader])
	return read
}

/** The panel read for one conversation, with no frame: the details column draws it inline. */
export function ContextInline({
	read,
	usage,
	compacting,
}: { read: ContextRead; usage: ThreadUsage | undefined; compacting?: boolean }) {
	const model = useMemo(
		() => (read.report ? contextPanelModel({ report: read.report, compacting }) : undefined),
		[read.report, compacting],
	)
	if (model) return <ContextPanelView model={model} />
	// Nothing counted yet: say what the ring knows, plainly.
	const ring = contextRingModel(usage)
	return (
		<div className="context-panel">
			<div className="context-panel-header-static">Context</div>
			{/* Not counted yet is a normal state, not a warning: it reads in the muted note style. */}
			<p className="context-panel-small">
				{read.loading
					? 'Reading…'
					: read.error
						? 'Namzu couldn’t read this just now. Try again in a moment.'
						: 'Namzu hasn’t counted this conversation yet. Send a message and look again.'}
			</p>
			{ring ? <p className="context-panel-small">{ring.lines[0]}</p> : null}
		</div>
	)
}

/**
 * Wraps the ring or the readout so that pressing it opens the panel. `render` is the button
 * itself; it keeps its own look and label.
 */
export function ContextPanelTrigger({
	source,
	usage,
	render,
	children,
	align = 'end',
}: {
	source: ContextPanelSource
	usage: ThreadUsage | undefined
	render: ReactElement
	children: ReactNode
	align?: 'start' | 'center' | 'end'
}) {
	const [open, setOpen] = useState(false)
	const read = useContextPanel(source, usage, open)
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger render={render}>{children}</PopoverTrigger>
			<PopoverPopup side="top" align={align} padding="none" className="context-panel-popup">
				<div className="context-panel-frame">
					<ContextInline read={read} usage={usage} compacting={source.compacting} />
				</div>
			</PopoverPopup>
		</Popover>
	)
}
