/**
 * Whether a scheduled run with a browser grant can drive its browser, asked
 * before any model call: a run that would stop at its first browser call
 * because the profile is missing or the browser cannot start is
 * `blocked-config` with nothing spent, and says what to do.
 *
 * Checks, in order: `@namzu/browser` loads; the profile has a descriptor in
 * `NAMZU_HOME` and its user data directory is there; the engine the profile
 * was signed in with can run in this process's environment (for the Windows
 * browser from WSL: interop, `powershell.exe` and Chrome or Edge, which a
 * systemd service finds through `/run/WSL`); and a window, when the job
 * asks for one, has a display.
 *
 * The run uses the engine the profile belongs to, never another: a
 * profile signed in with the Windows Chrome has its cookies there, and a
 * local Chromium would start signed out.
 */

import { existsSync } from 'node:fs'
import type { BrowserEngineSetting, BrowserEnvironmentProbes } from '@namzu/browser'
import type { ScheduleBrowserGrant } from '@namzu/sdk'

export type BrowserPreflight =
	| {
			readonly ok: true
			/** The engine the profile belongs to, forced for the run. */
			readonly engine: Exclude<BrowserEngineSetting, 'auto'>
			/** Why the run's browser is what it is, for the run's warnings. */
			readonly warnings: readonly string[]
	  }
	| { readonly ok: false; readonly reason: string }

export interface BrowserPreflightDependencies {
	readonly env: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	/** Test seam: the file-system questions detection asks. */
	readonly probes?: BrowserEnvironmentProbes
	/** Test seam: whether a path exists. */
	readonly exists?: (path: string) => boolean
	/** Test seam: the browser package. */
	readonly load?: () => Promise<typeof import('@namzu/browser')>
}

export async function browserPreflight(
	grant: ScheduleBrowserGrant,
	home: string,
	deps: BrowserPreflightDependencies,
): Promise<BrowserPreflight> {
	let browser: typeof import('@namzu/browser')
	try {
		browser = await (deps.load ?? (() => import('@namzu/browser')))()
	} catch (error) {
		return {
			ok: false,
			reason: `the job uses the browser, but @namzu/browser cannot be loaded (${error instanceof Error ? error.message : String(error)}); run namzu doctor`,
		}
	}
	const login = `namzu browser login ${grant.profile} ${Object.keys(grant.sites)[0] ?? '<url>'}`
	let descriptor: ReturnType<InstanceType<typeof browser.BrowserProfileStore>['get']>
	try {
		descriptor = new browser.BrowserProfileStore(home).get(grant.profile)
	} catch (error) {
		return {
			ok: false,
			reason: `browser profile ${grant.profile} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	if (!descriptor) {
		return {
			ok: false,
			reason: `browser profile ${grant.profile} does not exist; sign in once with ${login}`,
		}
	}
	const engine = descriptor.engine === 'windows-cdp' ? 'windows' : 'local'
	const plan = browser.runnableBrowserPlan(
		browser.detectBrowserEnvironment(
			deps.env,
			deps.platform ?? process.platform,
			deps.probes ?? browser.nodeBrowserProbes,
			{ engine, headless: grant.headed ? 'never' : 'always', mode: 'unattended' },
		),
	)
	if (plan.unavailableReason !== undefined) {
		return {
			ok: false,
			reason: `the browser for profile ${grant.profile} cannot start here: ${plan.unavailableReason}`,
		}
	}
	if (plan.engine !== descriptor.engine) {
		return {
			ok: false,
			reason: `browser profile ${grant.profile} was signed in with ${descriptor.engine === 'windows-cdp' ? 'the Windows browser' : 'a browser inside Linux'}, and this run would use ${plan.engine === 'windows-cdp' ? 'the Windows browser' : 'a browser inside Linux'}`,
		}
	}
	const exists = deps.exists ?? existsSync
	const dataDir =
		plan.engine === 'windows-cdp'
			? browser.windowsPathToWsl(descriptor.userDataDir, plan.mountRoot)
			: descriptor.userDataDir
	if (dataDir === undefined || !exists(dataDir)) {
		return {
			ok: false,
			reason: `browser profile ${grant.profile} has no data at ${descriptor.userDataDir}; sign in again with ${login}`,
		}
	}
	return { ok: true, engine, warnings: plan.warnings }
}
