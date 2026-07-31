/**
 * Test-only path helpers.
 *
 * `node:path.join` produces platform-native separators, which is correct —
 * the SDK should hand the OS the paths the OS expects. Assertions written
 * as POSIX string literals therefore fail on Windows even though the code
 * is right, which used to leave three suites permanently red for every
 * Windows contributor. Compare path *structure* instead of separator style.
 */

/** Normalize a path's separators so an assertion can be written once. */
export function posix(p: string | undefined): string {
	return (p ?? '').replaceAll('\\', '/')
}

/** True when running on Windows, for the few cases that cannot be normalized away. */
export const IS_WINDOWS = process.platform === 'win32'
