import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { describeBrowserPlan } from '../../browser/describe.js'
import { probeOptionalPackage } from '../../context/capabilities.js'

type BrowserModule = typeof import('@namzu/browser')

/**
 * Where the browser tools would run on this machine: the engine plan
 * `@namzu/browser` detects, without launching anything.
 *
 * `browser.installed` answers whether the package loads; this answers the
 * next question an operator has, which is whether it can drive a browser
 * here and which one. An engine that cannot run is `warn`, not `fail`: the
 * browser is optional and namzu runs without it.
 */
export async function describeBrowserEngine(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
	load: () => Promise<BrowserModule> = () => import('@namzu/browser'),
): Promise<DoctorCheckResult> {
	const probe = await probeOptionalPackage('@namzu/browser')
	if (probe.state !== 'present') {
		return {
			status: 'skipped',
			message:
				probe.state === 'absent'
					? '@namzu/browser not installed; no browser tools'
					: '@namzu/browser failed to load; see browser.installed',
		}
	}
	let mod: BrowserModule
	try {
		mod = await load()
	} catch (error) {
		return {
			status: 'skipped',
			message: `@namzu/browser failed to load: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	const detected = mod.detectBrowserEnvironment(env, platform)
	const plan = mod.runnableBrowserPlan(detected)
	const notes = plan.warnings.length > 0 ? ` (${plan.warnings.join(' ')})` : ''
	if (plan.unavailableReason !== undefined) {
		return {
			status: 'warn',
			message: `no browser can run here: ${plan.unavailableReason}`,
			remediation:
				plan.engine === 'local' && plan.browser === 'chromium'
					? 'namzu browser install'
					: 'Install Google Chrome, or set browser.engine in your config.',
		}
	}
	if (plan.engine === 'local' && plan.browser === 'chromium') {
		// Playwright's own build: present only after `namzu browser install`
		// (or an earlier Playwright install) put it in the browser cache.
		return {
			status: 'pass',
			message: `${describeBrowserPlan(plan)}${notes}`,
			remediation: 'If the first browser call says Chromium is missing: namzu browser install',
		}
	}
	return {
		status: plan.warnings.length > 0 ? 'warn' : 'pass',
		message: `${describeBrowserPlan(plan)}${notes}`,
	}
}

export const browserEngineCheck: DoctorCheck = {
	id: 'browser.engine',
	category: 'custom',
	run: (ctx): Promise<DoctorCheckResult> => describeBrowserEngine(ctx.env as NodeJS.ProcessEnv),
}
