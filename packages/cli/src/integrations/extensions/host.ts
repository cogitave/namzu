import { createHash } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import type { Logger } from '@namzu/sdk'
import { cliLogger } from '../../logging.js'
import { sha256Hex } from './canon.js'
import { type ConsentRecord, ConsentStore, coverage, osUserHash } from './consent.js'
import {
	type Disclosure,
	disclose,
	localeName,
	scopeWords,
	stripLeadingComments,
} from './disclosure.js'
import { ExtensionError } from './errors.js'
import { type IndicatorView, type ViewState, chipFor, indicatorFor } from './indicator.js'
import { schemaProblems } from './json-schema.js'
import { type TrustedKey, devModeOn, trustedKeys } from './keys.js'
import { dropCache } from './license/cache.js'
import { type LicenseResult, checkLicense, parseLicenseKeyFile } from './license/key.js'
import { licenceRequired } from './license/kind.js'
import { machineHash } from './license/machine.js'
import {
	type ActivateOutcome,
	ERROR_WORDS,
	ServiceLicence,
	type Transport,
	nodeTransport,
} from './license/service.js'
import { AdminLock, LOCK_FILE } from './lock.js'
import { uiFiles } from './manifest-r2.js'
import { pickLocale, resolveLocale, satisfiesRange } from './manifest.js'
import { type PackageFile, openPackage } from './package.js'
import {
	type StartTokens,
	acquireOwnedLock,
	createStartTokens,
	pidAlive,
	startTokenOf,
} from './proc-start.js'
import {
	checkActionAnswer,
	checkAnswer,
	queryAddress,
	requestOnce,
	waitForEndpoint,
} from './query.js'
import { type Scope, scopeHash, scopeOf, widerReasons, wordingDigest } from './scope.js'
import { readRunnerState } from './signin/reconcile.js'
import { type ChildLike, type SpawnSpec, cleanEnv, spawnChild } from './spawn.js'
import {
	type AuditLine,
	type ExtensionState,
	ExtensionStore,
	atomicWrite,
	removeTree,
} from './store.js'
import { type Snapshot, Supervisor } from './supervisor.js'
import type { Manifest } from './types.js'
import { type VerifiedPackage, verifyPackage } from './verify.js'

/** The facade the commands and the Desktop RPC share: every operation of the extension platform. */

export interface HostOptions {
	readonly home: string
	readonly hostVersion: string
	readonly kind: 'cli' | 'desktop' | 'run' | 'daemon'
	/** A short-lived command (`namzu extension enable`): it changes state and exits, and never starts a process itself. */
	readonly oneShot?: boolean
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	readonly arch?: string
	readonly now?: () => number
	/** The person's UI language; defaults to the environment's. */
	readonly locale?: () => string | undefined
	readonly spawn?: (spec: SpawnSpec) => ChildLike
	/** How a licence service is reached; tests give one that talks to the fake service. */
	readonly licenseTransport?: Transport
	/**
	 * Create, repair or remove the one per-user sign-in entry so that it exists exactly while an extension is
	 * enabled with its background switch on. Given by the command layer; a host without it changes no entry.
	 */
	readonly signin?: (wanted: boolean) => Promise<unknown>
	/**
	 * Make sure the one runner of this person is running (start it detached if not) and resolve to whether it
	 * is. An extension whose background switch is on is supervised by that runner, never by this host.
	 * Without it, or when it answers false, this host keeps such an extension running itself while it is open.
	 */
	readonly ensureRunner?: () => Promise<boolean>
	/** Tell a running runner to re-read the state files (a speed-up: it also watches them). */
	readonly notifyRunner?: () => Promise<void>
	readonly compiledKeys?: readonly TrustedKey[]
	readonly onState?: (event: StateEvent) => void
	/** Where diagnostics go; defaults to the process's CLI logger. */
	readonly log?: Logger
	/** Reads and remembers the start time of other processes; tests give one with a fake probe. */
	readonly startTokens?: StartTokens
}

export interface StateEvent {
	id: string
	state: ViewState
	indicator?: IndicatorView
	/** The extension's own chips, as its process last reported them (declared words only). */
	chips?: UiView['chips']
	since: number
}

export interface ExtensionView {
	id: string
	name: string
	version: string
	publisher: string
	state: ViewState
	chip: string
	indicator?: IndicatorView
	dev: boolean
	needs: ('license' | 'notice')[]
	enabled: boolean
	licence?: { customer: string; seats: number; expires: string }
	/** What kind of licence the package declares: none, a key file or the publisher's service. */
	licenceKind: 'none' | 'key' | 'service'
	/** The service host the licence check contacts (kind service only). */
	licenceHost?: string
	/** Days left of the offline grace when the licence could not be checked but the cached answer holds. */
	licenceGraceDaysLeft?: number
	/** When the service was last asked, and the next attempt (kind service only). */
	licenceChecked?: { lastAt: number; nextAt?: number; lastError?: string }
	licenceProblem?: string
	record?: { acknowledgedAt: string; noticeVersion: string; locale: string }
	updateWaiting?: { version: string; reasons: string[] }
	/** Starts at sign-in: what is declared, the person's switch, and who runs it now. */
	background?: BackgroundView
	/** The extension's own look: its icon, accent, pages and the chips its process reported. */
	ui?: UiView
	languages: string[]
	shownLocale: string
	running: boolean
	why?: string
	grants: string[]
	/** Present when the extension declares the administrator lock: whether it is on, and why it exists. */
	management?: ManagementView
}

export interface ManagementView {
	lock: 'administrator-password'
	/** An administrator password is set: turning it off or removing it needs that password. */
	locked: boolean
	/** The sentence the extension gives for the lock, in the person's language. */
	purpose: string
	/** Seconds until the next password is looked at, after a wrong one. */
	waitSeconds?: number
}

/** The administrator password a caller offers for an operation the lock guards. */
export interface AdminOption {
	readonly admin?: string
}

export interface BackgroundView {
	/** The own mark the extension declared for while Namzu is closed. */
	indicator: 'tray' | 'none'
	/** The label of that mark, in the person's language (kind tray). */
	indicatorLabel?: string
	defaultOn: boolean
	enabled: boolean
	since?: number
	/** Who supervises it now: the runner (also when Namzu is closed), this host, or nobody. */
	hostedBy: 'runner' | 'app' | 'none'
	/** The sign-in entry: registered, its kind, and whether the person switched it off in the system. */
	signin?: { registered: boolean; kind?: string; disabledByOs?: boolean; reason?: string }
}

export interface UiView {
	icon: string
	accent: string
	pages: { id: string; title: string; slot: string; minHeight?: number; usesNetwork: boolean }[]
	chips: { id: string; state: string; label: string; tone: string; icon?: string; opens?: string }[]
}

export interface AddResult {
	view: ExtensionView
	disclosure: Disclosure
	noop?: boolean
	update?: { waiting: boolean; reasons: string[] }
}

export interface NoticeView {
	noticeVersion: string
	scopeHash: string
	locale: string
	languageNote?: string
	text: string
	scopeWords: string[]
	disclosure: Disclosure
	record: ConsentRecord | null
	diff?: string[]
}

export function localeFromEnv(env: NodeJS.ProcessEnv): string | undefined {
	const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
	const m = /^([a-z]{2,3})(?:[_-]([A-Za-z0-9]+))?/.exec(raw)
	return m && m[1] !== 'C' && m[1] !== 'POSIX' ? m[1] : undefined
}

const alive = pidAlive

/**
 * The uncached, blocking read. Only for judging a lock's owner at the moment it matters (lock takeover in
 * `acquireOwnedLock`, `ownerLive`): there the answer must be right now, even if it costs a process spawn.
 */
export const startToken = startTokenOf

const SLOW_CALL_MS = 250

interface Loaded {
	manifest: Manifest
	verified: VerifiedPackage
	version: string
}

/** What Desktop needs to draw an extension's pages (see `ExtensionHost.uiInfo`). */
export interface UiInfo {
	version: string
	dir: string
	accent: string
	icon: string
	pages: {
		id: string
		title: string
		slot: string
		entry: string
		minHeight?: number
		usesNetwork: boolean
		bridge: { allow: string[]; host: string[] }
		hosts: string[]
	}[]
	chips: UiView['chips']
	files: { path: string; sha256: string }[]
	/** Every method a page may be allowed, with the size its answer may have. */
	methods: { method: string; maxBytes: number }[]
	actions: { id: string; needsGesture: boolean }[]
}

export class ExtensionHost {
	readonly store: ExtensionStore
	readonly consent: ConsentStore
	private readonly env: NodeJS.ProcessEnv
	private readonly platform: NodeJS.Platform
	private readonly arch: string
	private readonly now: () => number
	private readonly supervisors = new Map<string, Supervisor>()
	private readonly lastEvent = new Map<string, string>()
	private readonly queryBad = new Map<string, number>()
	private readonly maintenanceDay = new Map<string, number>()
	private timer: ReturnType<typeof setInterval> | undefined
	private userHashCache: string | undefined
	private readonly adminLock: AdminLock
	private readonly tokens: StartTokens
	/** Extensions whose view was drawn without a process's start time because it was not known yet. */
	private readonly awaitingToken = new Set<string>()

	constructor(private readonly o: HostOptions) {
		this.env = o.env ?? process.env
		this.platform = o.platform ?? process.platform
		this.arch = o.arch ?? process.arch
		this.now = o.now ?? Date.now
		this.store = new ExtensionStore(o.home, this.now)
		this.consent = new ConsentStore(this.store)
		this.adminLock = new AdminLock(this.store, this.now)
		this.tokens =
			o.startTokens ??
			createStartTokens({
				onResolved: () => {
					const ids = [...this.awaitingToken]
					this.awaitingToken.clear()
					for (const id of ids) this.emit(id)
				},
			})
	}

	private get logger(): Logger {
		return this.o.log ?? cliLogger()
	}

	private logCall(what: string, id: string, t0: number, outcome: 'ok' | 'failed'): void {
		const ms = this.now() - t0
		const attrs = {
			'namzu.extension.id': id,
			'namzu.extension.call': what,
			'namzu.extension.outcome': outcome,
			'namzu.extension.duration_ms': ms,
		}
		if (ms >= SLOW_CALL_MS) this.logger.warn('Extension call was slow', attrs)
		else this.logger.debug('Extension call', attrs)
	}

	/** Refuse unless the lock is off or the password is right; a wrong or missing one is audited. */
	private guard(id: string, admin: string | undefined, what: string): void {
		try {
			this.adminLock.require(id, admin)
		} catch (e) {
			if (e instanceof ExtensionError && e.code !== 'admin-wait')
				this.store.audit(id, 'unlock-failed', undefined, `${what}: ${e.code}`)
			throw e
		}
	}

	/** Whether an administrator password is set (the file, not the manifest, decides). */
	isLocked(id: string): boolean {
		return this.adminLock.state(id).locked
	}

	/** Refuse unless the lock is off or the password is right (for a command that stops the runner). */
	checkAdmin(id: string, opts: AdminOption = {}): void {
		this.guard(id, opts.admin, 'stop')
	}

	/** Take the lock off. Needs the password; the extension stays as it is. */
	unlock(id: string, opts: AdminOption = {}): ExtensionView {
		this.state(id)
		if (!this.adminLock.state(id).locked)
			throw new ExtensionError('not-locked', 'lock', 'This extension is not locked.')
		this.guard(id, opts.admin, 'unlock')
		this.adminLock.clear(id)
		this.store.audit(id, 'lock-released')
		this.emit(id)
		return this.view(id)
	}

	// --- small helpers -------------------------------------------------------------------------

	private uiLocale: string | undefined
	/** The app tells the host which language the person reads; it wins over the environment. */
	setLocale(tag: string | undefined): void {
		this.uiLocale = tag
	}
	private get locale(): string | undefined {
		return this.uiLocale ?? (this.o.locale ? this.o.locale() : localeFromEnv(this.env))
	}
	private get platformKey(): string {
		return `${this.platform}-${this.arch}`
	}
	private userHash(): string {
		this.userHashCache ??= osUserHash(this.store.installId())
		return this.userHashCache
	}
	private keys(): TrustedKey[] {
		return trustedKeys(this.env, this.o.compiledKeys)
	}
	private text(m: Manifest, t: Readonly<Record<string, string>>, locale = this.locale): string {
		return pickLocale(t, resolveLocale(m, locale).locale, m.defaultLocale).text
	}

	/** Verify an installed version from disk: signature and every file's hash, at every start. */
	private loadVersion(id: string, version: string): Loaded {
		const files = this.store.readVersion(id, version)
		const verified = verifyPackage(files, this.keys())
		return { manifest: verified.manifest, verified, version }
	}
	/** Verified versions kept for reading views; a start always verifies afresh (`fresh`), as the format requires. */
	private readonly verified = new Map<string, Loaded>()
	private active(id: string, fresh = false): Loaded {
		const st = this.state(id)
		if (!st.activeVersion)
			throw new ExtensionError('not-installed', 'state', `${id} has no installed version.`)
		const key = `${id}@${st.activeVersion}`
		const kept = this.verified.get(key)
		if (kept && !fresh) return kept
		const loaded = this.loadVersion(id, st.activeVersion)
		this.verified.set(key, loaded)
		return loaded
	}
	private forget(id: string): void {
		for (const k of [...this.verified.keys()]) if (k.startsWith(`${id}@`)) this.verified.delete(k)
	}
	private state(id: string): ExtensionState {
		const st = this.store.readState(id)
		if (!st) throw new ExtensionError('not-installed', 'state', `No extension ${id} is added.`)
		return st
	}
	private saveSeen(id: string): void {
		const st = this.store.readState(id)
		if (st && this.now() > st.lastSeenAt) this.store.writeState({ ...st, lastSeenAt: this.now() })
	}

	// --- add and update ------------------------------------------------------------------------

	add(source: Buffer, via: 'cli' | 'desktop' = 'cli'): AddResult {
		// Nothing is written anywhere until the package has been opened and verified.
		const files = openPackage(source)
		const verified = verifyPackage(files, this.keys())
		const m = verified.manifest
		if (!satisfiesRange(this.o.hostVersion, m.engines.namzu))
			throw new ExtensionError(
				'engine',
				'engines',
				`This extension needs Namzu ${m.engines.namzu}; this is ${this.o.hostVersion}.`,
			)
		if (!m.platforms.includes(this.platformKey))
			throw new ExtensionError(
				'platform',
				'platforms',
				`This extension has no build for ${this.platformKey} (it has ${m.platforms.join(', ')}).`,
			)
		const id = m.id
		this.store.ensureRoot()
		const existing = this.store.readState(id)
		const dataDir = this.store.dataDir(id)
		const newScope = scopeOf(m)
		if (!existing) {
			const tmp = this.store.unpack(id, m.version, files)
			this.store.commitUnpack(tmp, id, m.version)
			this.store.writeState({
				schema: 1,
				id,
				activeVersion: m.version,
				enabled: false,
				firstAddedAt: new Date(this.now()).toISOString(),
				lastSeenAt: this.now(),
				dev: verified.dev,
				keyId: verified.keyId,
			})
			this.store.audit(id, 'added', m.version, verified.dev ? 'dev key' : undefined)
			// A record kept after an earlier remove still covers the same scope: no second question.
			this.consent.purgeRemoved(id, this.now())
			const kept = this.consent.readRemoved(id)
			if (kept && coverage(kept, id, this.userHash(), newScope).covered) this.consent.restore(id)
			return {
				view: this.view(id),
				disclosure: disclose(m, this.locale, dataDir),
			}
		}
		const current = this.active(id)
		const cmp = cmpVersion(m.version, current.manifest.version)
		if (cmp === 0) {
			const same = sha256Hex(verified.manifestBytes) === sha256Hex(current.verified.manifestBytes)
			if (!same)
				throw new ExtensionError(
					'version',
					'same-version',
					`Version ${m.version} is already added with different contents. A changed package needs a higher version.`,
				)
			return {
				view: this.view(id),
				disclosure: disclose(m, this.locale, dataDir),
				noop: true,
			}
		}
		if (cmp < 0)
			throw new ExtensionError(
				'version',
				'older',
				`Version ${m.version} is older than the added ${current.manifest.version}.`,
			)
		if (
			current.manifest.legal.noticeVersion === m.legal.noticeVersion &&
			wordingDigest(current.manifest) !== wordingDigest(m)
		)
			throw new ExtensionError(
				'wording-changed',
				'notice-version',
				'The wording of the notice or the permissions changed but the notice version did not. Bump the notice version.',
			)
		const record = this.consent.read(id)
		const recorded: Scope = record ? record.scope : scopeOf(current.manifest)
		const reasons = record ? widerReasons(recorded, newScope) : []
		if (reasons.length === 0) {
			this.swap(id, files, m, verified.dev, verified.keyId, record, newScope)
			return {
				view: this.view(id),
				disclosure: disclose(m, this.locale, dataDir),
				update: { waiting: false, reasons: [] },
			}
		}
		if (existing.stagedVersion && existing.stagedVersion !== m.version)
			removeTree(this.store.versionDir(id, existing.stagedVersion))
		const tmp = this.store.unpack(id, m.version, files)
		this.store.commitUnpack(tmp, id, m.version)
		this.store.writeState({ ...existing, stagedVersion: m.version })
		this.store.audit(id, 'update-staged', m.version, reasons.join('; '))
		return {
			view: this.view(id),
			disclosure: disclose(m, this.locale, dataDir),
			update: { waiting: true, reasons },
		}
	}

	/** Same or narrower scope: swap at once, restart if running, narrow the record. */
	private swap(
		id: string,
		files: Map<string, PackageFile> | undefined,
		m: Manifest,
		dev: boolean,
		keyId: string,
		record: ConsentRecord | undefined,
		scope: Scope,
	): void {
		const st = this.state(id)
		const old = st.activeVersion
		const sup = this.supervisors.get(id)
		if (sup) this.supervisors.delete(id)
		if (files) {
			const tmp = this.store.unpack(id, m.version, files)
			this.store.commitUnpack(tmp, id, m.version)
		}
		this.store.writeState({
			...st,
			activeVersion: m.version,
			stagedVersion: undefined,
			dev,
			keyId,
			failed: undefined,
		})
		// A running process holds its executable (locked on Windows): the old folder goes after it has stopped,
		// and a folder that cannot be removed is left for the next start instead of failing the update.
		const dropOld = (): void => {
			if (!old || old === m.version) return
			try {
				removeTree(this.store.versionDir(id, old))
			} catch {
				// left behind
			}
		}
		if (!sup) dropOld()
		if (record && record.scopeHash !== scopeHash(scope)) {
			this.consent.narrow(record, scope, m.version)
			this.store.audit(id, 'record-narrowed', m.version)
		}
		this.store.audit(id, 'update-applied', m.version)
		if (sup)
			void sup.stop().then(() => {
				dropOld()
				this.tick()
			})
	}

	// --- views ---------------------------------------------------------------------------------

	private readonly serviceLicences = new Map<string, ServiceLicence>()
	/** The service licence of an installed extension: one object per id and version, so a refresh never overlaps itself. */
	private serviceLicence(id: string, loaded = this.active(id)): ServiceLicence | undefined {
		const { manifest, verified } = loaded
		if (manifest.licensing.kind !== 'service') return undefined
		const key = `${id}@${manifest.version}`
		const kept = this.serviceLicences.get(key)
		if (kept) return kept
		const keyFile = verified.files.get(manifest.licensing.service.verifier.keyFile)
		const verifierKey = keyFile ? parseLicenseKeyFile(keyFile.bytes.toString('utf8')) : undefined
		if (!verifierKey) return undefined
		const who =
			typeof process.getuid === 'function' ? String(process.getuid()) : (process.env.USERNAME ?? '')
		const sl = new ServiceLicence({
			manifest,
			verifierKey,
			machineHash: machineHash(this.store.installId(), id, who),
			hostVersion: this.o.hostVersion,
			cacheFile: this.store.file(id, 'license.json'),
			secretFile: this.store.file(id, 'license-secret.json'),
			transport: this.o.licenseTransport ?? nodeTransport(this.o.hostVersion),
			now: this.now,
			devMode: devModeOn(this.env),
			...(this.env.NAMZU_EXTENSION_TEST_LICENSE_BASE
				? { baseOverride: this.env.NAMZU_EXTENSION_TEST_LICENSE_BASE }
				: {}),
			audit: (event, detail) => this.store.audit(id, event, manifest.version, detail),
			highWater: () => this.store.readState(id)?.lastSeenAt,
		})
		this.serviceLicences.set(key, sl)
		return sl
	}

	licenseStatus(
		id: string,
		now = this.now(),
	): { state: 'absent' } | ({ state: 'checked' } & LicenseResult) {
		const { manifest, verified } = this.active(id)
		const lic = manifest.licensing
		if (lic.kind === 'none') return { state: 'absent' }
		if (lic.kind === 'service') {
			const sl = this.serviceLicence(id)
			if (!sl)
				return {
					state: 'checked',
					ok: false,
					code: 'wrong-key',
					message: 'The package has no readable licence key.',
				}
			const st = sl.state()
			switch (st.state) {
				case 'needs-license':
					return { state: 'absent' }
				case 'ok':
				case 'license-grace': {
					const p = st.payload
					return {
						state: 'checked',
						ok: true,
						payload: {
							v: 1,
							licenseId: p.licenseId,
							extensionId: p.extensionId,
							customer: p.customer,
							seats: p.seats,
							issuedAt: p.issuedAt,
							notBefore: p.issuedAt,
							expires: p.expires,
							features: p.features,
						},
						expiresAt: Date.parse(p.expires),
						...(st.state === 'license-grace' ? { graceDaysLeft: st.daysLeft } : {}),
					}
				}
				case 'license-revoked':
					return {
						state: 'checked',
						ok: false,
						code: 'revoked',
						message:
							st.reason === 'suspended'
								? 'The publisher suspended this licence.'
								: 'The publisher withdrew this licence.',
					}
				default:
					return {
						state: 'checked',
						ok: false,
						code: st.reason === 'clock' ? 'clock-rolled-back' : 'expired',
						message:
							st.reason === 'clock'
								? 'The computer clock is more than a day behind the last time Namzu saw it. Set the clock right.'
								: 'This licence has expired.',
					}
			}
		}
		const text = (() => {
			try {
				return readFileSync(this.store.file(id, 'license.json'), 'utf8')
			} catch {
				return undefined
			}
		})()
		if (text === undefined) return { state: 'absent' }
		const keyFile = verified.files.get(lic.verifier.keyFile)
		const verifierKey = keyFile ? parseLicenseKeyFile(keyFile.bytes.toString('utf8')) : undefined
		if (!verifierKey)
			return {
				state: 'checked',
				ok: false,
				code: 'wrong-key',
				message: 'The package has no readable licence key.',
			}
		return {
			state: 'checked',
			...checkLicense({
				text,
				manifest,
				verifierKey,
				now,
				highWater: this.store.readState(id)?.lastSeenAt,
				devMode: devModeOn(this.env),
			}),
		}
	}

	private coverageOf(id: string, m: Manifest) {
		return coverage(this.consent.read(id), id, this.userHash(), scopeOf(m))
	}

	view(id: string): ExtensionView {
		const st = this.state(id)
		const { manifest: m } = this.active(id)
		const { locale, available } = resolveLocale(m, this.locale)
		const lic = licenceRequired(m) ? this.licenseStatus(id) : ({ state: 'absent' } as const)
		const cov = this.coverageOf(id, m)
		const record = this.consent.read(id)
		const needs: ('license' | 'notice')[] = []
		const licOk = !licenceRequired(m) || (lic.state === 'checked' && lic.ok)
		if (!licOk) needs.push('license')
		if (!cov.covered) needs.push('notice')
		const snap = this.snapshotOf(id)
		const expired =
			licenceRequired(m) && lic.state === 'checked' && !lic.ok && lic.code === 'expired'
		const revoked =
			licenceRequired(m) && lic.state === 'checked' && !lic.ok && lic.code === 'revoked'
		const graceDaysLeft = lic.state === 'checked' && lic.ok ? lic.graceDaysLeft : undefined
		let state: ViewState
		let why: string | undefined
		if (st.enabled) {
			if (expired) state = 'license-expired'
			else if (revoked) state = 'license-revoked'
			else if (!cov.covered) state = 'needs-notice'
			else if (snap?.state === 'failed' || st.failed) {
				state = 'failed'
				why = snap?.failedReason ?? st.failed
			} else if (snap?.state === 'not-responding') state = 'not-responding'
			else if (snap?.state === 'collecting' || snap?.state === 'degraded') state = 'running'
			else if (snap?.state === 'starting' || snap?.state === 'stopping') state = 'starting'
			else state = 'stopped'
		} else if (needs.includes('license') && needs.includes('notice') && !record) state = 'added'
		else if (needs.includes('license')) state = 'needs-license'
		else if (needs.includes('notice')) state = 'needs-notice'
		else state = 'ready'
		if (
			st.stagedVersion &&
			state !== 'failed' &&
			state !== 'license-expired' &&
			state !== 'license-revoked'
		)
			state = state === 'running' ? 'running' : 'update-waiting'
		const degraded = snap?.state === 'degraded' || (this.queryBad.get(id) ?? 0) >= 3
		const declared = this.text(
			m,
			(degraded
				? (m.contributes.indicator.states.degraded ?? m.contributes.indicator.states.collecting)
				: m.contributes.indicator.states.collecting
			).label,
		)
		const name = this.text(m, m.name)
		const indicatorState: ViewState = st.stagedVersion && state === 'running' ? 'running' : state
		const indicator =
			st.enabled || state === 'needs-notice'
				? indicatorFor({
						state: indicatorState,
						degraded,
						name,
						declared,
						locale: this.locale,
						...(graceDaysLeft !== undefined ? { graceDaysLeft } : {}),
					})
				: undefined
		const licence =
			lic.state === 'checked' && lic.ok
				? {
						customer: lic.payload.customer.name,
						seats: lic.payload.seats,
						expires: lic.payload.expires,
					}
				: undefined
		const staged = st.stagedVersion ? this.stagedInfo(id, st.stagedVersion, record) : undefined
		return {
			id,
			name,
			version: m.version,
			publisher: m.publisher.name,
			state,
			chip: chipFor(state, this.locale, degraded),
			...(indicator ? { indicator } : {}),
			dev: st.dev,
			needs,
			enabled: st.enabled,
			...(licence ? { licence } : {}),
			licenceKind: m.licensing.kind,
			...(m.licensing.kind === 'service'
				? {
						licenceHost: /^https:\/\/([^/]+)/.exec(m.licensing.service.baseUrl)?.[1] ?? '',
						...this.licenceChecked(id),
					}
				: {}),
			...(graceDaysLeft !== undefined ? { licenceGraceDaysLeft: graceDaysLeft } : {}),
			...(m.background ? { background: this.backgroundView(id, m, st) } : {}),
			...(m.ui ? { ui: this.uiView(m, snap) } : {}),
			...(lic.state === 'checked' && !lic.ok ? { licenceProblem: lic.message } : {}),
			...(record
				? {
						record: {
							acknowledgedAt: record.acknowledgedAt,
							noticeVersion: record.noticeVersion,
							locale: record.noticeLocale,
						},
					}
				: {}),
			...(staged ? { updateWaiting: staged } : {}),
			languages: [...m.locales],
			shownLocale: available ? locale : m.defaultLocale,
			running: snap?.state === 'collecting' || snap?.state === 'degraded',
			...(why ? { why } : {}),
			grants: Object.keys(record?.grants ?? {}),
			...(m.management
				? {
						management: {
							lock: m.management.lock,
							...(({ locked, waitSeconds }) => ({
								locked,
								...(waitSeconds !== undefined ? { waitSeconds } : {}),
							}))(this.adminLock.state(id)),
							purpose: this.text(m, m.management.purpose),
						},
					}
				: {}),
		}
	}

	private backgroundView(id: string, m: Manifest, st: ExtensionState): BackgroundView {
		const b = m.background as NonNullable<Manifest['background']>
		const lock = this.store.readJson<{
			hostPid: number
			token: string
			kind?: string
			snapshot?: { state?: string }
		}>(id, 'run/state.json')
		let hostedBy: BackgroundView['hostedBy'] = 'none'
		if (this.supervisors.has(id)) hostedBy = this.o.kind === 'daemon' ? 'runner' : 'app'
		// A runner that has stopped the extension leaves its file behind: that is not "run by" anyone.
		else if (lock && lock.snapshot?.state !== 'stopped' && alive(lock.hostPid)) {
			const tok = this.tokens.peek(lock.hostPid)
			if (tok === undefined) this.awaitingToken.add(id)
			else if (lock.token === tok) hostedBy = lock.kind === 'daemon' ? 'runner' : 'app'
		}
		const signin = readRunnerState(this.store.root)?.signin
		return {
			indicator: b.indicator.kind,
			...(b.indicator.kind === 'tray' ? { indicatorLabel: this.text(m, b.indicator.label) } : {}),
			defaultOn: b.defaultOn,
			enabled: st.background?.enabled === true,
			...(st.background ? { since: st.background.since } : {}),
			hostedBy,
			...(signin ? { signin } : {}),
		}
	}

	private uiView(m: Manifest, snap: Snapshot | undefined): UiView {
		const ui = m.ui as NonNullable<Manifest['ui']>
		const reported = snap?.lastStatus?.chip ?? {}
		const chips: UiView['chips'] = []
		for (const c of ui.chips ?? []) {
			// Only a state the manifest declared is drawn, and only with the words the manifest declared.
			const state = reported[c.id]
			const s = typeof state === 'string' ? c.states[state] : undefined
			if (!s || typeof state !== 'string') continue
			chips.push({
				id: c.id,
				state,
				label: this.text(m, s.label),
				tone: s.tone,
				...(s.icon ? { icon: s.icon } : {}),
				...(c.opens ? { opens: c.opens } : {}),
			})
		}
		return {
			icon: ui.icon,
			accent: ui.accent,
			pages: (ui.pages ?? []).map((p) => ({
				id: p.id,
				title: this.text(m, p.title),
				slot: p.slot,
				...(p.minHeight ? { minHeight: p.minHeight } : {}),
				usesNetwork: p.usesNetwork === true,
			})),
			chips,
		}
	}

	private licenceChecked(id: string): Pick<ExtensionView, 'licenceChecked'> {
		const sl = this.serviceLicence(id)
		const c = sl?.cache()
		if (!sl || !c) return {}
		const nextAt = sl.nextAt()
		return {
			licenceChecked: {
				lastAt: c.lastAttemptAt,
				...(nextAt !== undefined ? { nextAt } : {}),
				...(c.lastError ? { lastError: c.lastError } : {}),
			},
		}
	}

	private stagedInfo(
		id: string,
		version: string,
		record: ConsentRecord | undefined,
	): { version: string; reasons: string[] } | undefined {
		try {
			const s = this.loadVersion(id, version)
			const recorded = record ? record.scope : scopeOf(this.active(id).manifest)
			return { version, reasons: widerReasons(recorded, scopeOf(s.manifest)) }
		} catch {
			return undefined
		}
	}

	list(): ExtensionView[] {
		const out: ExtensionView[] = []
		for (const id of this.store.listIds()) {
			try {
				out.push(this.view(id))
			} catch (e) {
				// a broken install (tampered files) is listed by status, not hidden
				const st = this.store.readState(id)
				if (st)
					out.push({
						id,
						name: id,
						version: st.activeVersion ?? '?',
						publisher: '',
						state: 'failed',
						chip: chipFor('failed', this.locale),
						dev: st.dev,
						needs: [],
						enabled: st.enabled,
						licenceKind: 'none',
						languages: [],
						shownLocale: '',
						running: false,
						why: e instanceof ExtensionError ? `${e.code}: ${e.message}` : (e as Error).message,
						grants: [],
					})
			}
		}
		return out
	}

	status(id: string) {
		const view = this.view(id)
		const st = this.state(id)
		const snap = this.snapshotOf(id)
		return {
			view,
			failedReason: snap?.failedReason ?? st.failed,
			restartsLastHour: snap?.restartsLastHour ?? 0,
			signals: snap?.lastStatus?.signals ?? null,
			process: snap?.lastStatus ?? null,
			record: this.consent.read(id) ?? null,
			staged: view.updateWaiting ?? null,
			audit: this.store.readAudit(id, 10),
		}
	}

	audit(id: string, limit = 50): AuditLine[] {
		this.state(id)
		return this.store.readAudit(id, Math.min(Math.max(limit, 1), 500))
	}

	/**
	 * What the process hosting `id` last reported. Never blocks on a process spawn: a foreign host's start
	 * time is read once and kept, and while it is not known yet the answer is `undefined` (the view reads
	 * as not running) and the view is refreshed with an event when the answer arrives. `cheap` trusts the
	 * pid check alone (the page open path, which only needs the reported state).
	 */
	private snapshotOf(id: string, cheap = false): Snapshot | undefined {
		const sup = this.supervisors.get(id)
		if (sup) return sup.snapshot()
		const f = this.store.readJson<{
			hostPid: number
			token: string
			snapshot: Snapshot
		}>(id, 'run/state.json')
		if (!f || !alive(f.hostPid) || f.hostPid === process.pid) return undefined
		if (cheap) return f.snapshot
		const tok = this.tokens.peek(f.hostPid)
		if (tok === undefined) {
			this.awaitingToken.add(id)
			return undefined
		}
		return f.token === tok ? f.snapshot : undefined
	}

	// --- notice, consent -----------------------------------------------------------------------

	/** What `enable` must show before it can run: the staged update's notice, or the active one when nothing covers it. */
	pendingNotice(id: string): { staged: boolean } | null {
		const st = this.state(id)
		if (st.stagedVersion) return { staged: true }
		const { manifest } = this.active(id)
		return this.coverageOf(id, manifest).covered ? null : { staged: false }
	}

	notice(id: string, opts: { staged?: boolean; locale?: string } = {}): NoticeView {
		const st = this.state(id)
		const version = opts.staged ? st.stagedVersion : st.activeVersion
		if (!version) throw new ExtensionError('no-staged', 'staged', 'No update is waiting.')
		const loaded = this.loadVersion(id, version)
		const m = loaded.manifest
		const wanted = opts.locale ?? this.locale
		const { locale, available } = resolveLocale(m, wanted)
		const noticeLocale = m.legal.notices[locale] ? locale : m.defaultLocale
		const file = m.legal.notices[noticeLocale]?.file as string
		const text = stripLeadingComments(loaded.verified.files.get(file)?.bytes.toString('utf8') ?? '')
		const d = disclose(m, noticeLocale, this.store.dataDir(id))
		const record = this.consent.read(id) ?? null
		const diff = opts.staged
			? widerReasons(record ? record.scope : scopeOf(this.active(id).manifest), scopeOf(m))
			: undefined
		return {
			noticeVersion: m.legal.noticeVersion,
			scopeHash: scopeHash(scopeOf(m)),
			locale: noticeLocale,
			...(available && m.legal.notices[locale]
				? {}
				: {
						languageNote:
							d.languageNote ??
							`This extension is not available in your language. Showing ${localeName(noticeLocale)}.`,
					}),
			text,
			scopeWords: scopeWords(d),
			disclosure: d,
			record,
			...(diff ? { diff } : {}),
		}
	}

	/** Written only after the person acknowledged exactly the notice version and scope hash they were shown. */
	acknowledge(
		id: string,
		input: {
			noticeVersion: string
			scopeHash: string
			locale?: string
			staged?: boolean
			via?: 'cli' | 'desktop'
			/** The "Start when I sign in" switch as the person left it; the manifest's default when absent. */
			startAtSignin?: boolean
			/** The administrator password to set, when this update adds the lock to an extension that is already on. */
			admin?: string
		},
	): ConsentRecord {
		const st = this.state(id)
		const version = input.staged ? st.stagedVersion : st.activeVersion
		if (!version) throw new ExtensionError('no-staged', 'staged', 'No update is waiting.')
		const loaded = this.loadVersion(id, version)
		const m = loaded.manifest
		const scope = scopeOf(m)
		if (input.noticeVersion !== m.legal.noticeVersion || input.scopeHash !== scopeHash(scope))
			throw new ExtensionError(
				'stale-notice',
				'echo',
				'The notice you were shown is not the one that applies now. Read it again.',
			)
		// An update that adds the lock to an extension that is already running must set the password now:
		// otherwise it would keep running with the lock declared and nobody holding the key.
		const addsLock =
			input.staged === true &&
			m.management !== undefined &&
			st.enabled &&
			!this.adminLock.state(id).locked
		if (addsLock) {
			if (!input.admin)
				throw new ExtensionError(
					'admin-needed',
					'lock',
					'This update adds an administrator lock to an extension that is on. Set an administrator password to accept it. Only the administrator will be able to turn it off.',
				)
			AdminLock.checkNew(input.admin)
		}
		const noticeLocale = m.legal.notices[input.locale ?? '']
			? (input.locale as string)
			: m.defaultLocale
		const prev = this.consent.read(id)
		const record: ConsentRecord = {
			schema: 1,
			extensionId: id,
			person: { osUserHash: this.userHash() },
			acknowledgedAt: new Date(this.now()).toISOString(),
			noticeVersion: m.legal.noticeVersion,
			noticeLocale,
			noticeSha256: m.legal.notices[noticeLocale]?.sha256 ?? '',
			scopeHash: scopeHash(scope),
			scope,
			wordingDigest: wordingDigest(m),
			firstVersion: prev?.firstVersion ?? m.version,
			versionAtAcknowledgement: m.version,
			via: input.via ?? 'cli',
			hostVersion: this.o.hostVersion,
			...(m.background
				? {
						background: {
							offeredDefault: m.background.defaultOn,
							chosen: input.startAtSignin ?? m.background.defaultOn,
							at: new Date(this.now()).toISOString(),
						},
					}
				: {}),
			grants: prev?.grants ?? {},
			previous: prev
				? [
						{
							acknowledgedAt: prev.acknowledgedAt,
							noticeVersion: prev.noticeVersion,
							scopeHash: prev.scopeHash,
						},
						...prev.previous,
					].slice(0, 20)
				: [],
		}
		this.consent.write(record)
		this.store.audit(id, 'acknowledged', m.version, `notice ${m.legal.noticeVersion}`)
		if (addsLock && input.admin) {
			this.adminLock.set(id, input.admin)
			this.store.audit(id, 'lock-set', m.version)
		}
		if (input.staged)
			this.swap(id, undefined, m, loaded.verified.dev, loaded.verified.keyId, record, scope)
		// The switch is the person's action; the scope is the person's acknowledgement. Both are recorded.
		if (m.background) {
			const cur = this.state(id)
			const chosen = input.startAtSignin ?? cur.background?.enabled ?? m.background.defaultOn
			if (cur.background?.enabled !== chosen) {
				this.store.writeState({ ...cur, background: { enabled: chosen, since: this.now() } })
				this.store.audit(
					id,
					chosen ? 'background-on' : 'background-off',
					m.version,
					'at acknowledgement',
				)
			}
		}
		return record
	}

	declined(id: string): void {
		this.store.audit(id, 'declined')
	}
	noticeShown(id: string): void {
		this.store.audit(id, 'notice-shown')
	}

	// --- licence -------------------------------------------------------------------------------

	setLicense(
		id: string,
		text: string,
		opts: AdminOption = {},
	): { customer: string; seats: number; expires: string } {
		const { manifest, verified } = this.active(id)
		this.guard(id, opts.admin, 'licence')
		if (manifest.licensing.kind !== 'key')
			throw new ExtensionError(
				'license-kind',
				'kind',
				manifest.licensing.kind === 'none'
					? 'This extension needs no licence.'
					: 'This extension checks its licence with a service: enter the licence key instead of a file.',
			)
		const keyFile = verified.files.get(manifest.licensing.verifier.keyFile)
		const verifierKey = keyFile ? parseLicenseKeyFile(keyFile.bytes.toString('utf8')) : undefined
		if (!verifierKey)
			throw new ExtensionError(
				'license-wrong-key',
				'verifier',
				'The package has no readable licence key.',
			)
		const st = this.state(id)
		const r = checkLicense({
			text,
			manifest,
			verifierKey,
			now: this.now(),
			highWater: st.lastSeenAt,
			devMode: devModeOn(this.env),
		})
		if (!r.ok) {
			this.store.audit(id, 'license-failed', undefined, r.code)
			throw new ExtensionError(`license-${r.code}`, r.code, r.message)
		}
		atomicWrite(
			this.store.file(id, 'license.json'),
			text.endsWith('\n') ? text : `${text}\n`,
			0o600,
		)
		this.saveSeen(id)
		this.store.audit(id, 'license-set', undefined, r.payload.customer.id)
		if (!this.o.oneShot) this.tick()
		return {
			customer: r.payload.customer.name,
			seats: r.payload.seats,
			expires: r.payload.expires,
		}
	}

	/** The licence file the extension may read: the signed key file, the service's signed answer, or none. */
	private licensePathFor(id: string, m: Manifest): string {
		if (m.licensing.kind === 'key') return this.store.file(id, 'license.json')
		if (m.licensing.kind === 'none') return ''
		const f = join(this.store.runDir(id), 'license-answer.json')
		try {
			const text = this.serviceLicence(id)?.answerForExtension()
			if (text) {
				mkdirSync(this.store.runDir(id), { recursive: true, mode: 0o700 })
				atomicWrite(f, `${text}\n`, 0o600)
			}
		} catch {
			// the extension starts without an answer file: it sees no licence and says so
		}
		return f
	}

	/** Activate a service licence with the key the person typed. The key is kept by Namzu and never returned. */
	async setLicenseKey(id: string, key: string, opts: AdminOption = {}): Promise<ActivateOutcome> {
		this.guard(id, opts.admin, 'licence')
		const sl = this.serviceLicence(id)
		if (!sl)
			throw new ExtensionError(
				'license-kind',
				'kind',
				'This extension does not check its licence with a service.',
			)
		const out = await sl.activate(key.trim())
		this.saveSeen(id)
		if (out.ok && !this.o.oneShot) this.tick()
		if (!out.ok) this.store.audit(id, 'license-failed', undefined, out.code)
		return out
	}

	/** Check now, or release this computer. The result never carries the key. */
	async licenseAction(
		id: string,
		action: 'check' | 'release',
		opts: AdminOption = {},
	): Promise<{ done: boolean; error?: string; view: ExtensionView }> {
		if (action === 'release') this.guard(id, opts.admin, 'licence')
		const sl = this.serviceLicence(id)
		if (!sl)
			throw new ExtensionError(
				'license-kind',
				'kind',
				'This extension does not check its licence with a service.',
			)
		let done = false
		let error: string | undefined
		if (action === 'check') {
			const r = await sl.refresh()
			done = r.changed
			error = r.error
			if (r.changed) this.licensePathFor(id, this.active(id).manifest)
		} else {
			done = (await sl.release()).released
			if (done)
				dropCache([this.store.file(id, 'license.json'), this.store.file(id, 'license-secret.json')])
			else error = 'unreachable'
		}
		if (!this.o.oneShot) this.tick()
		this.emit(id)
		return {
			done,
			...(error ? { error: ERROR_WORDS[error] ?? error } : {}),
			view: this.view(id),
		}
	}

	/** Refresh every service licence that is due. Only while the extension is enabled; a failed attempt only counts. */
	private refreshDue(id: string, m: Manifest): void {
		const sl = m.licensing.kind === 'service' ? this.serviceLicence(id) : undefined
		if (!sl || !sl.due()) return
		void sl.refresh().then((r) => {
			if (!r.changed) return
			this.licensePathFor(id, m)
			this.tick()
		})
	}

	// --- start at sign-in ----------------------------------------------------------------------

	/** Whether the extension should be run by the runner: enabled, switch on, and the declared block still there. */
	private wantsBackground(id: string, st: ExtensionState): boolean {
		if (!st.enabled || st.background?.enabled !== true) return false
		try {
			const m = this.active(id).manifest
			if (!m.background) return false
			const perm = m.permissions.find((p) => p.id === m.background?.permission)
			if (perm?.optional && !this.consent.read(id)?.grants?.[perm.id]) return false
			return this.coverageOf(id, m).covered
		} catch {
			return false
		}
	}

	/** Make the per-user sign-in entry match what is enabled: it exists exactly while some extension wants it. */
	async reconcile(): Promise<void> {
		if (!this.o.signin) return
		const wanted = this.store.listIds().some((id) => {
			const st = this.store.readState(id)
			return st ? this.wantsBackground(id, st) : false
		})
		try {
			await this.o.signin(wanted)
		} catch {
			// an entry that cannot be made is said by the status, never by a failed command
		}
	}

	/** The "Start when I sign in" switch. Turning it off removes the entry when no other extension needs it. */
	async setBackground(id: string, on: boolean, opts: AdminOption = {}): Promise<ExtensionView> {
		const st = this.state(id)
		if (!on && st.background?.enabled === true) this.guard(id, opts.admin, 'background')
		const { manifest: m } = this.active(id)
		if (!m.background)
			throw new ExtensionError(
				'no-background',
				'background',
				'This extension does not start when you sign in.',
			)
		if (on) {
			if (!this.coverageOf(id, m).covered)
				throw new ExtensionError(
					'needs-notice',
					'notice',
					'Read the notice and acknowledge it first: it says what running at sign-in means.',
				)
			const perm = m.permissions.find((p) => p.id === m.background?.permission)
			if (perm?.optional && !this.consent.read(id)?.grants?.[perm.id])
				throw new ExtensionError(
					'needs-grant',
					'grant',
					`Allow ${perm.id} first: starting at sign-in is optional for this extension.`,
				)
		}
		if ((st.background?.enabled === true) !== on) {
			this.store.writeState({ ...st, background: { enabled: on, since: this.now() } })
			this.store.audit(id, on ? 'background-on' : 'background-off', m.version)
		}
		await this.reconcile()
		await this.o.notifyRunner?.()
		if (!this.o.oneShot) this.tick()
		this.emit(id)
		return this.view(id)
	}

	// --- enable, disable, remove, grants -------------------------------------------------------

	enable(id: string, opts: AdminOption = {}): ExtensionView {
		const st = this.state(id)
		const { manifest: m } = this.active(id)
		if (licenceRequired(m)) {
			const lic = this.licenseStatus(id)
			if (lic.state === 'absent')
				throw new ExtensionError('needs-license', 'license', 'Add a licence key first.')
			if (!lic.ok) throw new ExtensionError('needs-license', lic.code, lic.message)
		}
		if (st.stagedVersion || !this.coverageOf(id, m).covered)
			throw new ExtensionError(
				'needs-notice',
				'notice',
				'Read the notice and acknowledge it first.',
			)
		// An extension that declares the lock is turned on with an administrator password, once.
		if (m.management && !this.adminLock.state(id).locked) {
			if (!opts.admin)
				throw new ExtensionError(
					'admin-needed',
					'lock',
					'Set an administrator password to turn this on. Only the administrator will be able to turn it off.',
				)
			this.adminLock.set(id, opts.admin)
			this.store.audit(id, 'lock-set', m.version)
		}
		this.store.writeState({ ...st, enabled: true, failed: undefined })
		this.store.audit(id, 'enabled', m.version)
		this.saveSeen(id)
		const sup = this.supervisors.get(id)
		if (sup) sup.startAgain()
		if (!this.o.oneShot) this.tick()
		void this.reconcile().then(() => this.o.notifyRunner?.())
		return this.view(id)
	}

	async disable(id: string, opts: AdminOption = {}): Promise<ExtensionView> {
		const st = this.state(id)
		this.guard(id, opts.admin, 'disable')
		return this.stopExtension(id, st)
	}

	/** The stop itself, after the lock has been passed. */
	private async stopExtension(id: string, st: ExtensionState): Promise<ExtensionView> {
		this.store.writeState({ ...st, enabled: false })
		this.store.audit(id, 'disabled')
		const sup = this.supervisors.get(id)
		if (sup) {
			this.supervisors.delete(id)
			await sup.stop()
			this.releaseLock(id)
		}
		await this.maintenance(id, 'onDisable')
		await this.reconcile()
		await this.o.notifyRunner?.()
		this.emit(id)
		return this.view(id)
	}

	async remove(id: string, deleteData: boolean, opts: AdminOption = {}): Promise<void> {
		this.guard(id, opts.admin, 'remove')
		// A removal never needs a verified install: a tampered, key-rotated or dev-key one must go too.
		let retainDays = 3650
		try {
			retainDays = this.active(id).manifest.legal.acknowledgement.retainDays
		} catch {
			// keep the evidence for the longest period a manifest may declare
		}
		try {
			await this.stopExtension(id, this.state(id))
		} catch {
			// the stop and the state change come before the view that cannot be read
		}
		this.consent.archive(id, retainDays, this.now())
		// A licence seat is freed at the publisher first, as a best effort that never blocks a removal.
		try {
			const loaded = this.active(id)
			const l = loaded.manifest.licensing
			if (l.kind === 'service' && l.service.releaseOnRemove)
				await this.serviceLicence(id, loaded)?.release()
		} catch {
			// the seat may need freeing at the publisher
		}
		try {
			for (const name of ['versions', 'run']) removeTree(this.store.file(id, name))
			for (const name of [
				'license.json',
				'license-secret.json',
				'keys.json',
				'settings.json',
				'state.json',
				LOCK_FILE,
			])
				rmSync(this.store.file(id, name), { force: true })
			if (deleteData) removeTree(this.store.dataDir(id))
		} catch (error) {
			// Windows keeps a file busy for a moment after its program stops; say so instead of crashing.
			const code = (error as NodeJS.ErrnoException).code
			if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')
				throw new ExtensionError(
					'in-use',
					'remove',
					`Some of ${id}'s files are still in use, so not all of them were deleted. Wait a moment and remove it again.`,
				)
			throw error
		}
		this.forget(id)
		this.store.audit(id, 'removed', undefined, deleteData ? 'data deleted' : 'data kept')
		// The audit log stays with a kept data folder; with the data gone nothing of it needs to stay.
		if (deleteData) {
			removeTree(this.store.dir(id))
		}
		this.lastEvent.delete(id)
		await this.reconcile()
		await this.o.notifyRunner?.()
	}

	grant(id: string, permission: string, via: 'cli' | 'desktop' = 'cli'): ExtensionView {
		const { manifest: m } = this.active(id)
		const p = m.permissions.find((x) => x.id === permission)
		if (!p)
			throw new ExtensionError(
				'unknown-permission',
				'grant',
				`${permission} is not declared by this extension.`,
			)
		if (!p.optional)
			throw new ExtensionError(
				'not-optional',
				'grant',
				`${permission} is part of the scope you acknowledged; it cannot be granted separately.`,
			)
		const rec = this.consent.read(id)
		if (!rec)
			throw new ExtensionError(
				'needs-notice',
				'notice',
				'Acknowledge the notice before granting a permission.',
			)
		this.consent.write({
			...rec,
			via: rec.via,
			grants: {
				...rec.grants,
				[permission]: {
					grantedAt: new Date(this.now()).toISOString(),
					purposeIds: p.purposes.map((u) => u.id),
				},
			},
		})
		this.store.audit(id, 'grant', undefined, `${permission} via ${via}`)
		this.restartSupervisor(id)
		return this.view(id)
	}

	revoke(id: string, permission: string, opts: AdminOption = {}): ExtensionView {
		this.guard(id, opts.admin, 'revoke')
		const { manifest: m } = this.active(id)
		const p = m.permissions.find((x) => x.id === permission)
		if (!p)
			throw new ExtensionError(
				'unknown-permission',
				'revoke',
				`${permission} is not declared by this extension.`,
			)
		if (!p.optional)
			throw new ExtensionError(
				'not-optional',
				'revoke',
				`${permission} is part of the scope; use disable to stop the extension.`,
			)
		const rec = this.consent.read(id)
		if (rec?.grants[permission]) {
			const { [permission]: _gone, ...rest } = rec.grants
			this.consent.write({ ...rec, grants: rest })
		}
		this.store.audit(id, 'revoke', undefined, permission)
		this.restartSupervisor(id)
		return this.view(id)
	}

	/** Stop and start this extension's process again (the runner's `restart` operation). */
	restartExtension(id: string): boolean {
		if (!this.supervisors.has(id)) return false
		this.restartSupervisor(id)
		return true
	}

	private restartSupervisor(id: string): void {
		const sup = this.supervisors.get(id)
		if (!sup) return
		this.supervisors.delete(id)
		void sup.stop().then(() => this.tick())
	}

	// --- settings, keys ------------------------------------------------------------------------

	private secretSetting(m: Manifest, key: string) {
		const s = (m.contributes.settings ?? []).find((x) => x.key === key)
		if (!s)
			throw new ExtensionError('R7', 'settings', `${key} is not a setting this extension declares.`)
		return s
	}

	/** The model API key row: stored apart from the person's own keys, never returned, used by nothing in phase 1. */
	setKey(
		id: string,
		provider: string,
		value: string | null,
		settingKey = 'modelKey',
		opts: AdminOption = {},
	): { hasValue: boolean; masked?: string } {
		this.guard(id, opts.admin, 'key')
		const { manifest: m } = this.active(id)
		const s = this.secretSetting(m, settingKey)
		if (s.type !== 'secret')
			throw new ExtensionError('R7', 'settings', `${settingKey} is not a secret.`)
		if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(provider))
			throw new ExtensionError(
				'usage',
				'provider',
				'A provider name is lowercase letters, digits, dots, dashes.',
			)
		const cur = this.store.readJson<Record<string, string>>(id, 'keys.json') ?? {}
		if (value === null) delete cur[provider]
		else cur[provider] = value
		this.store.writeJson(id, 'keys.json', cur, 0o600)
		this.store.audit(
			id,
			'key-set',
			undefined,
			`${provider} ${value === null ? 'removed' : 'stored'}`,
		)
		return this.keyView(id, provider)
	}
	keyView(id: string, provider: string): { hasValue: boolean; masked?: string } {
		const v = this.store.readJson<Record<string, string>>(id, 'keys.json')?.[provider]
		return v ? { hasValue: true, masked: `${'*'.repeat(8)}${v.slice(-4)}` } : { hasValue: false }
	}
	getSetting(
		id: string,
		key: string,
		provider?: string,
	): { value?: unknown; hasValue?: boolean; masked?: string } {
		const { manifest: m } = this.active(id)
		const s = this.secretSetting(m, key)
		if (s.type === 'secret') return this.keyView(id, provider ?? 'default')
		return {
			value: this.store.readJson<Record<string, unknown>>(id, 'settings.json')?.[key],
		}
	}
	setSetting(
		id: string,
		key: string,
		value: unknown,
		provider?: string,
		opts: AdminOption = {},
	): { value?: unknown; hasValue?: boolean; masked?: string } {
		const { manifest: m } = this.active(id)
		const s = this.secretSetting(m, key)
		if (s.type === 'secret') {
			if (typeof value !== 'string' && value !== null)
				throw new ExtensionError('usage', 'value', 'A key is text.')
			return this.setKey(id, provider ?? 'default', value as string | null, key, opts)
		}
		const cur = this.store.readJson<Record<string, unknown>>(id, 'settings.json') ?? {}
		cur[key] = value
		this.store.writeJson(id, 'settings.json', cur)
		return { value }
	}

	// --- queries -------------------------------------------------------------------------------

	async query(id: string, queryId: string, params: unknown = {}): Promise<unknown> {
		const t0 = this.now()
		try {
			const r = await this.runQuery(id, queryId, params)
			this.logCall('query', id, t0, 'ok')
			return r
		} catch (e) {
			this.logCall('query', id, t0, 'failed')
			throw e
		}
	}

	private async runQuery(id: string, queryId: string, params: unknown): Promise<unknown> {
		const { manifest: m, verified } = this.active(id)
		const q = m.contributes.endpoint.queries.find((x) => x.id === queryId)
		if (!q) {
			this.store.audit(id, 'query-refused', undefined, `R1 ${queryId}`)
			throw new ExtensionError('R1', 'query', `${queryId} is not a query this extension declares.`)
		}
		const run = this.store.readJson<{ addr: string; hostPid: number }>(id, 'run/state.json')
		const addr = run?.addr
		if (!addr)
			throw new ExtensionError(
				'not-running',
				'query',
				'The extension is not running, so it cannot answer.',
			)
		const schemaFile = verified.files.get(q.schema)?.bytes.toString('utf8')
		const schema = schemaFile ? JSON.parse(schemaFile) : undefined
		const raw = (await requestOnce(
			addr,
			{ v: 1, id: String(this.now()), query: queryId, params },
			undefined,
			q.maxBytes + 64,
		)) as unknown
		const bytes = Buffer.byteLength(JSON.stringify(raw))
		const res = checkAnswer(m, queryId, raw, schema, bytes)
		if (!res.ok) {
			this.store.audit(id, 'query-refused', undefined, `${res.code} ${queryId}`)
			const n = (this.queryBad.get(id) ?? 0) + 1
			this.queryBad.set(id, n)
			if (n === 3) this.emit(id)
			throw new ExtensionError(
				res.code,
				'answer',
				`The answer was refused (${res.code}): ${res.message}`,
			)
		}
		this.queryBad.set(id, 0)
		return res.result
	}

	/**
	 * One declared action of an extension (`namzu-ext-query/2`): the only calls a page may make that change
	 * anything, and what they may change is declared. Params are checked against the action's schema before
	 * they reach the process, the answer against its schema and size.
	 */
	async action(
		id: string,
		actionId: string,
		params: unknown = {},
		activation = false,
	): Promise<unknown> {
		const { manifest: m, verified } = this.active(id)
		const a = m.contributes.endpoint.actions?.find((x) => x.id === actionId)
		if (!a || m.contributes.endpoint.protocol !== 'namzu-ext-query/2') {
			this.store.audit(id, 'query-refused', undefined, `R1 action ${actionId}`)
			throw new ExtensionError(
				'R1',
				'action',
				`${actionId} is not an action this extension declares.`,
			)
		}
		if (a.needsGesture === true && !activation)
			throw new ExtensionError(
				'gesture-required',
				'activation',
				'That needs a click or a key press in the page.',
			)
		const read = (f: string): unknown => {
			try {
				return JSON.parse(verified.files.get(f)?.bytes.toString('utf8') ?? 'null')
			} catch {
				return undefined
			}
		}
		const bad = schemaProblems(read(a.paramsSchema), params)
		if (bad.length > 0) {
			this.store.audit(id, 'query-refused', undefined, `bad-params ${actionId}`)
			throw new ExtensionError('bad-params', 'params', `The call does not fit: ${bad[0]}`)
		}
		const addr = this.store.readJson<{ addr: string }>(id, 'run/state.json')?.addr
		if (!addr)
			throw new ExtensionError(
				'not-running',
				'action',
				'The extension is not running, so it cannot answer.',
			)
		const raw = await requestOnce(
			addr,
			{ v: 1, id: String(this.now()), action: actionId, params },
			undefined,
			a.maxBytes + 64,
		)
		const res = checkActionAnswer(
			m,
			actionId,
			raw,
			read(a.schema),
			Buffer.byteLength(JSON.stringify(raw)),
		)
		if (!res.ok) {
			this.store.audit(id, 'query-refused', undefined, `${res.code} action ${actionId}`)
			throw new ExtensionError(
				res.code,
				'answer',
				`The answer was refused (${res.code}): ${res.message}`,
			)
		}
		return res.result
	}

	/**
	 * What Desktop needs to draw this extension's pages: resolved to the person's language, the files a page
	 * may load (every file under `ui/` and what the manifest names for icons, each with the hash it was
	 * signed with) and the folder they are in. Read from a version verified just now.
	 */
	uiInfo(id: string): UiInfo | null {
		const t0 = this.now()
		try {
			const r = this.buildUiInfo(id)
			this.logCall('ui', id, t0, 'ok')
			return r
		} catch (e) {
			this.logCall('ui', id, t0, 'failed')
			throw e
		}
	}

	private buildUiInfo(id: string): UiInfo | null {
		const { manifest: m, verified } = this.active(id, true)
		if (!m.ui) return null
		const named = new Set(uiFiles(m))
		const files = [...verified.files.entries()]
			.filter(([name]) => name.startsWith('ui/') || named.has(name))
			.map(([path, f]) => ({ path, sha256: sha256Hex(f.bytes) }))
			.sort((a, b) => a.path.localeCompare(b.path))
		const uiHosts =
			m.network.mode === 'declared'
				? m.network.hosts.filter((h) => h.for.includes('ui')).map((h) => h.host)
				: []
		const view = this.uiView(m, this.snapshotOf(id, true))
		return {
			version: m.version,
			dir: this.store.versionDir(id, m.version),
			accent: m.ui.accent,
			icon: m.ui.icon,
			pages: (m.ui.pages ?? []).map((p, i) => ({
				id: p.id,
				title: view.pages[i]?.title ?? p.id,
				slot: p.slot,
				entry: p.entry,
				...(p.minHeight ? { minHeight: p.minHeight } : {}),
				usesNetwork: p.usesNetwork === true,
				bridge: { allow: [...p.bridge.allow], host: [...(p.bridge.host ?? [])] },
				hosts: p.usesNetwork === true ? uiHosts : [],
			})),
			chips: view.chips,
			files,
			methods: [
				...m.contributes.endpoint.queries.map((q) => ({
					method: `query:${q.id}`,
					maxBytes: q.maxBytes,
				})),
				...(m.contributes.endpoint.actions ?? []).map((a) => ({
					method: `action:${a.id}`,
					maxBytes: a.maxBytes,
				})),
			],
			actions: (m.contributes.endpoint.actions ?? []).map((a) => ({
				id: a.id,
				needsGesture: a.needsGesture === true,
			})),
		}
	}

	// --- supervision ---------------------------------------------------------------------------

	private lockPath(id: string): string {
		return join(this.store.runDir(id), 'lock')
	}
	private acquireLock(id: string): boolean {
		mkdirSync(this.store.runDir(id), { recursive: true, mode: 0o700 })
		return acquireOwnedLock(this.lockPath(id), {
			pid: process.pid,
			token: this.tokens.strict(process.pid),
			kind: this.o.kind,
			since: Date.now(),
		})
	}
	private releaseLock(id: string): void {
		try {
			const cur = JSON.parse(readFileSync(this.lockPath(id), 'utf8')) as {
				pid: number
			}
			if (cur.pid === process.pid) rmSync(this.lockPath(id), { force: true })
		} catch {
			// not held
		}
	}

	/** Kill a leftover process of this extension whose executable is inside its folder (Linux: by /proc). */
	private killLeftover(id: string): void {
		const f = join(this.store.runDir(id), 'pid')
		try {
			const pid = Number.parseInt(readFileSync(f, 'utf8'), 10)
			if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
				let exe = ''
				let args: string[] = []
				try {
					exe = readlinkSync(`/proc/${pid}/exe`)
					args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
				} catch {
					// not Linux: nothing proves it is ours, so nothing is killed
				}
				const dir = this.store.dir(id)
				const inside = (p: string): boolean => p === dir || p.startsWith(dir + sep)
				if (inside(exe) || args.some(inside)) {
					try {
						process.kill(-pid, 'SIGKILL')
					} catch {
						process.kill(pid, 'SIGKILL')
					}
					this.store.audit(id, 'stopped', undefined, `leftover pid ${pid} killed`)
				}
			}
			rmSync(f, { force: true })
		} catch {
			// no leftover
		}
	}

	private readonly stateListeners = new Set<(event: StateEvent) => void>()
	/** Hear every change of an extension's state or mark; returns the way to stop. */
	subscribe(listener: (event: StateEvent) => void): () => void {
		this.stateListeners.add(listener)
		return () => this.stateListeners.delete(listener)
	}

	private emit(id: string): void {
		if (!this.o.onState && this.stateListeners.size === 0) return
		try {
			const v = this.view(id)
			const key = `${v.state}|${v.indicator?.label ?? ''}|${JSON.stringify(v.ui?.chips ?? [])}`
			if (this.lastEvent.get(id) === key) return
			this.lastEvent.set(id, key)
			const event: StateEvent = {
				id,
				state: v.state,
				...(v.indicator ? { indicator: v.indicator } : {}),
				...(v.ui?.chips.length ? { chips: v.ui.chips } : {}),
				since: this.now(),
			}
			this.o.onState?.(event)
			for (const l of this.stateListeners) l(event)
		} catch {
			// a broken install has no indicator to show
		}
	}

	private writeRunState(id: string, addr: string, snapshot: Snapshot): void {
		try {
			atomicWrite(
				join(this.store.runDir(id), 'state.json'),
				JSON.stringify({
					hostPid: process.pid,
					token: this.tokens.strict(process.pid),
					addr,
					kind: this.o.kind,
					snapshot,
				}),
				0o600,
			)
		} catch {
			// the readers fall back to "stopped"
		}
	}

	/** Start everything that is enabled and allowed; stop what is no longer allowed. Called at host start and every 30 s. */
	tick(): void {
		for (const id of this.consent.removedIds()) {
			try {
				this.consent.purgeRemoved(id, this.now())
			} catch {
				// best effort
			}
		}
		for (const id of this.store.listIds()) {
			const st = this.store.readState(id)
			if (!st) continue
			this.store.sweepTemp(id)
			try {
				this.consent.purgeRemoved(id, this.now())
			} catch {
				// best effort
			}
			if (!st.enabled) continue
			// An extension whose background switch is on belongs to the runner; every other one to the host
			// that is open. The runner supervises only those, so the two never run the same process.
			const bg = this.wantsBackground(id, st)
			if (this.o.kind === 'daemon') {
				if (!bg) continue
			} else if (bg && this.o.ensureRunner && !this.runnerGivenUp()) {
				this.handToRunner(id)
				continue
			}
			this.supervise(id, st)
		}
		for (const [id, sup] of this.supervisors) {
			const st = this.store.readState(id)
			// Switched off (or, for the runner, no longer covered by the background switch): let go of the
			// process and the lock, so that turning it on again starts a fresh one and the app may take over.
			if (!st?.enabled || (this.o.kind === 'daemon' && !this.wantsBackground(id, st)))
				this.retire(id, sup)
		}
	}

	private readonly stopping = new Set<Promise<void>>()

	/** Stop an extension's process, drop it from the map and free its lock. The stop is tracked. */
	private retire(id: string, sup: Supervisor): void {
		this.supervisors.delete(id)
		const p = sup
			.stop()
			.then(() => this.releaseLock(id))
			.catch(() => {})
			.finally(() => this.stopping.delete(p))
		this.stopping.add(p)
	}

	/** Resolves once every stop begun by a tick has finished and its lock is free. */
	/** Resolves once the start-time probes that a read began have answered (a one-shot command waits, then reads again). */
	async settleProbes(): Promise<void> {
		await this.tokens.settled()
	}

	async settled(): Promise<void> {
		await Promise.all([...this.stopping])
	}

	private runnerPending: Promise<void> | undefined
	/** The one repair of the sign-in entry this host makes before it first starts the runner. */
	private signinRepaired: Promise<void> | undefined
	private runnerFailedAt = Number.NEGATIVE_INFINITY
	/** After the runner could not be reached, this host runs such extensions itself for ten minutes. */
	private runnerGivenUp(): boolean {
		return this.now() - this.runnerFailedAt < 10 * 60_000
	}

	private handToRunner(id: string): void {
		const sup = this.supervisors.get(id)
		if (sup) {
			this.supervisors.delete(id)
			this.store.audit(id, 'handover', undefined, 'to the runner')
			void sup.stop().then(() => {
				this.releaseLock(id)
				void this.o.notifyRunner?.()
			})
		}
		const ensure = this.o.ensureRunner
		if (this.runnerPending || !ensure) return
		const fail = (): void => {
			this.runnerFailedAt = this.now()
			this.tick()
		}
		// On Windows the sign-in entry is what starts the runner, and an entry an earlier version made can
		// still run a console file, whose window would stay open as long as the runner runs. So the entry
		// is repaired once, before this host first asks it to start anything.
		this.signinRepaired ??= this.reconcile()
		this.runnerPending = this.signinRepaired
			.then(() => ensure())
			.then((ok) => {
				if (!ok) fail()
			}, fail)
		void this.runnerPending.finally(() => {
			this.runnerPending = undefined
		})
	}

	/** The extensions this host would hand to a runner: enabled, switch on, scope acknowledged. */
	backgroundIds(): string[] {
		return this.store.listIds().filter((id) => {
			const st = this.store.readState(id)
			return st ? this.wantsBackground(id, st) : false
		})
	}

	private supervise(id: string, st: ExtensionState): void {
		let loaded: Loaded
		try {
			// A process about to start is verified afresh: signature and every file's hash.
			loaded = this.active(id, !this.supervisors.has(id))
		} catch (e) {
			// tampered or unreadable: never start, say why
			if (st.failed === undefined) {
				this.store.writeState({ ...st, failed: 'tampered' })
				this.store.audit(
					id,
					'failed',
					st.activeVersion ?? undefined,
					`tampered: ${(e as Error).message}`,
				)
			}
			const sup = this.supervisors.get(id)
			if (sup) void sup.stop()
			this.emit(id)
			return
		}
		const m = loaded.manifest
		this.saveSeen(id)
		const existing = this.supervisors.get(id)
		if (licenceRequired(m)) {
			const lic = this.licenseStatus(id)
			if (lic.state === 'absent' || !lic.ok) {
				if (existing) {
					this.supervisors.delete(id)
					this.store.audit(
						id,
						'license-expired',
						undefined,
						lic.state === 'checked' && !lic.ok ? lic.code : 'absent',
					)
					void existing.stop().then(async () => {
						this.releaseLock(id)
						await this.maintenance(id, 'onLicenseExpired')
						this.emit(id)
					})
				}
				this.emit(id)
				return
			}
		}
		this.refreshDue(id, m)
		if (!this.coverageOf(id, m).covered) {
			this.emit(id)
			return
		}
		if (existing) {
			// Another process of this person swapped in a new version: this owner restarts on it.
			if (existing.version !== loaded.manifest.version) {
				this.supervisors.delete(id)
				void existing.stop().then(() => {
					this.releaseLock(id)
					this.tick()
				})
				return
			}
			this.emit(id)
			return
		}
		if (st.failed) return
		if (!this.acquireLock(id)) return
		this.killLeftover(id)
		mkdirSync(this.store.dataDir(id), { recursive: true, mode: 0o700 })
		void this.maintenance(id, 'hostStart')
		const addr = queryAddress(this.platform, id, this.store.runDir(id), this.userHash())
		const sup = new Supervisor({
			manifest: m,
			granted: () => Object.keys(this.consent.read(id)?.grants ?? {}),
			audit: (event, detail) => this.store.audit(id, event, m.version, detail),
			spawn: () => {
				const cmd = m.entry.process.command[this.platformKey]
				if (!cmd) throw new Error(`no command for ${this.platformKey}`)
				const base = this.store.versionDir(id, m.version)
				const env = cleanEnv({
					manifest: m,
					platform: this.platform,
					hostEnv: this.env,
					extensionDir: base,
					dataDir: this.store.dataDir(id),
					runDir: this.store.runDir(id),
					consentPath: this.store.file(id, 'consent.json'),
					licensePath: this.licensePathFor(id, m),
					granted: Object.keys(this.consent.read(id)?.grants ?? {}),
					queryAddr: addr,
					locale: resolveLocale(m, this.locale).locale,
				})
				const spec: SpawnSpec = {
					exe: join(base, cmd.exe),
					args: cmd.args ?? [],
					cwd: base,
					env,
					stderrLog: join(this.store.runDir(id), 'stderr.log'),
				}
				const child = (this.o.spawn ?? spawnChild)(spec)
				if (child.pid !== undefined)
					writeFileSync(join(this.store.runDir(id), 'pid'), String(child.pid), {
						mode: 0o600,
					})
				return child
			},
			// A real process opens its socket after it reports; test doubles that replace the spawn have none.
			...(this.o.spawn ? {} : { endpointReady: () => waitForEndpoint(addr) }),
			requireIndicator: this.o.kind === 'daemon' && m.background?.indicator.kind === 'tray',
			onChange: (snap) => {
				this.writeRunState(id, addr, snap)
				if (snap.state === 'failed') {
					const cur = this.store.readState(id)
					if (cur)
						this.store.writeState({
							...cur,
							failed: snap.failedReason ?? 'failed',
						})
				}
				this.emit(id)
			},
		})
		this.supervisors.set(id, sup)
		this.store.audit(id, 'host-start', m.version, this.o.kind)
		sup.start()
	}

	/** The person pressed Start again after `failed`. */
	startAgain(id: string): ExtensionView {
		const st = this.state(id)
		this.store.writeState({ ...st, failed: undefined })
		const sup = this.supervisors.get(id)
		if (sup) sup.startAgain()
		else this.tick()
		return this.view(id)
	}

	/** Begin supervising and keep checking; `stopSupervision` ends it and stops every process this host runs. */
	startSupervision(everyMs = 30_000): void {
		this.tick()
		this.timer = setInterval(() => this.tick(), everyMs)
		this.timer.unref?.()
		// If the host exits without a clean stop (a signal, a crash handler, `process.exit`), no hidden
		// process outlives it: what is running is killed on the way out. Its own stdin closing is the
		// belt, this is the braces.
		if (!this.exitHook) {
			this.exitHook = () => this.emergencyStop()
			process.once('exit', this.exitHook)
		}
	}

	private exitHook: (() => void) | undefined

	/** Kill every process this host runs, at once and without waiting. */
	emergencyStop(): void {
		for (const [id, sup] of this.supervisors) {
			sup.killNow()
			this.releaseLock(id)
		}
		this.supervisors.clear()
	}

	async stopSupervision(): Promise<void> {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
		if (this.exitHook) {
			process.off('exit', this.exitHook)
			this.exitHook = undefined
		}
		const all = [...this.supervisors.entries()]
		this.supervisors.clear()
		await Promise.all(
			all.map(async ([id, sup]) => {
				await sup.stop()
				this.releaseLock(id)
				this.store.audit(id, 'host-stop')
			}),
		)
	}

	/** The one-shot command that may only delete expired rows, run while the process is not running. */
	async maintenance(
		id: string,
		when: 'hostStart' | 'daily' | 'onDisable' | 'onLicenseExpired',
	): Promise<void> {
		let loaded: Loaded
		try {
			loaded = this.active(id)
		} catch {
			return
		}
		const mt = loaded.manifest.entry.maintenance
		const cmd = mt?.command[this.platformKey]
		if (!mt || !cmd || !mt.runWhen.includes(when)) return
		if (this.supervisors.get(id)?.snapshot().state === 'collecting') return
		const base = this.store.versionDir(id, loaded.manifest.version)
		const env = cleanEnv({
			manifest: loaded.manifest,
			platform: this.platform,
			hostEnv: this.env,
			extensionDir: base,
			dataDir: this.store.dataDir(id),
			runDir: this.store.runDir(id),
			consentPath: this.store.file(id, 'consent.json'),
			licensePath: this.licensePathFor(id, loaded.manifest),
			granted: [],
			queryAddr: '',
			locale: resolveLocale(loaded.manifest, this.locale).locale,
		})
		let child: ChildLike
		try {
			child = (this.o.spawn ?? spawnChild)({
				exe: join(base, cmd.exe),
				args: cmd.args ?? [],
				cwd: base,
				env,
			})
		} catch {
			return
		}
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				child.kill(true)
				resolve()
			}, mt.timeoutMs ?? 30_000)
			child.onExit(() => {
				clearTimeout(t)
				resolve()
			})
		})
		this.store.audit(id, 'maintenance', undefined, when)
	}

	/** Hash proof used by tests and `validate`: the same package bytes give the same digest. */
	static digest(bytes: Uint8Array): string {
		return createHash('sha256').update(bytes).digest('hex')
	}

	readInstalledSize(id: string): number {
		try {
			return statSync(this.store.dataDir(id)).size
		} catch {
			return 0
		}
	}

	exists(id: string): boolean {
		return existsSync(this.store.file(id, 'state.json'))
	}
}

function cmpVersion(a: string, b: string): number {
	const x = a.split('.').map(Number)
	const y = b.split('.').map(Number)
	for (let i = 0; i < 3; i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0)
		if (d !== 0) return d
	}
	return 0
}
