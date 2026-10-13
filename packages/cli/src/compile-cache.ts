import { statSync } from 'node:fs'
import nodeModule from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * V8's compile cache for the CLI's own modules.
 *
 * Loading and compiling the command shell, the SDK and the screens is most
 * of what a launch spends (measured: about 180 ms compiling on `--version`
 * alone before the command graph was made lazy). Node can keep V8's compiled
 * code on disk and reuse it when the same source loads again;
 * `module.enableCompileCache(dir)` (Node 22.1 and later; the CLI requires
 * 22.13) turns that on for every module loaded after the call.
 *
 * Where it goes: `<namzu home>/cache/compile`, so it travels with the rest of
 * the state and `NAMZU_HOME` moves it. It is used only when that home already
 * exists as a directory (a link to one counts). An unset `NAMZU_HOME` means `~/.namzu`; a set
 * one is the operator's assertion and, as in the SDK's resolver, is not
 * created on the way, so a launch with a wrong path cannot make a directory
 * there. The cache is keyed by the module's content and Node's version, so an
 * upgrade or a rebuild never reads stale code, and a corrupt entry is
 * rejected and recompiled by Node itself.
 *
 * Never a reason to fail: a read-only home, a full disk, a Node without the
 * function, or a cache directory on a file system that refuses it each leave
 * the launch running uncached. The function reports what happened and does
 * not throw.
 *
 * Operators keep Node's own switches: `NODE_COMPILE_CACHE=<dir>` chooses a
 * directory (this then does nothing, because Node has already enabled it) and
 * `NODE_DISABLE_COMPILE_CACHE=1` turns the cache off.
 */

export type CompileCacheOutcome =
	| { readonly state: 'enabled'; readonly directory: string }
	| { readonly state: 'skipped'; readonly reason: string }
	| { readonly state: 'failed'; readonly reason: string }

export interface CompileCacheOptions {
	readonly env?: NodeJS.ProcessEnv
	/** The OS home directory when `NAMZU_HOME` is unset. */
	readonly home?: string
	/** The `node:module` surface; a test supplies its own. */
	readonly module?: {
		readonly enableCompileCache?: (directory?: string) => {
			readonly status: number
			readonly message?: string
			readonly directory?: string
		}
	}
}

// A link to a directory counts (a dotfiles setup often links ~/.namzu); only a
// home that does not exist yet is left alone, so nothing is created here.
function isRealDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}

export function enableStartupCompileCache(options: CompileCacheOptions = {}): CompileCacheOutcome {
	const env = options.env ?? process.env
	const mod = options.module ?? nodeModule
	if (typeof mod.enableCompileCache !== 'function') {
		return { state: 'skipped', reason: 'this Node has no module.enableCompileCache' }
	}
	if (env.NODE_DISABLE_COMPILE_CACHE) {
		return { state: 'skipped', reason: 'NODE_DISABLE_COMPILE_CACHE is set' }
	}
	if (env.NODE_COMPILE_CACHE) {
		return { state: 'skipped', reason: 'NODE_COMPILE_CACHE chose the directory' }
	}
	try {
		const configured = env.NAMZU_HOME
		const namzuHome =
			configured === undefined || configured.length === 0
				? resolve(options.home ?? homedir(), '.namzu')
				: configured
		if (namzuHome.includes('\0') || !isRealDirectory(namzuHome)) {
			return { state: 'skipped', reason: 'the Namzu home does not exist yet' }
		}
		const result = mod.enableCompileCache(join(namzuHome, 'cache', 'compile'))
		// Node's status: 0 FAILED, 1 ENABLED, 2 ALREADY_ENABLED, 3 DISABLED.
		if (result.status === nodeModule.constants.compileCacheStatus.ENABLED) {
			return { state: 'enabled', directory: result.directory ?? '' }
		}
		if (result.status === nodeModule.constants.compileCacheStatus.ALREADY_ENABLED) {
			return { state: 'skipped', reason: 'already enabled' }
		}
		return { state: 'failed', reason: result.message ?? 'Node did not enable the cache' }
	} catch (error) {
		return { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
	}
}
