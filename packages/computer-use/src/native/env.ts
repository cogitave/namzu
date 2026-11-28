/**
 * Which environment variable names the native helper.
 *
 * `NAMZU_NATIVE_HELPER` is the name. `NAMZU_WIN_HELPER` is what the variable
 * was called while the helper was `namzu-win`; it is still read when the new
 * one is absent or blank.
 *
 * Deprecated: the next major release of `@namzu/computer-use` stops reading
 * `NAMZU_WIN_HELPER` and accepting the `namzu-win/1` protocol name.
 */

/** The name of the variable that holds the path of the helper. */
export const NATIVE_HELPER_ENV = 'NAMZU_NATIVE_HELPER'

/** @deprecated The old name of {@link NATIVE_HELPER_ENV}; read only as a fallback. */
export const LEGACY_NATIVE_HELPER_ENV = 'NAMZU_WIN_HELPER'

/** The helper path the environment names, or undefined when it names none. */
export function nativeHelperFromEnv(env: NodeJS.ProcessEnv): string | undefined {
	const named = env[NATIVE_HELPER_ENV]?.trim()
	if (named) return named
	const legacy = env[LEGACY_NATIVE_HELPER_ENV]?.trim()
	return legacy || undefined
}

/** The helper path: the `helper` option when given (blank means none), else the environment's. */
export function resolveNativeHelper(
	option: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	if (option !== undefined) return option.trim() || undefined
	return nativeHelperFromEnv(env)
}
