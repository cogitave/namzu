import { probeOptionalPackage } from '../context/capabilities.js'

type BrowserModule = typeof import('@namzu/browser')

/** What Desktop's Connected browsers table says about the browser Namzu drives. */
export interface BrowserStatus {
	/** The browser tools are switched on (`browser.enabled`, from the user's own file). */
	enabled: boolean
	/**
	 * `ready`: a browser can run here. `warning`: one can, with a caution. `unavailable`: none can.
	 * `off`: the tools are switched off. `missing`: the browser package is not installed.
	 */
	state: 'ready' | 'warning' | 'unavailable' | 'off' | 'missing'
	/** One plain line: which browser, where, and whether it shows a window. */
	text: string
}

export interface BrowserStatusInput {
	enabled: boolean
	engine?: 'auto' | 'windows' | 'local'
	headless?: 'auto' | 'always' | 'never'
	env?: NodeJS.ProcessEnv
	platform?: NodeJS.Platform
	load?: () => Promise<BrowserModule>
	/** Whether the browser package is installed; probed when not given. */
	installed?: () => Promise<boolean>
}

const PLAIN_NAMES: Record<string, string> = {
	chrome: 'Google Chrome',
	msedge: 'Microsoft Edge',
	chromium: 'Chromium',
}

/** The plan in words for the Settings table: no engine id, path or bridge, only which browser and where. */
function plainPlan(plan: {
	engine: string
	browser: string
	platform: string
	headless: boolean
}): string {
	const name = PLAIN_NAMES[plan.browser] ?? plan.browser
	const where =
		plan.engine === 'windows-cdp'
			? 'on Windows'
			: plan.platform === 'wsl'
				? 'inside WSL'
				: 'on this computer'
	return `${name} ${where}, ${plan.headless ? 'with no window' : 'with a visible window'}`
}

/**
 * Which browser the engine would drive on this computer, for the Settings table. Reads the machine
 * and launches nothing, like `namzu browser status`.
 */
export async function browserStatus(input: BrowserStatusInput): Promise<BrowserStatus> {
	const { enabled } = input
	if (!enabled) return { enabled, state: 'off', text: 'Browser tools are switched off.' }
	const installed =
		input.installed ??
		(async () => (await probeOptionalPackage('@namzu/browser')).state === 'present')
	if (!(await installed()))
		return { enabled, state: 'missing', text: 'The browser package is not installed.' }
	let mod: BrowserModule
	try {
		mod = await (input.load ?? (() => import('@namzu/browser')))()
	} catch {
		return { enabled, state: 'unavailable', text: 'The browser package could not be loaded.' }
	}
	const plan = mod.runnableBrowserPlan(
		mod.detectBrowserEnvironment(
			input.env ?? process.env,
			input.platform ?? process.platform,
			undefined,
			{
				...(input.engine ? { engine: input.engine } : {}),
				headless: input.headless ?? 'auto',
				mode: 'interactive',
			},
		),
	)
	if (plan.unavailableReason !== undefined)
		return {
			enabled,
			state: 'unavailable',
			text: `No browser can run here: ${plan.unavailableReason}`,
		}
	const notes = plan.warnings.length > 0 ? ` ${plan.warnings.join(' ')}` : ''
	return {
		enabled,
		state: plan.warnings.length > 0 ? 'warning' : 'ready',
		text: `${plainPlan(plan)}.${notes}`,
	}
}
