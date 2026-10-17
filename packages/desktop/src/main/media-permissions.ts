/**
 * Electron grants every permission a page asks for unless a handler says otherwise. These handlers
 * change the answer for the microphone only: Namzu's own windows may open it, audio only, after the
 * person agreed to voice input. Every other permission is answered exactly as before (granted).
 */
export interface MediaPermissionPolicy {
	/** True only for the main window's own web contents. */
	isOwnWindow(webContents: unknown): boolean
	/** The one page the windows load. */
	page(): string
	/** The person accepted voice input. */
	accepted(): boolean
}

interface RequestDetails {
	requestingUrl?: string
	isMainFrame?: boolean
	mediaTypes?: readonly string[]
}
interface CheckDetails {
	requestingUrl?: string
	isMainFrame?: boolean
	mediaType?: string
}

/**
 * Whether `requesting` is the app's own page. Both sides go through the URL parser, so a fragment,
 * a query or a different but equivalent spelling of the same file path still counts as the page.
 */
function isAppPage(requesting: string | undefined, page: string): boolean {
	if (!requesting) return false
	try {
		const left = new URL(requesting)
		const right = new URL(page)
		left.hash = left.search = ''
		right.hash = right.search = ''
		return left.href === right.href
	} catch {
		return false
	}
}

/** Only an audio-only request from a window's own main frame, after consent. */
export function mayUseMicrophone(
	policy: MediaPermissionPolicy,
	webContents: unknown,
	details: { requestingUrl?: string; isMainFrame?: boolean },
	audioOnly: boolean,
): boolean {
	return (
		audioOnly &&
		policy.accepted() &&
		webContents !== null &&
		webContents !== undefined &&
		policy.isOwnWindow(webContents) &&
		details.isMainFrame === true &&
		isAppPage(details.requestingUrl, policy.page())
	)
}

export function decideMediaRequest(
	policy: MediaPermissionPolicy,
	webContents: unknown,
	permission: string,
	details: RequestDetails,
): boolean {
	if (permission !== 'media') return true
	const types = details.mediaTypes
	const audioOnly =
		Array.isArray(types) && types.length > 0 && types.every((type) => type === 'audio')
	return mayUseMicrophone(policy, webContents, details, audioOnly)
}

export function decideMediaCheck(
	policy: MediaPermissionPolicy,
	webContents: unknown,
	permission: string,
	details: CheckDetails,
): boolean {
	if (permission !== 'media') return true
	return mayUseMicrophone(policy, webContents, details, details.mediaType === 'audio')
}

/** The slice of Electron's `Session` used here. */
export interface PermissionSession {
	setPermissionRequestHandler(
		handler:
			| ((
					webContents: unknown,
					permission: string,
					callback: (granted: boolean) => void,
					details: RequestDetails,
			  ) => void)
			| null,
	): void
	setPermissionCheckHandler(
		handler:
			| ((
					webContents: unknown,
					permission: string,
					origin: string,
					details: CheckDetails,
			  ) => boolean)
			| null,
	): void
}

export function installMediaPermissions(
	session: PermissionSession,
	policy: MediaPermissionPolicy,
): void {
	session.setPermissionRequestHandler((webContents, permission, callback, details) =>
		callback(decideMediaRequest(policy, webContents, permission, details)),
	)
	session.setPermissionCheckHandler((webContents, permission, _origin, details) =>
		decideMediaCheck(policy, webContents, permission, details),
	)
}
