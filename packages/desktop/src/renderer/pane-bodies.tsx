import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserPaneRequest, BrowserPaneState } from '../shared/browser-pane.js'
import type { DesktopApi } from '../shared/protocol.js'
import { FileTypeIcon } from './file-panel/file-icons.js'
import { syncOverflow } from './file-panel/panel-tabs.js'
import { ArrowLeftIcon, ArrowRightIcon, GlobeIcon, PlusIcon, RefreshIcon, XIcon } from './icons.js'
import { Button } from './ui/button.js'
import './file-panel/file-panel.css'
import './pane-bodies.css'

export interface PaneTabItem {
	id: string
	label: string
	icon?: ReactNode
	/** Tooltip, when the label is not the whole name. */
	title?: string
	/** A tab that cannot be closed, such as the tree in the Files pane. */
	fixed?: boolean
}

/** The tabs in a pane's header: a name button and a close button beside it, never inside it. */
export function PaneTabs({
	label,
	tabs,
	active,
	onSelect,
	onClose,
	onNew,
	newLabel,
}: {
	label: string
	tabs: readonly PaneTabItem[]
	active?: string
	onSelect: (id: string) => void
	onClose?: (id: string) => void
	onNew?: () => void
	newLabel?: string
}) {
	const scroller = useRef<HTMLDivElement>(null)
	const shown = useRef(active)
	shown.current = active
	// The shown tab is always in view, however narrow the pane: when it changes, when a tab is
	// added, and when the pane is resized under it.
	const reveal = useCallback(() => {
		const node = scroller.current
		if (!node) return
		if (shown.current !== undefined)
			node
				.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
				?.closest<HTMLElement>('.panel-tab')
				?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
		syncOverflow(node)
	}, [])
	// biome-ignore lint/correctness/useExhaustiveDependencies: the active tab and the tab count are triggers, not values read.
	useEffect(() => {
		const frame = requestAnimationFrame(reveal)
		return () => cancelAnimationFrame(frame)
	}, [active, tabs.length, reveal])
	useEffect(() => {
		const node = scroller.current
		if (!node || typeof ResizeObserver === 'undefined') return
		// The soft edge shows only on a side with tabs out of sight; scrolling moves that.
		const sync = () => syncOverflow(node)
		node.addEventListener('scroll', sync, { passive: true })
		const observer = new ResizeObserver(reveal)
		observer.observe(node)
		return () => {
			node.removeEventListener('scroll', sync)
			observer.disconnect()
		}
	}, [reveal])
	return (
		<div className="panel-tab-strip pane-tabs">
			{/* biome-ignore lint/a11y/useSemanticElements: a tab list has no native element. */}
			<div className="panel-tab-list" role="tablist" aria-label={label}>
				<div ref={scroller} className="panel-tab-scroll">
					{tabs.map((tab) => {
						const selected = tab.id === active
						return (
							<div
								key={tab.id}
								className="panel-tab"
								role="presentation"
								data-kind="file"
								data-active={selected || undefined}
								title={tab.title}
							>
								<button
									type="button"
									role="tab"
									aria-selected={selected}
									tabIndex={selected ? 0 : -1}
									data-tab={tab.id}
									data-active={selected || undefined}
									className="panel-tab-name"
									onClick={() => onSelect(tab.id)}
								>
									{tab.icon}
									<span>{tab.label}</span>
								</button>
								{onClose && !tab.fixed && (
									<button
										type="button"
										className="panel-tab-close"
										aria-label={`Close ${tab.label}`}
										tabIndex={-1}
										onClick={() => onClose(tab.id)}
									>
										<XIcon aria-hidden="true" />
									</button>
								)}
							</div>
						)
					})}
				</div>
			</div>
			{onNew && (
				<Button
					type="button"
					size="icon-xs"
					variant="ghost-muted"
					className="panel-tab-add"
					aria-label={newLabel ?? 'New tab'}
					title={newLabel ?? 'New tab'}
					onClick={onNew}
				>
					<PlusIcon aria-hidden="true" />
				</Button>
			)}
		</div>
	)
}

/** The tab a file gets in the Files pane. */
export const fileTabItem = (path: string): PaneTabItem => ({
	id: `file:${path}`,
	label: path.split('/').pop() || path,
	title: path,
	icon: <FileTypeIcon path={path} />,
})

export interface BrowserPane {
	state: BrowserPaneState | undefined
	act: (request: BrowserPaneRequest) => void
}

/** The conversation's browser pages, as the host keeps them, and a way to ask for a change. */
export function useBrowserPane(
	api: Pick<DesktopApi, 'browserPane' | 'onBrowserEvent'>,
	sessionId: string,
): BrowserPane | undefined {
	const [state, setState] = useState<BrowserPaneState>()
	const ask = api.browserPane
	const listen = api.onBrowserEvent
	useEffect(() => {
		setState(undefined)
		if (!ask || !sessionId) return
		let current = true
		const stop = listen?.((next) => current && next.sessionId === sessionId && setState(next))
		void ask(sessionId, { kind: 'state' })
			.then((next) => current && setState(next))
			.catch(() => undefined)
		return () => {
			current = false
			stop?.()
		}
	}, [ask, listen, sessionId])
	const act = useCallback(
		(request: BrowserPaneRequest) => {
			if (!ask || !sessionId) return
			void ask(sessionId, request)
				.then((next) => request.kind !== 'place' && setState(next))
				.catch(() => undefined)
		},
		[ask, sessionId],
	)
	return ask && sessionId
		? { state: state?.sessionId === sessionId ? state : undefined, act }
		: undefined
}

/** The mark of a tab Namzu opened: a dot that pulses while a call is on the page. */
export function AgentMark({ working }: { working?: boolean | undefined }) {
	return <span className="agent-mark" data-working={working || undefined} aria-hidden="true" />
}

/** What the strip under the address bar says about an agent's tab, in plain words. */
export function agentStatusWords(tab: {
	control?: 'agent' | 'person' | undefined
	working?: boolean | undefined
}): string {
	if (tab.control === 'person') return 'You have control'
	return tab.working ? 'Namzu is using this tab · working' : 'Namzu is using this tab'
}

/** The tabs in the Browser pane's header: the page titles and a plus. */
export function BrowserTabs({ browser }: { browser: BrowserPane | undefined }) {
	const tabs = browser?.state?.tabs ?? []
	return (
		<PaneTabs
			label="Browser"
			tabs={
				tabs.length
					? tabs.map((tab) => ({
							id: tab.id,
							label: tab.title,
							title:
								tab.owner === 'agent'
									? `Namzu is using this tab · ${tab.address || tab.title}`
									: tab.address || tab.title,
							icon:
								tab.owner === 'agent' ? (
									<AgentMark working={tab.working} />
								) : (
									<GlobeIcon aria-hidden="true" />
								),
						}))
					: [{ id: 'blank', label: 'Browser', icon: <GlobeIcon aria-hidden="true" />, fixed: true }]
			}
			active={browser?.state?.active ?? 'blank'}
			onSelect={(id) => id !== 'blank' && browser?.act({ kind: 'select', tabId: id })}
			onClose={(id) => browser?.act({ kind: 'close', tabId: id })}
			onNew={browser ? () => browser.act({ kind: 'new' }) : undefined}
			newLabel="New tab"
		/>
	)
}

/**
 * Something in the window that is drawn above the page's rectangle. A page is a native view laid
 * over the app's own page, so a menu or a dialog that reaches it would sit behind it; the page
 * steps aside while one does, and while a divider is being dragged.
 */
const OVERLAYS =
	'[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"],[role="tooltip"],[role="alert"]'
function covered(page: DOMRect): boolean {
	if (document.documentElement.dataset.paneDragging) return true
	for (const node of document.querySelectorAll(OVERLAYS)) {
		const box = node.getBoundingClientRect()
		if (box.width * box.height < 100) continue
		if (
			box.left < page.right &&
			box.right > page.left &&
			box.top < page.bottom &&
			box.bottom > page.top
		)
			return true
	}
	return false
}

/**
 * The Browser pane's body: the bar (back, forward, reload and an address that can be edited) and
 * the rectangle the host lays the page into. The page is not drawn here: it is a view of its own
 * in the window, kept apart from the app (see main/browser-pane.ts).
 */
export function BrowserBody({ browser }: { browser: BrowserPane | undefined }) {
	const state = browser?.state
	const tab = state?.tabs.find((candidate) => candidate.id === state.active)
	const page = useRef<HTMLDivElement>(null)
	const input = useRef<HTMLInputElement>(null)
	const [draft, setDraft] = useState<string>()
	const act = browser?.act
	// Place the page where this rectangle is, and keep doing it: a pane moves without being resized.
	const hasPage = Boolean(tab)
	useEffect(() => {
		const node = page.current
		if (!act || !node || !hasPage) return
		let frame = 0
		let sent = ''
		const tick = () => {
			const box = node.getBoundingClientRect()
			// Under a menu or dialog the page cannot stay above it: a picture of it stands in until it closes.
			const next = covered(box)
				? null
				: { x: box.left, y: box.top, width: box.width, height: box.height }
			const key = next ? `${next.x},${next.y},${next.width},${next.height}` : 'covered'
			if (key !== sent) {
				sent = key
				act(next ? { kind: 'place', bounds: next } : { kind: 'freeze' })
			}
			frame = requestAnimationFrame(tick)
		}
		tick()
		return () => {
			cancelAnimationFrame(frame)
			act({ kind: 'place', bounds: null })
		}
	}, [act, hasPage])
	const shown = draft ?? tab?.address ?? ''
	return (
		<div className="browser-pane" data-browser-pane>
			<div className="browser-bar">
				<Button
					type="button"
					size="icon-xs"
					variant="ghost-muted"
					aria-label="Back"
					title="Back"
					disabled={!tab?.canGoBack}
					onClick={() => act?.({ kind: 'back' })}
				>
					<ArrowLeftIcon aria-hidden="true" />
				</Button>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost-muted"
					aria-label="Forward"
					title="Forward"
					disabled={!tab?.canGoForward}
					onClick={() => act?.({ kind: 'forward' })}
				>
					<ArrowRightIcon aria-hidden="true" />
				</Button>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost-muted"
					aria-label="Reload"
					title="Reload"
					disabled={!tab}
					onClick={() => act?.({ kind: 'reload' })}
				>
					<RefreshIcon aria-hidden="true" />
				</Button>
				<input
					ref={input}
					className="browser-address"
					type="text"
					spellCheck={false}
					aria-label="Address"
					placeholder="Type a web address"
					value={shown}
					title={tab?.address}
					disabled={!act}
					onChange={(event) => setDraft(event.target.value)}
					onFocus={(event) => event.currentTarget.select()}
					onBlur={() => setDraft(undefined)}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							setDraft(undefined)
							event.currentTarget.blur()
						} else if (event.key === 'Enter' && draft !== undefined) {
							event.preventDefault()
							if (draft.trim()) act?.({ kind: 'go', address: draft })
							setDraft(undefined)
							event.currentTarget.blur()
						}
					}}
				/>
			</div>
			{tab?.owner === 'agent' && (
				<div
					className="browser-agent-bar"
					data-testid="agent-tab-bar"
					data-control={tab.control ?? 'agent'}
					data-working={tab.working || undefined}
				>
					<AgentMark working={tab.working} />
					<output
						className="browser-agent-words"
						title={
							tab.control === 'person'
								? 'You have control of this tab. Namzu is paused until you hand it back.'
								: agentStatusWords(tab)
						}
					>
						{agentStatusWords(tab)}
					</output>
					{tab.control === 'person' ? (
						<Button
							type="button"
							size="xs"
							variant="outline"
							data-action="hand-back"
							onClick={() => act?.({ kind: 'handback', tabId: tab.id })}
						>
							Hand back
						</Button>
					) : (
						<Button
							type="button"
							size="xs"
							variant="outline"
							data-action="take-over"
							onClick={() => act?.({ kind: 'takeover', tabId: tab.id })}
						>
							Take over
						</Button>
					)}
				</div>
			)}
			{state?.notice && <output className="browser-notice">{state.notice}</output>}
			<div className="browser-page" ref={page} data-loading={tab?.loading || undefined}>
				{state?.still && (
					<img className="browser-still" src={state.still} alt="" draggable={false} />
				)}
				{!tab && (
					<div className="browser-empty">
						<GlobeIcon className="size-5" aria-hidden="true" />
						<p>
							{browser
								? 'A page the conversation writes opens here. Type an address above to open any other.'
								: 'The browser is not available here.'}
						</p>
					</div>
				)}
			</div>
		</div>
	)
}
