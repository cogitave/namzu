import { useEffect, useRef, useState } from 'react'
import type { ExtensionRow } from '../shared/extensions-view.js'
import type { DesktopApi } from '../shared/protocol.js'
import { type Rect, boundsOf, sameBounds, themeTokens } from './extension-page-frame-model.js'
import { PAGE_STOPPED_WORDS, stripWords } from './extensions-model.js'
import { ArrowLeftIcon, InfoIcon } from './icons.js'
import './extension-page-pane.css'

type Api = Pick<
	DesktopApi,
	| 'extensionPageShow'
	| 'extensionPageBounds'
	| 'extensionPageClose'
	| 'extensionPageTheme'
	| 'onEvent'
>

const OVERLAYS =
	'[role="dialog"], [role="alertdialog"], [role="menu"], [role="alert"], [data-slot="popover-popup"], .toast-viewport'

const rectOf = (e: Element): Rect => {
	const r = e.getBoundingClientRect()
	return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/** What is really visible of the slot, and which of Namzu's own overlays lie over it. */
function measure(el: HTMLElement) {
	const clips: Rect[] = [{ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }]
	for (let p = el.parentElement; p; p = p.parentElement) {
		const cs = getComputedStyle(p)
		if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
			const r = p.getBoundingClientRect()
			clips.push({
				left: r.left + p.clientLeft,
				top: r.top + p.clientTop,
				width: p.clientWidth,
				height: p.clientHeight,
			})
		}
	}
	const covers: Rect[] = []
	for (const o of document.querySelectorAll(OVERLAYS)) {
		// The dialog that holds this very slot is not an overlay over it.
		if (o.contains(el)) continue
		const r = rectOf(o)
		if (r.width > 0 && r.height > 0) covers.push(r)
	}
	return boundsOf(rectOf(el), clips, covers)
}

/**
 * One page an extension drew, in the slot Namzu gave it. The page itself is not here: Namzu's main process
 * draws it in its own view, in the rectangle this slot reports, so nothing the page does can reach this
 * window. What is here is Namzu's own and cannot be restyled by an extension: the thin strip above the
 * page (a way back, who drew it, links to Namzu's own permission and licence screens, and an info mark
 * that says Namzu never asks for a key or a password in an extension page).
 */
export function ExtensionPageFrame({
	api,
	row,
	pageId,
	onBack,
	onOpenNamzu,
}: {
	api: Api
	row: ExtensionRow
	pageId: string
	onBack: () => void
	onOpenNamzu: (where: 'notice' | 'licence') => void
}) {
	const slot = useRef<HTMLDivElement>(null)
	const [stopped, setStopped] = useState<string>()
	const [attempt, setAttempt] = useState(0)
	const [shown, setShown] = useState(false)
	const page = row.ui?.pages.find((p) => p.id === pageId)
	const words = stripWords(row.publisher)

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt reopens the page
	useEffect(() => {
		const el = slot.current
		if (!el || !api.extensionPageShow) return
		let last: ReturnType<typeof boundsOf> | undefined
		let opened = false
		let frame = 0
		const style = getComputedStyle(document.documentElement)
		const dark = document.documentElement.classList.contains('dark')
		void api.extensionPageTheme?.({ dark, tokens: themeTokens((n) => style.getPropertyValue(n)) })
		const report = () => {
			frame = 0
			const b = measure(el)
			if (sameBounds(last, b)) return
			last = b
			if (!opened) {
				opened = true
				void api.extensionPageShow?.(row.id, pageId, b).then((r) => {
					if (!r.ok) setStopped(r.reason ?? 'closed')
					else setShown(true)
				})
			} else void api.extensionPageBounds?.(row.id, pageId, b)
		}
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(report)
		}
		const observer = new ResizeObserver(schedule)
		observer.observe(el)
		window.addEventListener('resize', schedule)
		window.addEventListener('scroll', schedule, true)
		// An overlay of Namzu's own opening or closing above the slot changes what may be shown.
		const overlays = new MutationObserver(schedule)
		overlays.observe(document.body, { childList: true, subtree: true })
		const off = api.onEvent?.((event) => {
			if (
				event.kind === 'extension-page' &&
				event.what === 'stopped' &&
				event.extensionId === row.id
			)
				setStopped(event.reason)
		})
		schedule()
		return () => {
			if (frame) cancelAnimationFrame(frame)
			observer.disconnect()
			overlays.disconnect()
			window.removeEventListener('resize', schedule)
			window.removeEventListener('scroll', schedule, true)
			off?.()
			void api.extensionPageClose?.(row.id, pageId)
		}
	}, [api, row.id, pageId, attempt])

	return (
		<>
			<div className="extension-page-strip">
				<button
					type="button"
					className="extension-page-info"
					aria-label="Back"
					title="Back (Esc)"
					onClick={onBack}
				>
					<ArrowLeftIcon aria-hidden="true" />
				</button>
				<span
					className="extension-page-dot"
					style={{ background: row.ui?.accent }}
					aria-hidden="true"
				/>
				<strong>{row.name}</strong>
				<span>{words.drawnBy}</span>
				<span
					className="extension-page-info"
					role="img"
					title={words.warning}
					aria-label={words.warning}
				>
					<InfoIcon aria-hidden="true" />
				</span>
				<span className="extension-page-strip-links">
					<button type="button" onClick={() => onOpenNamzu('notice')}>
						Permissions and notice
					</button>
					{row.licenceKind !== 'none' && (
						<button type="button" onClick={() => onOpenNamzu('licence')}>
							Licence
						</button>
					)}
				</span>
			</div>
			{stopped ? (
				<div className="extension-page-stopped">
					<p>{PAGE_STOPPED_WORDS[stopped] ?? 'This page is not available.'}</p>
					<button
						type="button"
						onClick={() => {
							setStopped(undefined)
							setShown(false)
							setAttempt((n) => n + 1)
						}}
					>
						Open again
					</button>
				</div>
			) : (
				<div className="extension-page-slot" ref={slot} aria-label={page?.title ?? pageId}>
					{/* Namzu's own view draws the page over this slot once it is shown; until then the slot is never empty. */}
					{!shown && (
						<output className="extension-page-loading">Opening {page?.title ?? row.name}…</output>
					)}
				</div>
			)}
		</>
	)
}
