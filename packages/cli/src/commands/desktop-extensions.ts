import { readFileSync, statSync } from 'node:fs'
import { ExtensionError } from '../integrations/extensions/errors.js'
import { ExtensionHost, type StateEvent } from '../integrations/extensions/host.js'
import { ctlRequest } from '../integrations/extensions/runner/ctl.js'
import { liveRunner } from '../integrations/extensions/runner/lock.js'
import {
	createRegistrar,
	readRunnerState,
	reconcileSignin,
} from '../integrations/extensions/signin/reconcile.js'
import { namzuHomePath } from '../integrations/state/home.js'
import { CLI_VERSION } from '../version.js'
import { createBackgroundDeps, currentEngine } from './extension.js'

/**
 * The `namzu/extensions/*` methods Desktop's Extensions page uses. A thin layer over the same
 * `ExtensionHost` the command line uses: nothing here decides anything the host does not. A refusal the
 * person can read is answered as `{ error: { code, check, message } }`, not thrown, so the page can say
 * which check failed; anything else is an ordinary error.
 */

export const EXTENSIONS_STATE_NOTIFICATION = 'namzu/extensions/state'

/** The methods the app turns the page on for: it needs every one of them. */
export const EXTENSIONS_METHODS = [
	'namzu/extensions/list',
	'namzu/extensions/add',
	'namzu/extensions/license',
	'namzu/extensions/notice',
	'namzu/extensions/acknowledge',
	'namzu/extensions/enable',
	'namzu/extensions/disable',
	'namzu/extensions/remove',
	'namzu/extensions/grant',
	'namzu/extensions/revoke',
	'namzu/extensions/query',
	'namzu/extensions/settings/get',
	'namzu/extensions/settings/set',
	'namzu/extensions/audit',
	'namzu/extensions/background/get',
	'namzu/extensions/background/set',
	'namzu/extensions/ui',
	'namzu/extensions/action',
	'namzu/extensions/runner',
] as const

const MAX_PACKAGE_BYTES = 70 * 1024 * 1024
type Params = Record<string, unknown>

const text = (p: Params, key: string, max = 300): string => {
	const v = p[key]
	if (typeof v !== 'string' || v.length === 0 || v.length > max)
		throw new Error(`${key} must be text`)
	return v
}
const optText = (p: Params, key: string, max = 300): string | undefined =>
	p[key] === undefined ? undefined : text(p, key, max)

export function createExtensionsRpc(
	getHost: () => ExtensionHost,
): Record<string, (params: Params) => unknown> {
	const wrap =
		(fn: (host: ExtensionHost, p: Params) => unknown | Promise<unknown>) =>
		async (p: Params): Promise<unknown> => {
			const host = getHost()
			const locale = optText(p, 'locale', 35)
			if (locale) host.setLocale(locale)
			try {
				return await fn(host, p)
			} catch (e) {
				if (e instanceof ExtensionError)
					return { error: { code: e.code, check: e.check, message: e.message } }
				throw e
			}
		}
	return {
		'namzu/extensions/list': wrap((h) => ({ extensions: h.list() })),
		'namzu/extensions/add': wrap((h, p) => {
			const path = text(p, 'path', 4096)
			const st = statSync(path)
			if (!st.isFile() || st.size > MAX_PACKAGE_BYTES)
				throw new ExtensionError(
					'bad-package',
					'file',
					'That is not a package file this app can add.',
				)
			const r = h.add(readFileSync(path), 'desktop')
			return {
				view: r.view,
				disclosure: r.disclosure,
				...(r.update ? { update: r.update } : {}),
				...(r.noop ? { noop: true } : {}),
			}
		}),
		'namzu/extensions/license': wrap(async (h, p) => {
			const id = text(p, 'id')
			// The key of a service licence goes in and is never returned; only a state comes back.
			if (p.action === 'check' || p.action === 'release') {
				const r = await h.licenseAction(id, p.action)
				return { ok: r.done, ...(r.error ? { message: r.error } : {}), view: r.view }
			}
			const key = optText(p, 'key', 512)
			if (key !== undefined) {
				const out = await h.setLicenseKey(id, key)
				return out.ok
					? { ok: true, view: h.view(id) }
					: { ok: false, code: out.code, message: out.message }
			}
			const token = optText(p, 'token', 8192)
			const path = optText(p, 'path', 4096)
			if ((token === undefined) === (path === undefined))
				throw new Error('Give the licence as text or as a file, not both.')
			return {
				ok: true,
				...h.setLicense(id, (token ?? readFileSync(path as string, 'utf8')).trim()),
			}
		}),
		'namzu/extensions/notice': wrap((h, p) => {
			const locale = optText(p, 'locale', 35)
			return h.notice(text(p, 'id'), { staged: p.staged === true, ...(locale ? { locale } : {}) })
		}),
		'namzu/extensions/acknowledge': wrap((h, p) => {
			const id = text(p, 'id')
			const locale = optText(p, 'locale', 35)
			h.acknowledge(id, {
				noticeVersion: text(p, 'noticeVersion', 20),
				scopeHash: text(p, 'scopeHash', 64),
				...(locale ? { locale } : {}),
				staged: p.staged === true,
				via: 'desktop',
				...(typeof p.startAtSignin === 'boolean' ? { startAtSignin: p.startAtSignin } : {}),
			})
			return { ok: true }
		}),
		'namzu/extensions/enable': wrap((h, p) => ({ view: h.enable(text(p, 'id')) })),
		'namzu/extensions/disable': wrap(async (h, p) => ({ view: await h.disable(text(p, 'id')) })),
		'namzu/extensions/remove': wrap(async (h, p) => {
			await h.remove(text(p, 'id'), p.deleteData === true)
			return { ok: true }
		}),
		'namzu/extensions/grant': wrap((h, p) => ({
			view: h.grant(text(p, 'id'), text(p, 'permission', 64), 'desktop'),
		})),
		'namzu/extensions/revoke': wrap((h, p) => ({
			view: h.revoke(text(p, 'id'), text(p, 'permission', 64)),
		})),
		'namzu/extensions/query': wrap((h, p) =>
			h.query(text(p, 'id'), text(p, 'query', 48), p.params ?? {}),
		),
		'namzu/extensions/settings/get': wrap((h, p) =>
			h.getSetting(text(p, 'id'), text(p, 'key', 32), optText(p, 'provider', 63)),
		),
		'namzu/extensions/settings/set': wrap((h, p) =>
			h.setSetting(text(p, 'id'), text(p, 'key', 32), p.value, optText(p, 'provider', 63)),
		),
		'namzu/extensions/background/get': wrap((h, p) => ({
			background: h.view(text(p, 'id')).background ?? null,
		})),
		'namzu/extensions/background/set': wrap(async (h, p) => ({
			view: await h.setBackground(text(p, 'id'), p.on === true),
		})),
		'namzu/extensions/ui': wrap((h, p) => ({ ui: h.uiInfo(text(p, 'id')) })),
		'namzu/extensions/action': wrap((h, p) =>
			h.action(text(p, 'id'), text(p, 'action', 48), p.params ?? {}, p.activation === true),
		),
		'namzu/extensions/runner': wrap(() => {
			const root = `${namzuHomePath()}/extensions`
			const lock = liveRunner(root)
			return {
				running: Boolean(lock),
				pid: lock?.pid ?? null,
				since: lock?.since ?? null,
				signin: readRunnerState(root)?.signin ?? null,
			}
		}),
		'namzu/extensions/audit': wrap((h, p) => ({
			lines: h.audit(text(p, 'id'), typeof p.limit === 'number' ? p.limit : 50),
		})),
	}
}

export type { StateEvent }

let shared: ExtensionHost | undefined
let notifier: ((method: string, params: Record<string, unknown>) => void) | undefined
const listeners = new Set<(event: StateEvent) => void>()

/** Hear every state change of an extension in this process (the terminal's indicator row). Returns the way to stop. */
export function onExtensionState(listener: (event: StateEvent) => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/** The one extension host of this process, made when first asked for (so a test that never asks never touches the home folder). */
export function sharedExtensionHost(kind: 'cli' | 'desktop' | 'run' = 'desktop'): ExtensionHost {
	const root = `${namzuHomePath()}/extensions`
	const background = createBackgroundDeps()
	const registrar = createRegistrar({
		platform: process.platform,
		extensionsRoot: root,
		env: process.env,
	})
	shared ??= new ExtensionHost({
		home: namzuHomePath(),
		hostVersion: CLI_VERSION,
		kind,
		env: process.env,
		// The one per-user sign-in entry, and the one runner: a switch-on extension is the runner's, the app attaches.
		signin: (wanted) =>
			reconcileSignin({
				registrar,
				extensionsRoot: root,
				engine: currentEngine(),
				platform: process.platform,
				wanted,
			}),
		ensureRunner: () => background.ensureRunner(),
		notifyRunner: async () => {
			await ctlRequest(root, { op: 'reload' })
		},
		onState: (event: StateEvent) => {
			notifier?.(EXTENSIONS_STATE_NOTIFICATION, { ...event })
			for (const l of listeners) l(event)
		},
	})
	return shared
}

/** Desktop's engine: run what is enabled while the app runs, and say so on every change. */
export function startDesktopExtensions(
	notify: (method: string, params: Record<string, unknown>) => void,
): void {
	notifier = notify
	sharedExtensionHost('desktop').startSupervision()
}

export async function stopDesktopExtensions(): Promise<void> {
	notifier = undefined
	await shared?.stopSupervision()
}
