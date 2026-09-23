/**
 * An engine plan in words, for `namzu doctor`, `namzu browser status` and
 * `/browser`. Types only from `@namzu/browser`: describing a plan must not
 * load Playwright.
 */

import type { BrowserEnginePlan } from '@namzu/browser'

const BROWSER_NAMES: Record<string, string> = {
	chrome: 'Google Chrome',
	msedge: 'Microsoft Edge',
	chromium: "Playwright's Chromium",
}

export function browserName(browser: string): string {
	return BROWSER_NAMES[browser] ?? browser
}

/** `windows-cdp`, `local-chrome`, …: the engine as the tools and the logs name it. */
export function engineLabel(plan: BrowserEnginePlan): string {
	return plan.engine === 'local' ? `local-${plan.browser}` : plan.engine
}

/** One line: which browser, where, and whether it shows a window. */
export function describeBrowserPlan(plan: BrowserEnginePlan): string {
	const window = plan.headless ? 'no window (headless)' : 'a visible window'
	if (plan.engine === 'windows-cdp') {
		return `${engineLabel(plan)}: ${browserName(plan.browser)} on Windows (${plan.windowsExecutable}), driven from WSL through the PowerShell bridge (${plan.networkingMode} networking), ${window}`
	}
	const where = plan.platform === 'wsl' ? 'inside WSL' : `on ${plan.platform}`
	return `${engineLabel(plan)}: ${browserName(plan.browser)} ${where}, ${window}`
}
