import { basename, resolve } from 'node:path'

/**
 * The name of the test profile this instance runs on, or nothing for the normal one.
 *
 * An instance started with its own `--user-data-dir` (a test copy, a second profile) keeps its own
 * sessions and its own tray icon. Marking it keeps it from being taken for the person's Namzu: the
 * window title and the tray tooltip read `Namzu (test: <folder>)`. The flag naming the folder the
 * normal profile already uses is not a test profile. Only that flag marks a profile: nothing in
 * the app switches its own folder, so a path set another way would not be marked.
 */
export function testProfileName(input: {
	argv: readonly string[]
	userData: string
	defaultUserData: string
}): string | undefined {
	const named = input.argv.some(
		(arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='),
	)
	if (!named) return undefined
	if (resolve(input.userData) === resolve(input.defaultUserData)) return undefined
	return basename(resolve(input.userData)) || undefined
}

/** `Namzu`, or `Namzu (test: <folder>)` on a test profile. */
export function productTitle(profile: string | undefined): string {
	return profile === undefined ? 'Namzu' : `Namzu (test: ${profile})`
}
