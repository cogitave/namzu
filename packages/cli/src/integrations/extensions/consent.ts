import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { type Scope, scopeHash, widerReasons } from './scope.js'
import { type ExtensionStore, atomicWrite } from './store.js'

/**
 * The consent record: once per person (OS user) per extension, with the notice version, the scope hash
 * and the wording digest. It covers a version when the scope is the same or narrower and the notice
 * version is the same, so restarts, reboots, disable-then-enable and same-scope updates never ask.
 */

export interface ConsentRecord {
	schema: 1
	extensionId: string
	person: { osUserHash: string }
	acknowledgedAt: string
	noticeVersion: string
	noticeLocale: string
	noticeSha256: string
	scopeHash: string
	scope: Scope
	wordingDigest: string
	firstVersion: string
	versionAtAcknowledgement: string
	via: 'cli' | 'desktop'
	/** What the sign-in switch showed and what the person chose, when the extension declares background running. */
	background?: { offeredDefault: boolean; chosen: boolean; at: string }
	hostVersion: string
	grants: Record<string, { grantedAt: string; purposeIds: string[] }>
	previous: { acknowledgedAt: string; noticeVersion: string; scopeHash: string }[]
	/** Set only on a record kept after a remove: how long the evidence is kept. */
	retainDays?: number
	/** Set only on a record kept after a remove: when it was removed; the kept period runs from here. */
	removedAt?: string
}

export function osUserHash(installId: string, env: { uid?: string } = {}): string {
	const who =
		env.uid ??
		(typeof process.getuid === 'function' ? String(process.getuid()) : userInfo().username)
	return createHash('sha256').update(`${installId}:${who}`).digest('hex')
}

export type Coverage = { covered: true; exact: boolean } | { covered: false; reasons: string[] }

export function coverage(
	record: ConsentRecord | undefined,
	extensionId: string,
	userHash: string,
	scope: Scope,
): Coverage {
	if (!record) return { covered: false, reasons: ['nothing has been acknowledged yet'] }
	if (record.extensionId !== extensionId)
		return { covered: false, reasons: ['the record is for another extension'] }
	if (record.person.osUserHash !== userHash)
		return { covered: false, reasons: ['the record is from another person or another computer'] }
	if (record.scopeHash === scopeHash(scope)) return { covered: true, exact: true }
	const wider = widerReasons(record.scope, scope)
	return wider.length === 0 ? { covered: true, exact: false } : { covered: false, reasons: wider }
}

export class ConsentStore {
	constructor(private readonly store: ExtensionStore) {}

	read(id: string): ConsentRecord | undefined {
		return this.store.readJson<ConsentRecord>(id, 'consent.json')
	}
	/** A record kept after a remove (for `retainDays`), if it is still there. */
	readRemoved(id: string): ConsentRecord | undefined {
		try {
			return JSON.parse(readFileSync(this.store.removedRecord(id), 'utf8')) as ConsentRecord
		} catch {
			return undefined
		}
	}
	write(record: ConsentRecord): void {
		this.store.writeJson(record.extensionId, 'consent.json', record)
	}
	/** Replace the record by a narrower scope, keeping who acknowledged and when; the old one goes to `previous`. */
	narrow(record: ConsentRecord, scope: Scope, version: string): ConsentRecord {
		const next: ConsentRecord = {
			...record,
			scope,
			scopeHash: scopeHash(scope),
			versionAtAcknowledgement: version,
			previous: [
				{
					acknowledgedAt: record.acknowledgedAt,
					noticeVersion: record.noticeVersion,
					scopeHash: record.scopeHash,
				},
				...record.previous,
			].slice(0, 20),
		}
		this.write(next)
		return next
	}
	archive(id: string, retainDays: number, now: number): void {
		const from = this.store.file(id, 'consent.json')
		const record = this.read(id)
		if (!record) return
		const to = this.store.removedRecord(id)
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
		atomicWrite(
			to,
			`${JSON.stringify({ ...record, retainDays, removedAt: new Date(now).toISOString() }, null, 2)}\n`,
		)
		rmSync(from, { force: true })
	}
	/** Ids that have a record kept after a remove. */
	removedIds(): string[] {
		try {
			return readdirSync(join(this.store.root, '_removed'))
				.filter((n) => n.endsWith('.consent.json'))
				.map((n) => n.slice(0, -'.consent.json'.length))
		} catch {
			return []
		}
	}
	/** After `retainDays` the kept record is deleted; called at host start. */
	purgeRemoved(id: string, now: number): void {
		const r = this.readRemoved(id)
		if (!r) return
		const kept = Date.parse(r.removedAt ?? r.acknowledgedAt) + (r.retainDays ?? 0) * 86_400_000
		if (Number.isNaN(kept) || now > kept) rmSync(this.store.removedRecord(id), { force: true })
	}
	restore(id: string): ConsentRecord | undefined {
		const r = this.readRemoved(id)
		if (!r) return undefined
		const { retainDays: _drop, removedAt: _gone, ...rest } = r
		atomicWrite(this.store.file(id, 'consent.json'), `${JSON.stringify(rest, null, 2)}\n`)
		rmSync(this.store.removedRecord(id), { force: true })
		return rest as ConsentRecord
	}
}
