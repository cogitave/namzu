import { urlOrigin } from './policy.js'

/**
 * Which web contents are extension pages. The map is held by the main process and never taken from a
 * message: an extension id used for a call is the one registered for the sender, not one the page names.
 */

export interface PageInfo {
	readonly extensionId: string
	readonly pageId: string
	readonly origin: string
}

/** The parts of an IPC event the gate looks at (structural, so it can be tested without Electron). */
export interface SenderEvent {
	readonly sender: { readonly id: number; readonly mainFrame: unknown }
	readonly senderFrame: { readonly url: string } | null
}

export class ViewRegistry {
	private readonly byId = new Map<number, PageInfo>()
	dropped = 0

	register(webContentsId: number, info: PageInfo): void {
		this.byId.set(webContentsId, info)
	}
	unregister(webContentsId: number): void {
		this.byId.delete(webContentsId)
	}
	get(webContentsId: number): PageInfo | undefined {
		return this.byId.get(webContentsId)
	}
	has(webContentsId: number): boolean {
		return this.byId.has(webContentsId)
	}
	all(): PageInfo[] {
		return [...this.byId.values()]
	}

	/**
	 * The three checks, in this order: the sender is a registered extension view; the message came from that
	 * view's main frame; the frame's origin is the extension's own. A message from any other sender is dropped
	 * and counted.
	 */
	check(event: SenderEvent): PageInfo | undefined {
		const info = this.byId.get(event.sender.id)
		if (!info || event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) {
			this.dropped++
			return undefined
		}
		let origin = ''
		try {
			origin = urlOrigin(event.senderFrame.url)
		} catch {
			// an unreadable address is not the extension's origin
		}
		if (origin !== info.origin) {
			this.dropped++
			return undefined
		}
		return info
	}
}
