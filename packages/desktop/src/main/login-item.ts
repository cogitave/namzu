/** The part of Electron's login item API this file uses. */
export interface LoginItemApi {
	get(): { openAtLogin: boolean }
	set(settings: { openAtLogin: boolean }): void
}

export interface LoginItemResult {
	/** What the system says now. */
	enabled: boolean
	/** One plain line when the system did not keep the change. */
	problem?: string
}

/**
 * Whether Namzu can be started by the system at login here: Windows and macOS, and only for an
 * installed app. An app run from source would register the development runtime instead of Namzu.
 */
export function loginItemAvailable(platform: string, packaged: boolean): boolean {
	return packaged && (platform === 'win32' || platform === 'darwin')
}

export function readLoginItem(api: LoginItemApi): boolean {
	return api.get().openAtLogin === true
}

/** Asks the system for the wish, then reads the system back: what it says is the answer. */
export function applyLoginItem(
	api: LoginItemApi,
	wish: boolean,
	platform: string,
): LoginItemResult {
	try {
		api.set({ openAtLogin: wish })
	} catch {
		// The read below says what is true.
	}
	let enabled: boolean
	try {
		enabled = readLoginItem(api)
	} catch {
		return { enabled: !wish, problem: 'Namzu could not ask your system about this.' }
	}
	if (enabled === wish) return { enabled }
	const system = platform === 'darwin' ? 'macOS' : 'Windows'
	return {
		enabled,
		problem: wish
			? `${system} did not allow Namzu to start at sign-in, so it stays off.`
			: `${system} kept Namzu in its startup list. Remove it there.`,
	}
}
