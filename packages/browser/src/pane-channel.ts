/**
 * What the pane transport needs from the app that owns the tabs.
 *
 * The browser pane of a desktop app owns its tabs (one view each) and can
 * run DevTools-protocol commands on a tab's page. It cannot be a whole
 * browser: there is no browser-level endpoint, one debugger client per tab,
 * and the app decides when a tab opens or closes. The channel is that
 * narrow surface. {@link createPaneTransport} builds the rest of a browser
 * out of it so Playwright can drive the tabs.
 *
 * A channel is an in-process object. Across a process boundary (the engine
 * child and the app's main process) an implementation relays these calls;
 * nothing here assumes a socket or a port.
 */

/** A tab the channel offers. `tabId` is the channel's own name for it. */
export interface PaneTabRef {
	readonly tabId: string
	/**
	 * The tab was just opened and has sent nothing yet: it waits for the first
	 * `Runtime.runIfWaitingForDebugger` before it starts its first navigation. The agent's
	 * request screening is installed in between, so a popup's first request is screened like any
	 * other. A tab that is not held leaves this out.
	 */
	readonly paused?: boolean
}

/** A protocol event from a tab's page, or from a session below it (an iframe or worker). */
export interface PaneEvent {
	readonly tabId: string
	readonly method: string
	readonly params?: unknown
	/** The child session that raised it. Absent for the tab's own page session. */
	readonly sessionId?: string
}

export interface PaneChannel {
	/** The tabs open now that the agent may drive. */
	listTabs(): Promise<readonly PaneTabRef[]>
	/**
	 * Run a protocol command on a tab's page, or on a child session of it
	 * (`sessionId`, as a child-session id from a {@link PaneEvent}). The first command on a tab
	 * attaches to it; events for the tab follow from then on. Rejects with an
	 * `Error` whose message is the protocol error.
	 */
	cdp(tabId: string, method: string, params?: object, sessionId?: string): Promise<unknown>
	/** Protocol events of attached tabs. Returns the unsubscribe function. */
	onEvent(listener: (event: PaneEvent) => void): () => void
	/** A tab appeared that the app opened: a popup, or a tab the person gave the agent. */
	onTabAdded(listener: (tab: PaneTabRef) => void): () => void
	/** A tab closed, or its debugger was taken away (the person took over). */
	onTabClosed(listener: (tabId: string) => void): () => void
	/**
	 * Open a tab for the agent. Absent when the app does not let the agent
	 * open tabs; `Target.createTarget` is then refused with a message that says so.
	 */
	openTab?(url?: string): Promise<PaneTabRef>
	/**
	 * Close a tab the agent opened (or was given). The app answers with `onTabClosed` once it is
	 * gone. Absent when the agent may not close tabs; closing is then refused.
	 */
	closeTab?(tabId: string): Promise<void>
	/**
	 * The app cancelled a download (the pane never downloads files), with the file name the page
	 * suggested. The host tells the model.
	 */
	onDownloadRefused?(listener: (name: string) => void): () => void
	/** The link to the app is gone (its process exited). Returns the unsubscribe function. */
	onClose?(listener: (reason?: string) => void): () => void
	/** Detach from every tab. The tabs stay open: they are the person's. */
	close(): Promise<void>
}
