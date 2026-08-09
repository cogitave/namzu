import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

const TELEMETRY = '@namzu/telemetry'

/**
 * Telemetry presence probe.
 *
 * Per ses_004 D1=B, `@namzu/telemetry` is a separate optional package.
 * This check reports whether it is installed; absence is informational
 * (not a failure). Endpoint reachability + dry-run span export are
 * deferred to a follow-up check that the consumer can register
 * themselves once their telemetry config is known.
 *
 * ## Resolving and loading are asked separately, on purpose
 *
 * This used to be one `import()` in a `try`, and every rejection was reported
 * as `not installed (optional package)`. A package that IS installed and throws
 * on load — a broken build, a native binding that will not open, a dependency
 * of its own that cannot resolve — was reported as absent. One word, two facts,
 * and the reader is told the reassuring one.
 *
 * Splitting the question is what makes each answer honest, and a code check on
 * the thrown error is not enough to do it: a transitive dependency that cannot
 * resolve raises `ERR_MODULE_NOT_FOUND` exactly as a missing `@namzu/telemetry`
 * does, so matching on the code would report a broken installation as no
 * installation. `resolve` asks only about THIS specifier, so it separates the
 * two by construction rather than by reading a message that may be reworded.
 *
 *   - cannot resolve  → the package is not here          → `skipped`
 *   - resolves, import throws → it is here and unusable  → `fail`
 */
/**
 * Whether `specifier` is installed, and whether it loads.
 *
 * Exported separately from the `DoctorCheck` so all three outcomes can be
 * driven with a specifier the test controls — there is no way to uninstall or
 * break the real optional package from inside a test run. The check itself is
 * still exercised through `telemetryInstalledCheck.run`, because a helper
 * proven in isolation says nothing about whether the check reaches it. Same
 * arrangement, and the same reason, as `describeProviderChain`.
 *
 * The import goes through the RESOLVED path rather than the specifier, so one
 * code path serves a package name and a file, which is what lets the
 * present-but-broken case be reached at all. Resolution has already applied the
 * package's export map by that point.
 */
export async function describeInstalledPackage(specifier: string): Promise<DoctorCheckResult> {
	const require = createRequire(import.meta.url)
	let resolved: string
	try {
		resolved = require.resolve(specifier)
	} catch {
		return {
			status: 'skipped',
			message: `${specifier} not installed (optional package)`,
		}
	}
	try {
		await import(pathToFileURL(resolved).href)
		return { status: 'pass', message: `${specifier} is installed` }
	} catch (err) {
		return {
			status: 'fail',
			// The reason is the whole value of separating these: "installed but
			// will not load" sends the reader somewhere, and "not installed" would
			// have sent them to install what is already there.
			message: `${specifier} is installed but failed to load: ${
				err instanceof Error ? err.message : String(err)
			}`,
			remediation: `Reinstall ${specifier}, or remove it if you are not using telemetry — it is optional and namzu runs without it.`,
		}
	}
}

export const telemetryInstalledCheck: DoctorCheck = {
	id: 'telemetry.installed',
	category: 'telemetry',
	run: (): Promise<DoctorCheckResult> => describeInstalledPackage(TELEMETRY),
}
