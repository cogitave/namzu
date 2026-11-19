/**
 * The page views of a window live exactly as long as the screen that asked for them. When the window
 * closes, or its screen starts loading another document, reloads or crashes, nothing that screen
 * would have closed runs any more, so the views are closed here. Written against small structural types
 * so it can be proved without Electron.
 */

export interface WindowLike {
	on(event: 'closed', handler: () => void): void
	readonly webContents: {
		on(event: string, handler: (...args: unknown[]) => void): void
	}
}

/** Whether a `did-start-navigation` is a new document in the main frame (either shape Electron has used). */
export function isNewDocument(args: readonly unknown[]): boolean {
	const d = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined
	if (d && typeof d === 'object' && 'isMainFrame' in d)
		return d.isMainFrame === true && d.isSameDocument !== true
	// the older positional form: (event, url, isInPlace, isMainFrame)
	return args[3] === true && args[2] !== true
}

export function watchWindow(win: WindowLike, onGone: () => void): void {
	win.on('closed', onGone)
	win.webContents.on('destroyed', onGone)
	win.webContents.on('render-process-gone', onGone)
	win.webContents.on('did-start-navigation', (...args) => {
		if (isNewDocument(args)) onGone()
	})
}
