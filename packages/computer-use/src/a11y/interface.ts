/**
 * What the computer-use host needs to know about a desktop's windows and
 * their contents, written without any one platform's terms so a macOS or a
 * Linux backend only adds a file that implements {@link AccessibilityBackend}.
 *
 * - A window is named by an opaque `windowId` string; the backend defines its
 *   format and accepts the ones it handed out.
 * - Rectangles are virtual-desktop physical pixels.
 * - Nothing here is a promise about speed except {@link AccessibilityBackend.listWindows},
 *   which a backend serves from the platform's window list without reading
 *   any window's contents.
 */

export interface A11yRect {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

/** A top-level window a person would call a window. */
export interface A11yWindow {
	readonly windowId: string
	readonly processId: number
	/** The program's file name (`app.exe` on Windows); empty when it cannot be read. */
	readonly processName: string
	readonly title: string
	readonly bounds: A11yRect
	readonly minimized: boolean
	/** The window the user is typing into. */
	readonly focused: boolean
	/** Position front to back among the listed windows; 0 is in front. */
	readonly z: number
}

export interface A11yDisplay {
	readonly id: string
	readonly bounds: A11yRect
	/** The part of the display not taken by the shell's own bars. */
	readonly workArea: A11yRect
	/** 1 is 96 dpi, 1.5 is 144 dpi. */
	readonly scale: number
	readonly primary: boolean
}

/** What a control can be asked to do, by the pattern it offers. */
export type A11yAction =
	| 'invoke'
	| 'value'
	| 'toggle'
	| 'expandCollapse'
	| 'selectionItem'
	| 'scroll'

export interface A11yNode {
	/** Position in {@link A11ySnapshot.nodes}; the handle `identity` takes. */
	readonly index: number
	/** Index of the parent, -1 for the window itself. */
	readonly parent: number
	readonly depth: number
	/** The control's kind (`Button`, `Edit`, `Text`, …), as the platform names it. */
	readonly role: string
	readonly name?: string
	readonly automationId?: string
	readonly className?: string
	readonly bounds: A11yRect
	readonly enabled: boolean
	readonly offscreen: boolean
	readonly focused: boolean
	readonly actions: readonly A11yAction[]
	readonly value?: string
	readonly toggle?: 'on' | 'off' | 'mixed'
	readonly expand?: 'expanded' | 'collapsed' | 'partial' | 'leaf'
	readonly selected?: boolean
	/** Present when the children of this control were not all listed. */
	readonly childCount?: number
}

export interface A11ySnapshotRequest {
	readonly windowId: string
	/** Default 400. */
	readonly maxNodes?: number
	/** Default 12. */
	readonly maxDepth?: number
	/** Only the window, its children and theirs, with `childCount` on the containers. */
	readonly skeleton?: boolean
	/**
	 * Read a Chromium or Electron window anyway. Reading one switches its
	 * accessibility on for the rest of the session, so it is refused
	 * (`chromium_not_activated`) unless the caller asks.
	 */
	readonly allowChromium?: boolean
	/** Longest the read may take, ms. Default 8 000. */
	readonly timeoutMs?: number
}

export interface A11ySnapshot {
	readonly windowId: string
	/** Names this read; `identity` refuses an index from an older one when given it. */
	readonly revision: number
	readonly nodes: readonly A11yNode[]
	/** Controls in the window, listed or not. */
	readonly total: number
	readonly truncated: boolean
	readonly skeleton: boolean
	/** How long the platform call took, ms. */
	readonly readMs: number
}

/** Which kind of change to wait for. Default: all. */
export type A11yChangeKind = 'structure' | 'property' | 'location'

/** A marker in the stream of changes; see {@link AccessibilityBackend.seq}. Opaque. */
export type A11ySeq = number

export interface A11yWaitRequest {
	readonly windowId: string
	/** A token from {@link AccessibilityBackend.seq}: count changes since then. Default: since this call. */
	readonly since?: A11ySeq
	/** How long the window must stay quiet after its last change, ms. Default 120. */
	readonly quietMs?: number
	/** Longest to wait, ms. Default 2 000, at most 10 000. */
	readonly timeoutMs?: number
	readonly kinds?: readonly A11yChangeKind[]
}

export type A11yWaitResult =
	| {
			readonly changed: true
			/** False when changes were still arriving at the timeout. */
			readonly settled: boolean
			/** From the start of the wait to the first change; negative when it came earlier (see `since`). */
			readonly firstEventMs: number
			readonly settledMs: number
			readonly events: number
			/** Windows of the same program that appeared. */
			readonly newWindows: readonly string[]
	  }
	| { readonly changed: false; readonly timedOut: true; readonly settledMs: number }

/**
 * Names a control well enough to find it again after the window changed:
 * the platform's own runtime id first, else its automation id and kind, else
 * its kind, a hash of its name and the path of its ancestors. Holds no text.
 */
export interface A11yFingerprint {
	readonly runtimeId: string
	readonly automationId: string
	readonly role: string
	readonly nameHash: string
	readonly parentPath: string
	/** Among siblings with the same kind and name. */
	readonly ordinal: number
	/** When the owning process started (ms); a different value means a different program run. */
	readonly processStart: number
}

export interface A11yIdentityRequest {
	readonly windowId: string
	readonly index: number
	/** Refuse (`stale_snapshot`) when the window was read again since this revision. */
	readonly revision?: number
}

export interface A11yResolveRequest {
	readonly windowId: string
	readonly fingerprint: A11yFingerprint
}

export type A11yResolution =
	| {
			readonly found: true
			/** Index in the read this call made (it is the window's latest snapshot now). */
			readonly index: number
			readonly via: 'runtimeId' | 'automationId' | 'name'
			readonly revision: number
	  }
	| {
			readonly found: false
			readonly code: 'not_found' | 'ambiguous'
			readonly candidates?: number
	  }

export interface AccessibilityBackend {
	/** Which implementation this is, for diagnosis. */
	readonly id: string
	/** True once the backend answered its first greeting and has not ended since. */
	readonly isReady: boolean
	/** Starts the backend ahead of the first question. Does not wait; safe to repeat. */
	warm(): void
	/** Resolves true when the backend is up; false (never throws) when it cannot be. */
	ready(): Promise<boolean>
	/** The visible, un-cloaked, non-tool top-level windows, front to back. */
	listWindows(
		options?: { readonly includeOwned?: boolean },
		signal?: AbortSignal,
	): Promise<readonly A11yWindow[]>
	listDisplays(signal?: AbortSignal): Promise<readonly A11yDisplay[]>
	snapshot(request: A11ySnapshotRequest, signal?: AbortSignal): Promise<A11ySnapshot>
	/**
	 * A marker in the stream of changes. With a window it also starts
	 * watching that window (the first time costs about 100 ms), so that
	 * `const since = await seq(w); act(); await waitForChange({ windowId: w, since })`
	 * misses nothing the action did.
	 */
	seq(windowId?: string, signal?: AbortSignal): Promise<A11ySeq>
	/**
	 * Resolves from events, not from sleeping: after at least one change and
	 * then `quietMs` without another, or `{ changed: false }` after `timeoutMs`.
	 */
	waitForChange(request: A11yWaitRequest, signal?: AbortSignal): Promise<A11yWaitResult>
	identity(request: A11yIdentityRequest, signal?: AbortSignal): Promise<A11yFingerprint>
	resolve(request: A11yResolveRequest, signal?: AbortSignal): Promise<A11yResolution>
	close(): Promise<void>
}

/** A failure the backend reports, or the client's own (`timeout`, `helper_exited`, `unavailable`, …). */
export class A11yError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'A11yError'
	}
}
