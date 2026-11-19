import { type RefObject, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DesktopApi } from '../shared/protocol.js'
import { ExtensionPageFrame } from './extension-page-frame.js'
import {
	closeExtensionPage,
	openExtensionPanel,
	useExtensionsSnapshot,
} from './extensions-store.js'
import './extension-page-pane.css'

type Api = Pick<
	DesktopApi,
	| 'extensionsCall'
	| 'extensionsAddFromFile'
	| 'onEvent'
	| 'extensionPageShow'
	| 'extensionPageBounds'
	| 'extensionPageClose'
	| 'extensionPageTheme'
>

/** What a page's own request to open a Namzu screen means in Settings, on that extension's screen. */
export const PANEL_FOR_TARGET = {
	notice: 'notice',
	permissions: 'notice',
	licence: 'licence',
	record: 'record',
	'what-is-collected': 'collected',
} as const

/**
 * An extension's page as a page of the window, not a dialog: it fills the main pane under the window's own
 * top bar, with Namzu's thin strip on top. Back and Escape return to where the person was: the extension's
 * screen in Settings, or the conversation the page covered.
 */
export function ExtensionPagePane({
	api,
	pane,
}: { api: Api; pane: RefObject<HTMLElement | null> }) {
	const { page, rows } = useExtensionsSnapshot()
	const [host, setHost] = useState<HTMLElement | null>(null)
	useEffect(() => setHost(pane.current), [pane])
	const row = page ? rows.find((r) => r.id === page.extensionId) : undefined
	// A page whose extension is gone (removed or turned off) is left, so no empty page stays.
	useEffect(() => {
		if (page && !row) closeExtensionPage()
	}, [page, row])
	useEffect(() => {
		if (!page) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !event.defaultPrevented) closeExtensionPage()
		}
		window.addEventListener('keydown', onKey)
		// A key pressed inside the page's own view never reaches this window: main reports Escape.
		const off = api.onEvent?.((event) => {
			if (event.kind === 'extension-page' && event.what === 'escape') closeExtensionPage()
			if (event.kind === 'extension-page' && event.what === 'open-namzu')
				openExtensionPanel(event.extensionId, PANEL_FOR_TARGET[event.target])
		})
		return () => {
			window.removeEventListener('keydown', onKey)
			off?.()
		}
	}, [page, api])
	if (!page || !row || !host) return null
	return createPortal(
		<section className="extension-page-pane" aria-label={row.name}>
			<ExtensionPageFrame
				api={api}
				row={row}
				pageId={page.pageId}
				onBack={closeExtensionPage}
				onOpenNamzu={(where) =>
					openExtensionPanel(row.id, where === 'licence' ? 'licence' : 'notice')
				}
			/>
		</section>,
		host,
	)
}
