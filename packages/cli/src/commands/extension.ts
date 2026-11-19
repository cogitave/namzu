import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { EXIT_FAIL, EXIT_NEEDS_CONSENT, EXIT_NOINPUT, EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import { disclosureText } from '../integrations/extensions/disclosure.js'
import { ExtensionError } from '../integrations/extensions/errors.js'
import { ExtensionHost, type ExtensionView } from '../integrations/extensions/host.js'
import { devModeOn, trustedKeys } from '../integrations/extensions/keys.js'
import { ctlRequest } from '../integrations/extensions/runner/ctl.js'
import {
	type DaemonHandle,
	ensureRunner,
	runDaemon,
	stopRunner,
} from '../integrations/extensions/runner/daemon.js'
import { liveRunner } from '../integrations/extensions/runner/lock.js'
import type { EngineLocation } from '../integrations/extensions/signin/launcher.js'
import {
	createRegistrar,
	readRunnerState,
	reconcileSignin,
	removeSigninEverywhere,
} from '../integrations/extensions/signin/reconcile.js'
import { validateFolder, validatePackage } from '../integrations/extensions/validate.js'
import { namzuHomePath } from '../integrations/state/home.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { CLI_VERSION } from '../version.js'
import type { CommandDef } from './types.js'

const HELP = [
	'Usage: namzu extension <command> [options]',
	'',
	'Extensions are separate programs you add from a signed file. Each one lists what it',
	'asks for and why before it can run, and Namzu refuses anything it did not list.',
	'',
	'Commands:',
	'  add <file.nzx>                 Verify a package and show what it asks for (starts nothing)',
	'  list                           The extensions you have added and where each stands',
	'  status <id>                    Why it is or is not running, and the last audit lines',
	'  notice <id> [--staged] [--locale <tag>]',
	'                                 Read the notice again, with the record of when you acknowledged it',
	'  license <id> [--file <path>|--key-stdin|--refresh|--release]',
	"                                 Enter a licence (a key file, or a key for the publisher's service),",
	"                                 check it again now, or release this computer's seat",
	'  enable <id>                    Turn it on (asks you to read the notice once, the first time)',
	'  disable <id>                   Turn it off (keeps its data and your record)',
	'  unlock <id>                    Take the administrator lock off (needs the administrator password)',
	'  remove <id> [--delete-data]    Remove it (keeps its data unless --delete-data)',
	'  grant <id> <permission>        Allow an optional permission it asked for',
	'  revoke <id> <permission>       Take an optional permission back',
	'  key <id> <provider> [--stdin|--remove]',
	'                                 Store a model API key for it, apart from your own keys',
	'  background <id> on|off|status  Start it when you sign in, even when Namzu is closed',
	'  daemon start|run|stop|status   The runner that keeps those extensions going (one per person)',
	'  signin remove --all            Remove the sign-in entry and its launcher (for an uninstaller; never data)',
	'  run                            Supervise every enabled extension until interrupted',
	'  validate <folder|file>         Developer check: the manifest, its rules, and a package',
	'',
	'An extension an administrator has locked asks for the administrator password on every way off:',
	'enable (to set it the first time), disable, remove, license, revoke, key, background off, unlock',
	'and daemon stop. Give it as the first line of standard input with --admin-password-stdin; a',
	'licence or key you pipe in follows on the next lines. It is never an argument.',
	'',
	'Every command takes --json. Exit status: 0 done, 1 refused, 75 needs you (the notice',
	'has to be read by a person at a terminal), 64 the command line is wrong.',
].join('\n')

export interface ExtensionDeps {
	readonly host: ExtensionHost
	readonly out: (text: string) => void
	readonly err: (text: string) => void
	readonly isTTY: boolean
	readonly ask: (question: string) => Promise<string>
	readonly readStdin: () => Promise<string>
	/** `run` ends when this is aborted (SIGINT or SIGTERM in the real command). */
	readonly signal?: AbortSignal
	/** The runner and the sign-in entry; a test gives fakes, the real command gives the real ones. */
	readonly background?: BackgroundDeps
}

export interface BackgroundDeps {
	readonly root: string
	readonly engine: EngineLocation
	/** Start the runner if none is running; resolves to whether one is. */
	ensureRunner(): Promise<boolean>
	/** Run the runner in this process until it stops. */
	daemonRun(): Promise<{ handle: DaemonHandle; exited: Promise<void> }>
	stopRunner(): Promise<boolean>
	removeSignin(): Promise<void>
}

const oneLine = (s: string): string => terminalDisplayText(s).replace(/\s+/g, ' ').trim()

function row(v: ExtensionView): string {
	const parts = [v.id, oneLine(v.name), v.version, v.chip]
	if (v.indicator && v.state === 'running') parts.push(`(${oneLine(v.indicator.label)})`)
	if (v.dev) parts.push('DEV KEY')
	if (v.management?.locked) parts.push('LOCKED BY ADMINISTRATOR')
	return parts.join('  ')
}

interface Parsed {
	readonly sub: string
	readonly positional: string[]
	readonly flags: Map<string, string | true>
	readonly error?: string
}

const VALUE_FLAGS = new Set(['--file', '--locale'])
const BOOL_FLAGS = new Set([
	'--json',
	'--staged',
	'--delete-data',
	'--stdin',
	'--remove',
	'--keep-data',
	'--signin',
	'--all',
	'--key-stdin',
	'--refresh',
	'--release',
	'--admin-password-stdin',
])

export function parseExtensionArgs(raw: readonly string[]): Parsed {
	const [sub = '', ...rest] = raw
	const positional: string[] = []
	const flags = new Map<string, string | true>()
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i] as string
		if (a.startsWith('--')) {
			const eq = a.indexOf('=')
			const name = eq > 0 ? a.slice(0, eq) : a
			if (VALUE_FLAGS.has(name)) {
				const v = eq > 0 ? a.slice(eq + 1) : rest[++i]
				if (v === undefined || v === '')
					return { sub, positional, flags, error: `${name} needs a value` }
				flags.set(name, v)
			} else if (BOOL_FLAGS.has(name)) flags.set(name, true)
			else return { sub, positional, flags, error: `unknown option: ${a}` }
		} else positional.push(a)
	}
	return { sub, positional, flags }
}

function need(p: Parsed, n: number, usage: string): string | undefined {
	return p.positional.length === n ? undefined : `usage: namzu extension ${usage}`
}

export async function runExtension(raw: readonly string[], d: ExtensionDeps): Promise<number> {
	const p = parseExtensionArgs(raw)
	const json = p.flags.has('--json')
	const emit = (value: unknown, text: string) => d.out(json ? JSON.stringify(value) : text)
	const refuse = (e: unknown): number => {
		if (e instanceof ExtensionError) {
			const hint =
				(e.code === 'admin-locked' || e.code === 'admin-needed') &&
				!p.flags.has('--admin-password-stdin')
					? ' Give it as the first line of standard input with --admin-password-stdin.'
					: ''
			if (json)
				d.out(
					JSON.stringify({
						ok: false,
						code: e.code,
						check: e.check,
						message: `${e.message}${hint}`,
					}),
				)
			else d.err(`${e.message}${hint}`)
			return e.code === 'needs-person' ? EXIT_NEEDS_CONSENT : EXIT_FAIL
		}
		throw e
	}
	const usage = (message: string): number => {
		d.err(message)
		return EXIT_USAGE
	}
	if (p.error) return usage(p.error)
	const id = p.positional[0] ?? ''
	// The administrator password is the first line of standard input; what follows is the licence or key.
	let adminRead = false
	let admin: string | undefined
	let stdinRest = ''
	const adminOpt = async (): Promise<{ admin?: string }> => {
		if (!p.flags.has('--admin-password-stdin')) return {}
		if (!adminRead) {
			const all = await d.readStdin()
			const nl = all.indexOf('\n')
			admin = (nl < 0 ? all : all.slice(0, nl)).replace(/\r$/, '')
			stdinRest = nl < 0 ? '' : all.slice(nl + 1)
			adminRead = true
		}
		return admin ? { admin } : {}
	}
	const payload = async (): Promise<string> => {
		await adminOpt()
		return adminRead ? stdinRest : d.readStdin()
	}
	try {
		switch (p.sub) {
			case 'add': {
				const e = need(p, 1, 'add <file.nzx>')
				if (e) return usage(e)
				const file = resolve(id)
				if (!existsSync(file) || !statSync(file).isFile()) {
					if (existsSync(file) && statSync(file).isDirectory())
						return usage(
							'a folder is not a package; developers check one with `namzu extension validate <folder>`',
						)
					d.err(`No such file: ${file}`)
					return EXIT_NOINPUT
				}
				const r = d.host.add(readFileSync(file), 'cli')
				const next = r.update?.waiting
					? `An update is waiting: it asks for more (${r.update.reasons.join('; ')}). Run \`namzu extension enable ${r.view.id}\` to review and accept it. The version you have keeps running until then.`
					: r.update && !r.noop
						? `Updated to ${r.view.version}. What you acknowledged still covers it, so nothing was asked; a running copy restarts on it.`
						: r.noop
							? 'This exact package is already added.'
							: r.view.needs.includes('license')
								? `Next: \`namzu extension license ${r.view.id} --file <key>\`, then \`namzu extension enable ${r.view.id}\`.`
								: `Next: \`namzu extension enable ${r.view.id}\`.`
				emit(
					{
						ok: true,
						view: r.view,
						disclosure: r.disclosure,
						update: r.update ?? null,
						noop: r.noop ?? false,
						next,
					},
					`${disclosureText(r.disclosure)}\n\nState: ${r.view.chip}${r.view.dev ? ' (DEV KEY)' : ''}.${r.update || r.noop ? '' : ' Nothing was started.'}\n${next}`,
				)
				return EXIT_OK
			}
			case 'list': {
				const list = d.host.list()
				emit(
					{ extensions: list },
					list.length === 0
						? 'No extensions added. An extension is a signed file from its publisher: `namzu extension add <file.nzx>`.'
						: list.map(row).join('\n'),
				)
				return EXIT_OK
			}
			case 'status': {
				const e = need(p, 1, 'status <id>')
				if (e) return usage(e)
				const s = d.host.status(id)
				const lines = [row(s.view)]
				if (s.view.why) lines.push(`Why: ${s.view.why}`)
				if (s.view.needs.length) lines.push(`Needs: ${s.view.needs.join(', ')}`)
				lines.push(`Restarts in the last hour: ${s.restartsLastHour}`)
				if (s.process) lines.push(`Its own report: ${JSON.stringify(s.process)}`)
				if (s.view.licence)
					lines.push(
						`Licence: ${s.view.licence.customer}, ${s.view.licence.seats} seats, expires ${s.view.licence.expires}`,
					)
				else if (s.view.licenceProblem) lines.push(`Licence: ${s.view.licenceProblem}`)
				if (s.record)
					lines.push(
						`Acknowledged: ${s.record.acknowledgedAt}, notice ${s.record.noticeVersion} (${s.record.noticeLocale})`,
					)
				if (s.staged)
					lines.push(`Update waiting: ${s.staged.version} (${s.staged.reasons.join('; ')})`)
				if (s.view.licenceKind === 'service' && s.view.licenceChecked)
					lines.push(
						`Licence service: ${s.view.licenceHost}, last checked ${new Date(s.view.licenceChecked.lastAt).toISOString()}${s.view.licenceChecked.lastError ? ` (could not check: ${s.view.licenceChecked.lastError})` : ''}`,
					)
				if (s.view.licenceGraceDaysLeft !== undefined)
					lines.push(`Licence not checked: ${s.view.licenceGraceDaysLeft} days left offline.`)
				if (s.view.background) {
					const b = s.view.background
					lines.push(
						`Start at sign-in: ${b.enabled ? 'on' : 'off'}${b.hostedBy === 'runner' ? ', running in the background' : b.hostedBy === 'app' ? ', run by Namzu while it is open' : ''}`,
						b.indicator === 'tray'
							? `While Namzu is closed it shows: ${oneLine(b.indicatorLabel ?? '')}`
							: 'It shows nothing of its own while Namzu is closed.',
					)
					if (b.signin?.disabledByOs)
						lines.push(
							'The system has switched off starting at sign-in; it runs only while Namzu is open.',
						)
					else if (b.signin?.reason) lines.push(`Sign-in entry: ${b.signin.reason}`)
				}
				if (s.view.management)
					lines.push(
						s.view.management.locked
							? `Locked by your administrator: ${oneLine(s.view.management.purpose)}`
							: 'Not locked: turning it on sets an administrator password.',
					)
				if (s.view.ui?.pages.length)
					lines.push(
						`Pages: ${s.view.ui.pages.map((x) => `${oneLine(x.title)} (${x.slot})`).join(', ')}. Open them in Desktop.`,
					)
				lines.push(
					'Managed policy: not used in this version; nothing here reads it.',
					'Recent audit lines:',
					...s.audit.map((l) => `  ${l.ts} ${l.event}${l.detail ? ` ${oneLine(l.detail)}` : ''}`),
				)
				emit(s, lines.join('\n'))
				return EXIT_OK
			}
			case 'notice': {
				const e = need(p, 1, 'notice <id> [--staged] [--locale <tag>]')
				if (e) return usage(e)
				const locale = p.flags.get('--locale')
				const n = d.host.notice(id, {
					staged: p.flags.has('--staged'),
					...(typeof locale === 'string' ? { locale } : {}),
				})
				const text = [
					n.languageNote ?? '',
					n.text.trim(),
					'',
					...n.scopeWords,
					'',
					n.record
						? `Acknowledged ${n.record.acknowledgedAt}, notice version ${n.record.noticeVersion}, language ${n.record.noticeLocale}.`
						: 'You have not acknowledged this notice yet.',
					...(n.diff?.length ? ['', 'It now also asks:', ...n.diff.map((x) => `  - ${x}`)] : []),
				]
					.filter((l, i) => !(i === 0 && l === ''))
					.join('\n')
				emit(n, text)
				return EXIT_OK
			}
			case 'license': {
				const e = need(p, 1, 'license <id> [--file <path>|--key-stdin|--refresh|--release]')
				if (e) return usage(e)
				const view = d.host.view(id)
				if (view.licenceKind === 'service') {
					if (p.flags.has('--refresh') || p.flags.has('--release')) {
						const r = await d.host.licenseAction(
							id,
							p.flags.has('--release') ? 'release' : 'check',
							await adminOpt(),
						)
						const v = r.view
						emit(
							{ ok: r.done, error: r.error ?? null, view: v },
							r.done
								? p.flags.has('--release')
									? 'Released: this computer no longer holds a seat.'
									: `Checked with ${v.licenceHost ?? 'the licence service'}.`
								: (r.error ?? 'Nothing changed.'),
						)
						return r.done ? EXIT_OK : EXIT_FAIL
					}
					let key: string
					if (p.flags.has('--key-stdin')) key = (await payload()).trim()
					else if (d.isTTY) key = (await d.ask('Licence key: ')).trim()
					else
						return usage(
							'Give the key with --key-stdin or at the prompt; never as an argument, where it would land in your shell history.',
						)
					if (!key) return usage('No key given.')
					const out = await d.host.setLicenseKey(id, key, await adminOpt())
					if (!out.ok) {
						emit({ ok: false, code: out.code, message: out.message }, out.message)
						return EXIT_FAIL
					}
					const v = d.host.view(id)
					emit(
						{ ok: true, view: v },
						`Licence accepted: ${oneLine(v.licence?.customer ?? '')}, checked with ${v.licenceHost ?? 'the licence service'}.`,
					)
					return EXIT_OK
				}
				const f = p.flags.get('--file')
				let text: string
				if (typeof f === 'string') {
					if (!existsSync(f)) {
						d.err(`No such file: ${f}`)
						return EXIT_NOINPUT
					}
					text = readFileSync(f, 'utf8')
				} else {
					if (d.isTTY)
						return usage(
							'Give the key with --file <path> or on standard input (`namzu extension license <id> < key.nzlic`); never as an argument, where it would land in your shell history.',
						)
					text = await payload()
				}
				const l = d.host.setLicense(id, text.trim(), await adminOpt())
				emit(
					{ ok: true, ...l },
					`Licence accepted: ${oneLine(l.customer)}, ${l.seats} seats, expires ${l.expires}.`,
				)
				return EXIT_OK
			}
			case 'enable': {
				const e = need(p, 1, 'enable <id>')
				if (e) return usage(e)
				const pending = d.host.pendingNotice(id)
				if (pending) {
					const n = d.host.notice(id, { staged: pending.staged })
					if (!d.isTTY) {
						const msg =
							'This needs you: the notice has to be read and acknowledged by a person at a terminal, or in Desktop.'
						if (json)
							d.out(
								JSON.stringify({
									ok: false,
									code: 'needs-person',
									message: msg,
									noticeVersion: n.noticeVersion,
								}),
							)
						else d.err(msg)
						return EXIT_NEEDS_CONSENT
					}
					d.host.noticeShown(id)
					d.out(
						[
							n.languageNote ?? '',
							n.text.trim(),
							'',
							...n.scopeWords,
							...(n.diff?.length
								? ['', 'It now also asks:', ...n.diff.map((x) => `  - ${x}`)]
								: []),
						]
							.filter(Boolean)
							.join('\n'),
					)
					const answer = (
						await d.ask(`\nAcknowledge this notice (version ${n.noticeVersion})? [y/N] `)
					)
						.trim()
						.toLowerCase()
					if (answer !== 'y' && answer !== 'yes') {
						d.host.declined(id)
						d.err('Not acknowledged. Nothing was recorded and the extension stays off.')
						return EXIT_FAIL
					}
					// The switch the person sees before acknowledging: its words, its default, their choice.
					let startAtSignin: boolean | undefined
					if (n.disclosure.background) {
						const def = n.disclosure.background.defaultOn
						d.out(`\n${n.disclosure.background.line}\n${n.disclosure.background.whileClosed}`)
						const a2 = (await d.ask(`Start when I sign in? [${def ? 'Y/n' : 'y/N'}] `))
							.trim()
							.toLowerCase()
						startAtSignin = a2 === '' ? def : a2 === 'y' || a2 === 'yes'
					}
					d.host.acknowledge(id, {
						noticeVersion: n.noticeVersion,
						scopeHash: n.scopeHash,
						locale: n.locale,
						staged: pending.staged,
						via: 'cli',
						...(startAtSignin === undefined ? {} : { startAtSignin }),
						...(await adminOpt()),
					})
				}
				const v = d.host.enable(id, await adminOpt())
				if (v.background?.enabled && d.background) {
					await d.host.reconcile()
					const up = await d.background.ensureRunner()
					emit(
						{ ok: true, view: d.host.view(id), runner: up },
						up
							? 'Enabled. It runs in the background now and starts again when you sign in, even when Namzu is closed.'
							: 'Enabled. It starts when you sign in; the background runner could not be started now (`namzu extension daemon start` tries again).',
					)
					return EXIT_OK
				}
				const where = d.host.status(id).process
					? ''
					: ' It starts the next time Namzu runs (`namzu extension run` runs it now).'
				emit({ ok: true, view: v }, `Enabled.${v.running ? '' : where}`)
				return EXIT_OK
			}
			case 'disable': {
				const e = need(p, 1, 'disable <id>')
				if (e) return usage(e)
				const v = await d.host.disable(id, await adminOpt())
				emit({ ok: true, view: v }, 'Disabled. Its data and your record are kept.')
				return EXIT_OK
			}
			case 'unlock': {
				const e = need(p, 1, 'unlock <id> [--admin-password-stdin]')
				if (e) return usage(e)
				const v = d.host.unlock(id, await adminOpt())
				emit(
					{ ok: true, view: v },
					'The administrator lock is off. Anyone can turn it off now; turning it on again sets a new password.',
				)
				return EXIT_OK
			}
			case 'remove': {
				const e = need(p, 1, 'remove <id> [--delete-data]')
				if (e) return usage(e)
				let del = p.flags.has('--delete-data')
				if (!del && !p.flags.has('--keep-data') && d.isTTY) {
					const a = (await d.ask('Delete the data it collected too? [Y/n] ')).trim().toLowerCase()
					del = a !== 'n' && a !== 'no'
				} else if (!p.flags.has('--keep-data') && !d.isTTY) del = p.flags.has('--delete-data')
				await d.host.remove(id, del, await adminOpt())
				emit(
					{ ok: true, dataDeleted: del },
					`Removed.${del ? ' Its data was deleted.' : ' Its data was kept.'} Nothing was ever sent anywhere in this version, so there is nothing to take back from elsewhere.`,
				)
				return EXIT_OK
			}
			case 'grant':
			case 'revoke': {
				const e = need(p, 2, `${p.sub} <id> <permission>`)
				if (e) return usage(e)
				const perm = p.positional[1] as string
				if (p.sub === 'grant') {
					const n = d.host.notice(id)
					const pm = n.disclosure.permissions.find((x) => x.id === perm)
					if (!pm)
						return refuse(
							new ExtensionError(
								'unknown-permission',
								'grant',
								`${perm} is not declared by this extension.`,
							),
						)
					if (!pm.optional)
						return refuse(
							new ExtensionError(
								'not-optional',
								'grant',
								`${perm} is part of the scope you acknowledged; it cannot be granted separately.`,
							),
						)
					if (!d.isTTY)
						return refuse(
							new ExtensionError(
								'needs-person',
								'grant',
								'This needs you: granting a permission has to be answered by a person at a terminal, or in Desktop.',
							),
						)
					d.out(
						[pm.prompt ?? '', pm.summary, ...pm.purposes.map((u) => `Why: ${u}`)]
							.filter(Boolean)
							.join('\n'),
					)
					const a = (await d.ask(`Allow ${perm}? [y/N] `)).trim().toLowerCase()
					if (a !== 'y' && a !== 'yes') {
						d.err('Not granted.')
						return EXIT_FAIL
					}
				}
				const v =
					p.sub === 'grant'
						? d.host.grant(id, perm, 'cli')
						: d.host.revoke(id, perm, await adminOpt())
				emit({ ok: true, view: v }, p.sub === 'grant' ? `Granted ${perm}.` : `Revoked ${perm}.`)
				return EXIT_OK
			}
			case 'key': {
				const e = need(p, 2, 'key <id> <provider> [--stdin|--remove]')
				if (e) return usage(e)
				const provider = p.positional[1] as string
				if (p.flags.has('--remove')) {
					emit(
						{ ok: true, ...d.host.setKey(id, provider, null, 'modelKey', await adminOpt()) },
						'Key removed.',
					)
					return EXIT_OK
				}
				let value: string
				if (p.flags.has('--stdin')) value = (await payload()).trim()
				else if (d.isTTY)
					value = (
						await d.ask(
							`Key for ${provider} (kept apart from your own Namzu keys; nothing uses it in this version): `,
						)
					).trim()
				else return usage('Give the key with --stdin; never as an argument.')
				if (!value) return usage('No key given.')
				const r = d.host.setKey(id, provider, value, 'modelKey', await adminOpt())
				emit(
					{ ok: true, ...r },
					`Stored (${r.masked}). It is not shown again and nothing uses it in this version.`,
				)
				return EXIT_OK
			}
			case 'background': {
				const e = need(p, 2, 'background <id> on|off|status')
				if (e) return usage(e)
				const what = p.positional[1]
				if (what !== 'on' && what !== 'off' && what !== 'status')
					return usage('usage: namzu extension background <id> on|off|status')
				if (what !== 'status') {
					const v = await d.host.setBackground(id, what === 'on', await adminOpt())
					if (what === 'on' && v.enabled && d.background) await d.background.ensureRunner()
					emit(
						{ ok: true, view: v },
						what === 'on'
							? 'It starts when you sign in and keeps running when Namzu is closed.'
							: 'It no longer starts when you sign in.',
					)
					return EXIT_OK
				}
				const v = d.host.view(id)
				if (!v.background) {
					emit({ declared: false }, 'This extension does not start when you sign in.')
					return EXIT_OK
				}
				emit(
					{ declared: true, background: v.background },
					[
						`Start at sign-in: ${v.background.enabled ? 'on' : 'off'}`,
						`Run by: ${v.background.hostedBy}`,
						v.background.indicator === 'tray'
							? `While Namzu is closed it shows: ${oneLine(v.background.indicatorLabel ?? '')}`
							: 'It shows nothing of its own while Namzu is closed.',
					].join('\n'),
				)
				return EXIT_OK
			}
			case 'daemon': {
				const sub = p.positional[0]
				if (!d.background || !sub || !['start', 'run', 'stop', 'status'].includes(sub))
					return usage('usage: namzu extension daemon start|run|stop|status')
				const b = d.background
				if (sub === 'start') {
					const up = await b.ensureRunner()
					emit({ ok: up }, up ? 'The runner is running.' : 'The runner could not be started.')
					return EXIT_OK
				}
				if (sub === 'stop') {
					// Stopping the runner stops every extension it runs: a locked one needs its password too.
					const opt = await adminOpt()
					for (const v of d.host.list())
						if (v.management?.locked && v.enabled && v.background?.enabled)
							d.host.checkAdmin(v.id, opt)
					const stopped = await b.stopRunner()
					emit(
						{ ok: stopped },
						stopped
							? 'The runner stopped; the extensions it ran shut down first.'
							: 'No runner is running.',
					)
					return EXIT_OK
				}
				if (sub === 'status') {
					const lock = liveRunner(b.root)
					const live = lock ? await ctlRequest(b.root, { op: 'status' }) : undefined
					const signin = readRunnerState(b.root)?.signin
					emit(
						{
							running: Boolean(lock),
							pid: lock?.pid ?? null,
							since: lock?.since ?? null,
							extensions: live?.extensions ?? [],
							signin: signin ?? null,
						},
						[
							lock ? `The runner is running (pid ${lock.pid}).` : 'The runner is not running.',
							...((live?.extensions as { id: string; state: string }[] | undefined) ?? []).map(
								(x) => `  ${x.id}  ${x.state}`,
							),
							signin?.registered
								? `Sign-in entry: ${signin.kind ?? 'registered'}${signin.disabledByOs ? ' (switched off in the system)' : ''}`
								: signin?.reason
									? `Sign-in entry: ${signin.reason}`
									: 'Sign-in entry: none',
						].join('\n'),
					)
					return EXIT_OK
				}
				// run: the foreground runner, what `start` launches and what the sign-in entry reaches.
				const { handle: h, exited } = await b.daemonRun()
				if (!h.running) {
					emit({ ok: true, alreadyRunning: true, pid: h.pid }, 'A runner is already running.')
					return EXIT_OK
				}
				await new Promise<void>((resolveRun) => {
					if (d.signal?.aborted) return resolveRun()
					d.signal?.addEventListener('abort', () => resolveRun(), { once: true })
					void exited.then(resolveRun)
				})
				await h.stop('stop')
				return EXIT_OK
			}
			case 'signin': {
				if (p.positional[0] !== 'remove' || !p.flags.has('--all') || !d.background)
					return usage('usage: namzu extension signin remove --all')
				await d.background.removeSignin()
				emit({ ok: true }, 'The sign-in entry and its launcher are removed. No data was touched.')
				return EXIT_OK
			}
			case 'run': {
				const host = d.host
				// The mark is printed at every change, not only once: a person watching sees it flip.
				const off = host.subscribe((e) => {
					if (e.indicator) d.err(`● ${oneLine(e.indicator.label)}`)
				})
				host.startSupervision()
				// Something must keep the process alive while nothing is running (a stopped, failed or
				// tampered extension has no child): without it Node leaves `run` early with an
				// "unsettled top-level await" warning instead of supervising until interrupted.
				const keepAlive = setInterval(() => {}, 2 ** 30)
				await new Promise<void>((resolveRun) => {
					if (d.signal?.aborted) return resolveRun()
					d.signal?.addEventListener('abort', () => resolveRun(), { once: true })
				})
				clearInterval(keepAlive)
				off()
				await host.stopSupervision()
				return EXIT_OK
			}
			case 'validate': {
				const e = need(p, 1, 'validate <folder|file>')
				if (e) return usage(e)
				const target = resolve(id)
				if (!existsSync(target)) {
					d.err(`No such file or folder: ${target}`)
					return EXIT_NOINPUT
				}
				const rep = statSync(target).isDirectory()
					? validateFolder(target)
					: validatePackage(readFileSync(target), trustedKeys(), basename(target))
				const text = [
					rep.ok ? `OK: ${rep.id ?? ''} ${rep.version ?? ''}`.trim() : 'Refused.',
					...rep.issues.map((i) => `  ${i.rule}  ${i.path || '(whole file)'}  ${i.message}`),
					`Signature: ${rep.signature}`,
					...(rep.warnings ?? []).map((w) => `Warning: ${w}`),
				].join('\n')
				emit(rep, text)
				return rep.ok ? EXIT_OK : EXIT_FAIL
			}
			default:
				return usage(
					p.sub
						? `unknown extension command: ${p.sub}. Run \`namzu extension --help\`.`
						: 'extension needs a command. Run `namzu extension --help`.',
				)
		}
	} catch (e) {
		return refuse(e)
	}
}

function readAllStdin(): Promise<string> {
	return new Promise((resolveIn, reject) => {
		let data = ''
		process.stdin.setEncoding('utf8')
		process.stdin.on('data', (c) => {
			data += c
		})
		process.stdin.once('end', () => resolveIn(data))
		process.stdin.once('error', reject)
	})
}

/** Where the engine is now: this process's own entry file, with the app's binary running as node when packaged. */
export function currentEngine(): EngineLocation {
	const entry = process.argv[1]
	return {
		exe: process.execPath,
		args: entry ? [entry] : [],
		env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
	}
}

export function createBackgroundDeps(env: NodeJS.ProcessEnv = process.env): BackgroundDeps {
	const home = namzuHomePath()
	const root = `${home}/extensions`
	const engine = currentEngine()
	return {
		root,
		engine,
		ensureRunner: () => ensureRunner({ root, engine, env }),
		daemonRun: async () => {
			let done: () => void = () => {}
			const exited = new Promise<void>((r) => {
				done = r
			})
			const handle = await runDaemon({
				home,
				hostVersion: CLI_VERSION,
				engine,
				env,
				onExit: () => done(),
			})
			return { handle, exited }
		},
		stopRunner: () => stopRunner(root),
		removeSignin: () =>
			removeSigninEverywhere({ platform: process.platform, extensionsRoot: root, env }),
	}
}

export function createExtensionHost(
	kind: 'cli' | 'desktop' | 'run' | 'daemon' = 'cli',
	background?: BackgroundDeps,
): ExtensionHost {
	const home = namzuHomePath()
	const root = `${home}/extensions`
	const registrar = createRegistrar({
		platform: process.platform,
		extensionsRoot: root,
		env: process.env,
	})
	const engine = background?.engine ?? currentEngine()
	return new ExtensionHost({
		home,
		hostVersion: CLI_VERSION,
		kind,
		env: process.env,
		// A short command changes state and exits: it never starts a process of its own.
		oneShot: kind === 'cli',
		signin: (wanted) =>
			reconcileSignin({
				registrar,
				extensionsRoot: root,
				engine,
				platform: process.platform,
				wanted,
			}),
		...(kind !== 'daemon' && background
			? {
					ensureRunner: () => background.ensureRunner(),
					notifyRunner: async () => {
						await ctlRequest(root, { op: 'reload' })
					},
				}
			: {}),
	})
}

export { devModeOn }

export const extensionCommand: CommandDef = {
	name: 'extension',
	description: 'Add, read and control extensions: signed programs that list what they ask for',
	passThrough: true,
	help: HELP,
	handler: async ({ rawArgs }) => {
		const kind = rawArgs[0] === 'run' ? 'run' : 'cli'
		const background = createBackgroundDeps()
		const host = createExtensionHost(kind, background)
		const ac = new AbortController()
		const stop = () => ac.abort()
		process.once('SIGINT', stop)
		process.once('SIGTERM', stop)
		const deps: ExtensionDeps = {
			host,
			out: (t) => process.stdout.write(`${t}\n`),
			err: (t) => process.stderr.write(`${t}\n`),
			isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
			ask: (q) =>
				new Promise((res) => {
					const rl = createInterface({ input: process.stdin, output: process.stdout })
					rl.question(q, (a) => {
						rl.close()
						res(a)
					})
				}),
			readStdin: readAllStdin,
			signal: ac.signal,
			background,
		}
		try {
			return await runExtension(rawArgs, deps)
		} finally {
			process.off('SIGINT', stop)
			process.off('SIGTERM', stop)
		}
	},
}
