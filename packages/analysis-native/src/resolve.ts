import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type SidecarSource = 'option' | 'env' | 'platform-package' | 'development'

export interface ResolvedSidecar {
	path: string
	source: SidecarSource
}

export const SIDECAR_ENV = 'NAMZU_ANALYSIS_NATIVE_BIN'

/** The per-platform package that carries the binary, e.g. `@namzu/analysis-native-linux-x64`. */
export function platformPackageName(
	platform: string = process.platform,
	arch: string = process.arch,
): string {
	return `@namzu/analysis-native-${platform}-${arch}`
}

function exeName(platform: string): string {
	return platform === 'win32' ? 'namzu-analysis-native.exe' : 'namzu-analysis-native'
}

function isFile(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isFile()
	} catch {
		return false
	}
}

export interface ResolveOptions {
	/** Explicit path. Wins over everything; a missing file is an error, not a fallthrough. */
	binaryPath?: string
	env?: NodeJS.ProcessEnv
	platform?: string
	arch?: string
	/** Override where `require.resolve` looks (tests). */
	resolvePackage?: (specifier: string) => string
	/** Package root for the development fallback (tests). */
	packageRoot?: string
}

/**
 * Where the sidecar binary is, in order of precedence:
 *
 * 1. `binaryPath`;
 * 2. `NAMZU_ANALYSIS_NATIVE_BIN`;
 * 3. the optional per-platform package `@namzu/analysis-native-<platform>-<arch>`
 *    (its `bin/namzu-analysis-native`);
 * 4. a local `target/release` (then `target/debug`) next to this package, which
 *    is what a checkout has after `pnpm build`.
 *
 * Returns null when none exists. An explicit path or env var that names a
 * missing file returns null as well, so a typo is not hidden by a fallback.
 */
export function resolveSidecar(options: ResolveOptions = {}): ResolvedSidecar | null {
	const env = options.env ?? process.env
	const platform = options.platform ?? process.platform
	const arch = options.arch ?? process.arch

	if (options.binaryPath) {
		return isFile(options.binaryPath) ? { path: options.binaryPath, source: 'option' } : null
	}
	const fromEnv = env[SIDECAR_ENV]
	if (fromEnv) return isFile(fromEnv) ? { path: fromEnv, source: 'env' } : null

	const require = createRequire(import.meta.url)
	const resolvePackage = options.resolvePackage ?? ((s: string) => require.resolve(s))
	try {
		const manifest = resolvePackage(`${platformPackageName(platform, arch)}/package.json`)
		const candidate = join(dirname(manifest), 'bin', exeName(platform))
		if (isFile(candidate)) return { path: candidate, source: 'platform-package' }
	} catch {
		// The optional package is not installed on this platform.
	}

	const root = options.packageRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..')
	for (const profile of ['release', 'debug']) {
		const candidate = join(root, 'target', profile, exeName(platform))
		if (isFile(candidate)) return { path: candidate, source: 'development' }
	}
	return null
}
