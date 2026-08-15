import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The tri-state probe for an optional package: not installed, installed and
 * working, or installed and broken.
 *
 * Moved here from `doctor/checks/telemetry.ts`, where it was built once, for
 * one package, and never generalised — so `namzu doctor` could tell a
 * genuinely absent `@namzu/telemetry` from a broken one, but the BOOT PATH,
 * which never called into `doctor/`, could not tell the same thing about
 * `@namzu/sandbox`. A sandbox whose native binding fails to load in a
 * container image resolves (`require.resolve` succeeds — the files are on
 * disk) and then throws on import; with no probe at boot, that failure had
 * no path to the operator except a stack trace from wherever the sandbox
 * was first used, long after `namzu doctor` would have said `fail`.
 *
 * `probeOptionalPackage` and `probeCapabilities` are that probe, extracted
 * so the doctor's checks and the boot narrative (NZ-BOOT-05) read the SAME
 * answer instead of two implementations that can drift.
 *
 * ## Resolving and loading are asked separately, on purpose
 *
 * A `try { await import(pkg) } catch { present = false }` cannot tell "not
 * installed" from "installed and broken" — both throw, and collapsing them
 * silently turns a machine that would fail loudly into one that reports
 * "optional, skip it" while running degraded with nothing in the log to say
 * why. `an-optional-dependency-may-not-degrade-a-check` exists for exactly
 * this shape of bug.
 *
 * A code check on the thrown error is not enough to separate them either: a
 * TRANSITIVE dependency of the target package that cannot resolve raises
 * `ERR_MODULE_NOT_FOUND` identically to the target package itself being
 * missing, so matching the error code would report a broken installation as
 * no installation. `require.resolve` asks only about THIS specifier — it
 * either finds `specifier` on disk or it does not — so it separates the two
 * questions by construction rather than by reading a message or a code that
 * may be reworded or reused upstream.
 *
 *   - `require.resolve` throws           → not on disk at all → `absent`
 *   - resolves, then `import()` throws   → on disk, unusable  → `broken`
 *   - resolves, then `import()` succeeds → on disk, working   → `present`
 */
export type CapabilityProbe =
	| { readonly state: 'present'; readonly specifier: string; readonly version: string }
	| { readonly state: 'absent'; readonly specifier: string }
	| { readonly state: 'broken'; readonly specifier: string; readonly error: Error }

/**
 * The optional packages namzu runs without. Listed once so the doctor's
 * per-package checks, the boot narrative's `capability` line (NZ-BOOT-05),
 * and this module's own tests all read the SAME set — a capability added
 * here with no check wired to it is exactly the gap
 * `doctor/checks/__tests__/index.test.ts` fails the build on.
 */
export const NAMZU_OPTIONAL_CAPABILITIES = [
	'@namzu/sandbox',
	'@namzu/files',
	'@namzu/computer-use',
	'@namzu/telemetry',
] as const

/**
 * The `DoctorCheck.id` a capability's probe is registered under —
 * `@namzu/computer-use` → `computer-use.installed`, matching the id
 * `telemetryInstalledCheck` already shipped under before this module
 * existed. A function rather than a literal table so the registration site
 * and the test that enumerates it derive the SAME id from the SAME rule;
 * two hardcoded copies is how one of them goes stale.
 */
export function capabilityCheckId(specifier: string): string {
	const name = specifier.split('/').pop() ?? specifier
	return `${name}.installed`
}

/**
 * Read the `version` of the package whose entry point resolved to
 * `fromFile`, by walking UP the directory tree from that file to the
 * nearest `package.json`.
 *
 * Not `require.resolve('<specifier>/package.json')`: a package built with a
 * strict `exports` map does not expose its own manifest through that map —
 * Node raises `ERR_PACKAGE_PATH_NOT_EXPORTED` — which would report an
 * installed, loadable package as broken over a question nobody asked about
 * its runtime behaviour. The entry file Node already resolved sits inside
 * the package's own directory tree regardless of what the export map
 * exposes, so climbing from there to the nearest manifest reads the version
 * straight off disk without going through the map at all.
 */
function readVersionNear(fromFile: string): string {
	let dir = dirname(fromFile)
	for (;;) {
		const candidate = join(dir, 'package.json')
		if (existsSync(candidate)) {
			try {
				const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
				if (typeof pkg.version === 'string') return pkg.version
			} catch {
				// A malformed package.json this close to a resolved entry file is
				// not this function's problem to diagnose — keep climbing in case
				// an ancestor directory holds the real one.
			}
		}
		const parent = dirname(dir)
		if (parent === dir) return '0.0.0' // hit the filesystem root; nothing found
		dir = parent
	}
}

/**
 * Whether `specifier` is installed, and whether it loads.
 *
 * Never throws — every failure mode below (unresolvable, throws on import,
 * throws something that is not an `Error`) is turned into a
 * `CapabilityProbe` value, which is what lets `probeCapabilities` await all
 * four in parallel with nothing to catch.
 *
 * The import goes through the RESOLVED path rather than the specifier, so
 * one code path serves both a package name and a fixture file — the same
 * arrangement `doctor/checks/telemetry.ts` used this for, kept because it
 * is what lets a test drive all three states without being able to
 * uninstall or break a real optional package inside a test run.
 */
export async function probeOptionalPackage(specifier: string): Promise<CapabilityProbe> {
	const require = createRequire(import.meta.url)
	let resolved: string
	try {
		resolved = require.resolve(specifier)
	} catch {
		return { state: 'absent', specifier }
	}
	try {
		await import(pathToFileURL(resolved).href)
		return { state: 'present', specifier, version: readVersionNear(resolved) }
	} catch (err) {
		return {
			state: 'broken',
			specifier,
			error: err instanceof Error ? err : new Error(String(err)),
		}
	}
}

/**
 * Probe every optional capability namzu knows about.
 *
 * Deliberately NOT re-exported from the package index yet: its consumer is
 * the boot narrative, which is a later commit, and an exported symbol with no
 * caller is the shape `declared-but-undriven` is about. Its parts are each
 * driven today — the doctor builds one check per entry of the list, through
 * `probeOptionalPackage` — so this stays here, with the test that proves the
 * never-rejects property the boot path will depend on, and joins the public
 * surface in the commit that consumes it.
 *
 * Never rejects: `probeOptionalPackage` already turns every resolve/import
 * failure into a `broken` record rather than a thrown one, so this
 * `Promise.all` has nothing to catch — a broken package can degrade what
 * the boot narrative SAYS, never abort the boot itself.
 */
export async function probeCapabilities(): Promise<readonly CapabilityProbe[]> {
	return Promise.all(
		NAMZU_OPTIONAL_CAPABILITIES.map((specifier) => probeOptionalPackage(specifier)),
	)
}
