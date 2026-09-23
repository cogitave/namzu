// ---------------------------------------------------------------------------
// The browser contract: what a browser host does for the `browser` and
// `browser_act` tools. The SDK owns the model-facing tools and this
// interface; a host package (for example `@namzu/browser`) owns the engine.
// ---------------------------------------------------------------------------

/** Every action the `browser` tool (observe and navigate) can ask for. */
export type BrowserObserveActionName =
	| 'navigate'
	| 'back'
	| 'forward'
	| 'reload'
	| 'snapshot'
	| 'screenshot'
	| 'scroll'
	| 'wait_for'
	| 'tabs'

/** Every action the `browser_act` tool (change the page) can ask for. */
export type BrowserActActionName =
	| 'click'
	| 'type'
	| 'fill_form'
	| 'select'
	| 'press'
	| 'hover'
	| 'upload'
	| 'dialog'

export type BrowserActionName = BrowserObserveActionName | BrowserActActionName

export type BrowserScrollDirection = 'up' | 'down' | 'left' | 'right'

export type BrowserTabsOp = 'list' | 'select' | 'close' | 'new'

// ---------------------------------------------------------------------------
// Capabilities — frozen at host construction; the model reads them through
// the tools' descriptions and schemas.
// ---------------------------------------------------------------------------

export interface BrowserCapabilities {
	/** Which engine drives the browser, in words: `local-chromium`, `windows-cdp`. */
	readonly engine: string
	/** The browser window is not shown. */
	readonly headless: boolean
	/** `screenshot` can return an image. */
	readonly screenshot: boolean
	/** `upload` can attach a local file to a file input. */
	readonly upload: boolean
	/**
	 * Exact action subset when known. Absent: every action whose broad flag
	 * above allows it. Actions outside the subset are removed from the model
	 * schema and refused before the host is called.
	 */
	readonly supportedActions?: readonly BrowserActionName[]
	/**
	 * The most snapshot text one call returns. The tool cuts anything longer.
	 * Absent: {@link BROWSER_SNAPSHOT_MAX_CHARS}.
	 */
	readonly snapshotMaxChars?: number
	/**
	 * Why the browser cannot be used at all — the engine is not installed,
	 * the profile is missing. Present, both tools stay mounted, say this in
	 * their descriptions and refuse every call with it, so the model reads
	 * the reason once and tells the user instead of retrying.
	 */
	readonly unavailableReason?: string
}

/** Default and ceiling of snapshot text per call, in characters. */
export const BROWSER_SNAPSHOT_MAX_CHARS = 20_000

/** Longest `wait_for` the tool accepts, in milliseconds. */
export const BROWSER_WAIT_MAX_MS = 30_000

/** Most fields one `fill_form` call may set. */
export const BROWSER_FILL_FORM_MAX_FIELDS = 20

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * What the `browser` tool asks of the host. Every URL here has already been
 * canonicalised by the tool (see `canonicalizeBrowserUrl`): only http, https
 * or `about:blank`, no credentials, never a cloud metadata address.
 */
export type BrowserObserveAction =
	| { readonly action: 'navigate'; readonly url: string }
	| { readonly action: 'back' }
	| { readonly action: 'forward' }
	| { readonly action: 'reload' }
	| { readonly action: 'snapshot'; readonly ref?: string; readonly cursor?: string }
	| { readonly action: 'screenshot'; readonly ref?: string; readonly fullPage?: boolean }
	| {
			readonly action: 'scroll'
			readonly direction: BrowserScrollDirection
			readonly ref?: string
			/** Screens to scroll; the host's default when absent. */
			readonly amount?: number
	  }
	| {
			readonly action: 'wait_for'
			readonly text?: string
			readonly textGone?: string
			readonly timeMs?: number
	  }
	| {
			readonly action: 'tabs'
			readonly op: BrowserTabsOp
			/** `select` and `close`: the tab id from `list` or a page header. */
			readonly tab?: string
			/** `new`: the address to open; `about:blank` when absent. */
			readonly url?: string
	  }

export interface BrowserFormField {
	readonly ref: string
	/** Text for a text box; `true`/`false` for a checkbox; the option's label for a select. */
	readonly value: string
}

/** The change a `browser_act` call makes. */
export type BrowserActOperation =
	| { readonly action: 'click'; readonly ref: string; readonly doubleClick?: boolean }
	| {
			readonly action: 'type'
			readonly ref: string
			readonly text: string
			/** Press Enter after typing. */
			readonly submit?: boolean
	  }
	| { readonly action: 'fill_form'; readonly fields: readonly BrowserFormField[] }
	| { readonly action: 'select'; readonly ref: string; readonly values: readonly string[] }
	| { readonly action: 'press'; readonly key: string; readonly ref?: string }
	| { readonly action: 'hover'; readonly ref: string }
	| { readonly action: 'upload'; readonly ref: string; readonly path: string }
	| { readonly action: 'dialog'; readonly accept: boolean; readonly promptText?: string }

/**
 * What the `browser_act` tool asks of the host.
 *
 * `origin` is the page origin the model read from the snapshot header
 * (`Page: <origin> — …`), canonicalised by the tool. **The host MUST compare
 * it with the live origin of the page it is about to act on, immediately
 * before acting, and throw a {@link BrowserOriginMismatch} without acting
 * when they differ.** That comparison is what binds an approval of "click
 * Place order on shop.example.com" to shop.example.com: a redirect between
 * the snapshot and the click must not carry the click to another site.
 */
export type BrowserActAction = BrowserActOperation & {
	readonly origin: string
	/** Return a snapshot of the page after the action. */
	readonly snapshot?: boolean
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The page an action left the browser on, as the host observed it. */
export interface BrowserPageInfo {
	/** Canonical origin (`https://github.com`), or `null` for `about:blank`. */
	readonly origin: string
	readonly url: string
	/** The document title. Page-controlled: the tool quotes and cuts it. */
	readonly title: string
	/** The tab's id, e.g. `t1`. */
	readonly tab: string
}

export interface BrowserTabInfo extends BrowserPageInfo {
	readonly active: boolean
}

export interface BrowserSnapshot {
	readonly page: BrowserPageInfo
	/**
	 * The accessibility tree as text, one element per line, each actionable
	 * element carrying `[ref=eN]`. Page-controlled: the tool wraps it as
	 * untrusted content.
	 */
	readonly text: string
	/** Present when more text follows; pass it back as `cursor`. */
	readonly nextCursor?: string
}

export interface BrowserScreenshot {
	readonly page: BrowserPageInfo
	readonly data: Uint8Array
	readonly mimeType: 'image/png' | 'image/jpeg'
	readonly width: number
	readonly height: number
}

/**
 * What an action produced. Every field is optional because actions differ;
 * the tool renders whichever are present.
 */
export interface BrowserResult {
	/** The page after the action. */
	readonly page?: BrowserPageInfo
	/**
	 * The host's own note, in the host's words — "download of report.pdf
	 * cancelled", "dialog accepted". Never page text: the tool shows it
	 * outside the untrusted envelope.
	 */
	readonly message?: string
	readonly snapshot?: BrowserSnapshot
	readonly screenshot?: BrowserScreenshot
	readonly tabs?: readonly BrowserTabInfo[]
}

/** What a snapshot said about one ref, for labelling a call before it runs. */
export interface BrowserRefDescription {
	/** ARIA role: `button`, `link`, `textbox`. */
	readonly role: string
	/** Accessible name. Page-controlled. */
	readonly name?: string
}

/** Who and where, for labels and reviews. May change between calls. */
export interface BrowserSessionInfo {
	/** The profile the browser runs under. */
	readonly profile?: string
	/** Canonical origin of the active tab, when the host knows it. */
	readonly origin?: string
}

// ---------------------------------------------------------------------------
// Structural errors. Hosts throw values carrying these shapes; the tools
// recognise them by shape, so a separately installed host and SDK need not
// share an error class.
// ---------------------------------------------------------------------------

/** The live page is not on the origin a `browser_act` call named. Nothing was done. */
export interface BrowserOriginMismatch {
	readonly code: 'browser_origin_mismatch'
	readonly expected: string
	readonly actual: string
	readonly message: string
}

/** The ref is not on the current page: it came from an older snapshot. Nothing was done. */
export interface BrowserStaleRef {
	readonly code: 'browser_stale_ref'
	readonly ref: string
	readonly message: string
}

/** Why the page needs a person. */
export type BrowserHumanRequiredReason =
	| 'sign-in'
	| 'two-factor'
	| 'captcha'
	| 'bot-block'
	| 'http-auth'
	| 'credential-field'

/**
 * The page needs a person: a sign-in, a second factor, a CAPTCHA, a bot
 * wall, or a field that takes a password or one-time code. The agent must
 * stop and hand over; it never signs in, solves or types a credential.
 */
export interface BrowserHumanRequired {
	readonly code: 'browser_human_required'
	readonly reason: BrowserHumanRequiredReason
	readonly origin: string
	readonly message: string
	readonly profile?: string
	/** The command that opens a visible window on this profile, e.g. `namzu browser login work https://…`. */
	readonly loginCommand?: string
}

/**
 * A page-changing action started and did not report a clean completion. The
 * page may already have changed, so replaying it is unsafe.
 */
export interface BrowserOutcomeUnknown {
	readonly code: 'browser_outcome_unknown'
	readonly action: BrowserActionName
	readonly outcome: 'unknown'
	readonly retrySafety: 'unsafe'
	readonly message: string
}

/** The site policy does not allow this origin at the level the call needs. */
export interface BrowserSiteDenied {
	readonly code: 'browser_site_denied'
	readonly origin: string
	readonly message: string
}

export type BrowserHostError =
	| BrowserOriginMismatch
	| BrowserStaleRef
	| BrowserHumanRequired
	| BrowserOutcomeUnknown
	| BrowserSiteDenied

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface BrowserCallOptions {
	/** Fires when the call is cancelled or times out. */
	readonly signal?: AbortSignal
}

/**
 * A browser the tools drive. Implementations live outside `@namzu/sdk`.
 *
 * The host is where the site policy is enforced after the fact: whatever the
 * gate approved, the host re-checks the page a navigation, redirect or popup
 * actually landed on, and the live origin before every `act`.
 */
export interface BrowserHost {
	readonly id: string
	readonly capabilities: BrowserCapabilities

	/** Observe or navigate. Throws a {@link BrowserHostError} shape to refuse. */
	observe(action: BrowserObserveAction, options?: BrowserCallOptions): Promise<BrowserResult>
	/**
	 * Change the page. MUST check `action.origin` against the live page first
	 * (see {@link BrowserActAction}). Throws a {@link BrowserHostError} shape
	 * to refuse.
	 */
	act(action: BrowserActAction, options?: BrowserCallOptions): Promise<BrowserResult>

	/**
	 * What the most recent snapshot said about `ref`, synchronously and
	 * without touching the page, for the label a person approves. Undefined
	 * when the ref is unknown.
	 */
	describeRef?(ref: string): BrowserRefDescription | undefined
	/** The current profile and page, synchronously, for labels. */
	session?(): BrowserSessionInfo

	initialize?(): Promise<void>
	dispose?(): Promise<void>
}
