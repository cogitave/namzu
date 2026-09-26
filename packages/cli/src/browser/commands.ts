/**
 * `namzu browser <verb>`: the operator's side of the browser. Profiles are
 * made and signed in to here, in a visible window, never by the model.
 *
 * - `login <profile> [url]`  open a visible window on the profile; return when
 *   the person presses Enter or closes the window
 * - `list [--json]`          the profiles and when each was last signed in to
 * - `status [profile] [--json]`  which browser the tools would drive here
 * - `install [--dry-run]`    Playwright's Chromium, for a machine with no Chrome
 * - `remove <profile> [--yes]`  delete a profile and its cookies
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { canonicalizeBrowserUrl } from '@namzu/sdk'

import type { CommandContext } from '../commands/types.js'
import { EXIT_FAIL, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { flag, has, interactive, parseArgs } from '../schedule/commands/args.js'
import { isBrowserProfileName } from './control.js'
import { browserName, describeBrowserPlan, engineLabel } from './describe.js'

type BrowserModule = typeof import('@namzu/browser')

export const BROWSER_HELP = [
	'Usage: namzu browser <command> [options]',
	'',
	'The browser the interactive terminal drives (the browser and browser_act',
	'tools). A profile is a browser user-data directory namzu owns: sign in to',
	'a site once here, in a visible window, and the agent reuses the sign-in.',
	'The model never signs in, and never chooses the profile.',
	'',
	'Commands',
	'  login <profile> [url]        Open a visible window on the profile at url.',
	'                               Sign in, then press Enter or close the window.',
	'  list [--json]                Profiles, their browser, last sign-in',
	'  status [profile] [--json]    Which browser runs here, and a profile in detail',
	'  install [--dry-run]          Download Playwright’s Chromium (not needed when',
	'                               Chrome is installed, or in WSL with Windows Chrome)',
	'  remove <profile> [--yes]     Delete a profile and everything signed in to it',
	'',
	'Options: --home <dir> (default NAMZU_HOME).',
	'Config: browser.defaultProfile, browser.engine (auto|windows|local),',
	'browser.headless (auto|always|never), browser.sites, browser.keepOpen.',
	'',
	'Exit codes: 0 done, 1 failed, 64 wrong arguments, 69 no browser can run here.',
].join('\n')

/** What the commands need from outside, so tests can stand in for each. */
export interface BrowserCommandDeps {
	readonly load: () => Promise<BrowserModule>
	readonly env: NodeJS.ProcessEnv
	readonly platform: NodeJS.Platform
	/** Resolves when the person presses Enter; never, without a terminal. */
	readonly waitForEnter: (signal: AbortSignal) => Promise<void>
	/** How often `login` looks for a closed window, in ms. */
	readonly pollMs: number
	readonly spawnInstall: (args: readonly string[]) => Promise<number>
}

function waitForEnterOnStdin(signal: AbortSignal): Promise<void> {
	if (!process.stdin.isTTY) return new Promise(() => {})
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin })
		const done = () => {
			rl.close()
			resolve()
		}
		rl.once('line', done)
		signal.addEventListener('abort', () => rl.close(), { once: true })
	})
}

/** `node playwright-core/cli.js install chromium`, the version `@namzu/browser` pins. */
async function spawnPlaywrightInstall(args: readonly string[]): Promise<number> {
	const browserEntry = fileURLToPath(import.meta.resolve('@namzu/browser'))
	// `cli.js` is not in playwright-core's export map; its manifest is.
	const manifest = createRequire(browserEntry).resolve('playwright-core/package.json')
	const cli = join(dirname(manifest), 'cli.js')
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, 'install', ...args, 'chromium'], {
			stdio: 'inherit',
		})
		child.on('exit', (code) => resolve(code ?? 1))
		child.on('error', () => resolve(1))
	})
}

export const defaultBrowserCommandDeps: BrowserCommandDeps = {
	load: () => import('@namzu/browser'),
	env: process.env,
	platform: process.platform,
	waitForEnter: waitForEnterOnStdin,
	pollMs: 500,
	spawnInstall: spawnPlaywrightInstall,
}

function homeOf(args: ReturnType<typeof parseArgs>, deps: BrowserCommandDeps): string {
	const home = flag(args, 'home')
	return home ? resolvePath(home) : resolveNamzuHome({ env: deps.env })
}

function detectPlan(
	mod: BrowserModule,
	ctx: CommandContext,
	deps: BrowserCommandDeps,
	headed = false,
) {
	const browser = ctx.config.browser
	return mod.runnableBrowserPlan(
		mod.detectBrowserEnvironment(deps.env, deps.platform, undefined, {
			...(browser?.engine ? { engine: browser.engine } : {}),
			headless: headed ? 'never' : (browser?.headless ?? 'auto'),
			mode: 'interactive',
		}),
	)
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message
	const message = (error as { message?: unknown } | null)?.message
	return typeof message === 'string' ? message : String(error)
}

export async function browserCommand(
	ctx: CommandContext,
	argv: readonly string[],
	deps: BrowserCommandDeps = defaultBrowserCommandDeps,
): Promise<number> {
	const [verb, ...rest] = argv
	switch (verb) {
		case 'login':
			return loginCommand(ctx, rest, deps)
		case 'list':
		case 'ls':
			return listCommand(ctx, rest, deps)
		case 'status':
			return statusCommand(ctx, rest, deps)
		case 'install':
			return installCommand(ctx, rest, deps)
		case 'remove':
		case 'rm':
			return removeCommand(ctx, rest, deps)
		default:
			ctx.formatter.error({
				message: verb ? `unknown browser command: ${verb}` : 'a browser command is required',
			})
			ctx.formatter.print({ text: BROWSER_HELP })
			return EXIT_USAGE
	}
}

async function loginCommand(
	ctx: CommandContext,
	argv: readonly string[],
	deps: BrowserCommandDeps,
): Promise<number> {
	const args = parseArgs(argv, ['home'])
	const [profile, rawUrl, ...extra] = args.positionals
	if (args.unknown.length > 0 || !profile || extra.length > 0) {
		ctx.formatter.error({ message: 'usage: namzu browser login <profile> [url]' })
		return EXIT_USAGE
	}
	if (!isBrowserProfileName(profile)) {
		ctx.formatter.error({
			message: `"${profile}" is not a profile name: use lowercase letters, digits and single hyphens, at most 64 characters.`,
		})
		return EXIT_USAGE
	}
	let url = 'about:blank'
	if (rawUrl !== undefined) {
		// A bare host is what people type; the browser needs a scheme.
		const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
		const verdict = canonicalizeBrowserUrl(withScheme)
		if (!verdict.ok) {
			ctx.formatter.error({ message: `${rawUrl}: ${verdict.reason}` })
			return EXIT_USAGE
		}
		url = verdict.url
	}
	const mod = await deps.load()
	const home = homeOf(args, deps)
	const plan = detectPlan(mod, ctx, deps, true)
	if (plan.unavailableReason !== undefined) {
		ctx.formatter.error({
			message: `Cannot open a browser window here: ${plan.unavailableReason}`,
			details: {
				hint: plan.display
					? 'Install Google Chrome, or run `namzu browser install`.'
					: 'Signing in needs a display: run this where you have a desktop (or `ssh -X`, or `xvfb-run` with a VNC viewer), then reuse the profile here.',
			},
		})
		return EXIT_UNAVAILABLE
	}
	const host = new mod.PlaywrightBrowserHost({
		profile,
		home,
		plan,
		mode: 'interactive',
		// The person is driving: every site may load, and the host's checks
		// after the fact have nothing to clear.
		sites: { '*': 'act' },
		...(ctx.config.browser?.keepOpen ? { keepOpen: true } : {}),
	})
	ctx.formatter.info(
		`Opening ${browserName(plan.browser)} (${engineLabel(plan)}) on profile ${profile}…`,
	)
	let httpAuthChallenge = false
	try {
		await host.observe(
			url === 'about:blank' ? { action: 'snapshot' } : { action: 'tabs', op: 'new', url },
		)
	} catch (error) {
		const code = (error as { code?: unknown }).code
		// A sign-in page is why the window is open.
		if (code !== 'browser_human_required') {
			await host.dispose().catch(() => undefined)
			ctx.formatter.error({ message: `The browser did not open: ${errorText(error)}` })
			return code === 'browser_unavailable' || code === 'browser_profile_busy'
				? EXIT_UNAVAILABLE
				: EXIT_FAIL
		}
		httpAuthChallenge = (error as { reason?: unknown }).reason === 'http-auth'
	}
	const where = url === 'about:blank' ? 'the sites you want the agent to use' : new URL(url).origin
	ctx.formatter.print({
		text: `${httpAuthChallenge ? `An HTTP authentication challenge was returned while opening ${where}. Check access in the window that opened (profile ${profile}).` : `Sign in to ${where} in the window that opened (profile ${profile}).`}\n${interactive() ? 'Press Enter here when you are done, or close the window.' : 'Close the window when you are done.'}`,
	})
	const stop = new AbortController()
	const closed = new Promise<'closed'>((resolve) => {
		const timer = setInterval(() => {
			if (!host.running) {
				clearInterval(timer)
				resolve('closed')
			}
		}, deps.pollMs)
		stop.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
	})
	const how = await Promise.race([
		deps.waitForEnter(stop.signal).then(() => 'enter' as const),
		closed,
	])
	stop.abort()
	await host.dispose().catch(() => undefined)
	if (!httpAuthChallenge) {
		try {
			new mod.BrowserProfileStore(home).markLogin(profile)
		} catch {
			// A window closed before the profile was written has nothing to mark.
		}
	}
	ctx.formatter.print({
		text: `${how === 'closed' ? 'Window closed' : 'Done'}. ${httpAuthChallenge ? `Profile ${profile} is ready for another browser attempt; the site may still require another authentication method` : `Profile ${profile} keeps what you signed in to`}; the agent uses it when the profile is selected (browser.defaultProfile, or /browser profile ${profile}), and a scheduled job when it is given the profile (namzu schedule add … --browser ${profile}).`,
	})
	return EXIT_OK
}

async function listCommand(
	ctx: CommandContext,
	argv: readonly string[],
	deps: BrowserCommandDeps,
): Promise<number> {
	const args = parseArgs(argv, ['home', 'json!'])
	if (args.unknown.length > 0 || args.positionals.length > 0) {
		ctx.formatter.error({ message: 'usage: namzu browser list [--json]' })
		return EXIT_USAGE
	}
	const mod = await deps.load()
	const home = homeOf(args, deps)
	const leases = new mod.BrowserLeaseStore(home)
	const profiles = new mod.BrowserProfileStore(home).list().map((profile) => ({
		...profile,
		inUse: leases.holders(profile.name).length > 0,
	}))
	if (has(args, 'json') || ctx.formatter.name !== 'text') {
		const payload = { v: 1, profiles }
		ctx.formatter.print(ctx.formatter.name === 'text' ? JSON.stringify(payload, null, 2) : payload)
		return EXIT_OK
	}
	if (profiles.length === 0) {
		ctx.formatter.print(
			'No browser profiles yet. Make one with `namzu browser login <profile> <url>`.',
		)
		return EXIT_OK
	}
	ctx.formatter.print(
		profiles
			.map(
				(p) =>
					`${p.name}  ${browserName(p.browser)} (${p.engine})${p.inUse ? '  in use' : ''}\n  ${p.lastLoginAt ? `last sign-in ${p.lastLoginAt}` : 'never signed in'} · created ${p.createdAt}`,
			)
			.join('\n'),
	)
	return EXIT_OK
}

async function statusCommand(
	ctx: CommandContext,
	argv: readonly string[],
	deps: BrowserCommandDeps,
): Promise<number> {
	const args = parseArgs(argv, ['home', 'json!'])
	const [profile, ...extra] = args.positionals
	if (args.unknown.length > 0 || extra.length > 0) {
		ctx.formatter.error({ message: 'usage: namzu browser status [profile] [--json]' })
		return EXIT_USAGE
	}
	if (profile !== undefined && !isBrowserProfileName(profile)) {
		ctx.formatter.error({ message: `"${profile}" is not a profile name.` })
		return EXIT_USAGE
	}
	const mod = await deps.load()
	const home = homeOf(args, deps)
	const plan = detectPlan(mod, ctx, deps)
	const browser = ctx.config.browser
	const descriptor = profile ? new mod.BrowserProfileStore(home).get(profile) : undefined
	const holders = profile ? new mod.BrowserLeaseStore(home).holders(profile) : []
	const payload = {
		v: 1,
		engine: engineLabel(plan),
		browser: plan.browser,
		headless: plan.headless,
		...(plan.unavailableReason !== undefined ? { unavailableReason: plan.unavailableReason } : {}),
		warnings: plan.warnings,
		enabled: browser?.enabled !== false,
		defaultProfile: browser?.defaultProfile ?? 'default',
		sites: browser?.sites ?? { '*': 'ask' },
		...(profile ? { profile: descriptor ?? null, inUse: holders.length > 0 } : {}),
	}
	if (has(args, 'json') || ctx.formatter.name !== 'text') {
		ctx.formatter.print(ctx.formatter.name === 'text' ? JSON.stringify(payload, null, 2) : payload)
		return plan.unavailableReason !== undefined ? EXIT_UNAVAILABLE : EXIT_OK
	}
	const lines = [
		`Engine: ${describeBrowserPlan(plan)}`,
		...(plan.unavailableReason !== undefined ? [`Unavailable: ${plan.unavailableReason}`] : []),
		...plan.warnings.map((w) => `Note: ${w}`),
		`Browser tools: ${payload.enabled ? 'on in the interactive terminal' : 'off (browser.enabled: false)'}`,
		`Default profile: ${payload.defaultProfile}`,
		`Sites: ${Object.entries(payload.sites)
			.map(([site, level]) => `${site} ${level}`)
			.join(' · ')}`,
	]
	if (profile) {
		lines.push(
			descriptor
				? `Profile ${profile}: ${browserName(descriptor.browser)} (${descriptor.engine}) · ${descriptor.lastLoginAt ? `last sign-in ${descriptor.lastLoginAt}` : 'never signed in'}${holders.length > 0 ? ' · in use' : ''}\n  ${descriptor.userDataDir}`
				: `Profile ${profile}: does not exist yet. \`namzu browser login ${profile} <url>\` makes it.`,
		)
	}
	ctx.formatter.print(lines.join('\n'))
	return plan.unavailableReason !== undefined ? EXIT_UNAVAILABLE : EXIT_OK
}

async function installCommand(
	ctx: CommandContext,
	argv: readonly string[],
	deps: BrowserCommandDeps,
): Promise<number> {
	const args = parseArgs(argv, ['dry-run!', 'force!'])
	if (args.unknown.length > 0 || args.positionals.length > 0) {
		ctx.formatter.error({ message: 'usage: namzu browser install [--dry-run] [--force]' })
		return EXIT_USAGE
	}
	const mod = await deps.load()
	const plan = detectPlan(mod, ctx, deps)
	if (plan.browser !== 'chromium' && plan.unavailableReason === undefined && !has(args, 'force')) {
		ctx.formatter.print(
			`Nothing to install: the browser tools drive ${describeBrowserPlan(plan)}. Pass --force to download Playwright’s Chromium anyway.`,
		)
		return EXIT_OK
	}
	ctx.formatter.info(`Downloading Chromium for playwright-core ${mod.PLAYWRIGHT_CORE_VERSION}…`)
	const code = await deps.spawnInstall(has(args, 'dry-run') ? ['--dry-run'] : [])
	return code === 0 ? EXIT_OK : EXIT_FAIL
}

async function removeCommand(
	ctx: CommandContext,
	argv: readonly string[],
	deps: BrowserCommandDeps,
): Promise<number> {
	const args = parseArgs(argv, ['home', 'yes!'])
	const [profile, ...extra] = args.positionals
	if (args.unknown.length > 0 || !profile || extra.length > 0) {
		ctx.formatter.error({ message: 'usage: namzu browser remove <profile> [--yes]' })
		return EXIT_USAGE
	}
	if (!isBrowserProfileName(profile)) {
		ctx.formatter.error({ message: `"${profile}" is not a profile name.` })
		return EXIT_USAGE
	}
	const mod = await deps.load()
	const home = homeOf(args, deps)
	const store = new mod.BrowserProfileStore(home)
	const descriptor = store.get(profile)
	if (!descriptor) {
		ctx.formatter.error({ message: `There is no browser profile "${profile}".` })
		return EXIT_FAIL
	}
	if (!has(args, 'yes')) {
		if (!interactive()) {
			ctx.formatter.error({
				message: `Removing profile ${profile} deletes everything signed in to it. Pass --yes to confirm.`,
			})
			return EXIT_USAGE
		}
		const answer = await new Promise<string>((resolve) => {
			const rl = createInterface({ input: process.stdin, output: process.stderr })
			rl.question(
				`Delete browser profile ${profile} (${descriptor.userDataDir}) and every sign-in in it? [y/N] `,
				(text) => {
					rl.close()
					resolve(text)
				},
			)
		})
		if (!/^y(es)?$/i.test(answer.trim())) {
			ctx.formatter.print('Kept.')
			return EXIT_OK
		}
	}
	const plan = detectPlan(mod, ctx, deps)
	try {
		store.remove(profile, new mod.BrowserLeaseStore(home), {
			...(plan.engine === 'windows-cdp' ? { mountRoot: plan.mountRoot } : {}),
		})
	} catch (error) {
		ctx.formatter.error({ message: errorText(error) })
		return EXIT_FAIL
	}
	ctx.formatter.print(`Removed browser profile ${profile}.`)
	return EXIT_OK
}
