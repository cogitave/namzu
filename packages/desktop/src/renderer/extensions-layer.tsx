import { type RefObject, useEffect, useRef } from 'react'
import type { DesktopApi } from '../shared/protocol.js'
import { ExtensionPagePane } from './extension-page-pane.js'
import { useExtensionsSnapshot, useExtensionsSync } from './extensions-store.js'

/** What the layer needs of the window: Settings opening and closing, and where a page is drawn. */
export interface ExtensionsLayerProps {
	api: Pick<
		DesktopApi,
		| 'extensionsCall'
		| 'extensionsAddFromFile'
		| 'onEvent'
		| 'extensionPageShow'
		| 'extensionPageBounds'
		| 'extensionPageClose'
		| 'extensionPageTheme'
	>
	/** The main pane: an extension's page fills it. */
	pane: RefObject<HTMLElement | null>
	/** Opens Settings on the Extensions section. */
	openSettings: () => void
	closeSettings: () => void
}

/**
 * Mounted once per window: keeps the extension rows current, sends the rail's Extensions button to
 * Settings, and draws an extension's page in the main pane. It draws nothing of its own in the window's
 * chrome: what an extension is doing is written in its row in Settings, and a background extension
 * shows its own icon in the system tray, never Namzu's.
 */
export function ExtensionsLayer({ api, pane, openSettings, closeSettings }: ExtensionsLayerProps) {
	useExtensionsSync(api)
	const { settingsRequest, settingsReturn, page } = useExtensionsSnapshot()
	const seen = useRef({ settingsRequest, settingsReturn })
	const open = useRef(openSettings)
	open.current = openSettings
	useEffect(() => {
		const was = seen.current
		seen.current = { settingsRequest, settingsReturn }
		if (settingsRequest !== was.settingsRequest || settingsReturn !== was.settingsReturn)
			open.current()
	}, [settingsRequest, settingsReturn])
	// A page opened from Settings takes the window: Settings steps aside until it is left.
	const close = useRef(closeSettings)
	close.current = closeSettings
	const pageKey = page ? `${page.extensionId}/${page.pageId}` : undefined
	useEffect(() => {
		if (pageKey) close.current()
	}, [pageKey])
	return <ExtensionPagePane api={api} pane={pane} />
}
