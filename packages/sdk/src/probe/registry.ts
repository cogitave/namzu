import type {
	ProbeContext,
	ProbeEvent,
	ProbeEventKind,
	ProbeEventOf,
	ProbeHandler,
	ProbeOptions,
	Unsubscribe,
	VetoDecision,
	VetoHandler,
	VetoOutcome,
	VetoableEventKind,
} from '../types/probe/index.js'
import type { Logger } from '../utils/logger.js'

import { ProbeNameCollisionError } from './errors.js'

interface ProbeEntry {
	readonly id: number
	readonly name?: string
	readonly priority: number
	readonly handler: (event: ProbeEvent, ctx: ProbeContext) => void
	readonly where?: (event: ProbeEvent) => boolean
}

interface VetoEntry {
	readonly id: number
	readonly name?: string
	readonly priority: number
	readonly handler: (event: ProbeEvent, ctx: ProbeContext) => VetoDecision
	readonly where?: (event: ProbeEvent) => boolean
}

function compareVeto(a: VetoEntry, b: VetoEntry): number {
	if (a.priority !== b.priority) return a.priority - b.priority
	return a.id - b.id
}

function insertSortedVeto(list: VetoEntry[], entry: VetoEntry): void {
	let lo = 0
	let hi = list.length
	while (lo < hi) {
		const mid = (lo + hi) >>> 1
		if (compareVeto(list[mid] as VetoEntry, entry) <= 0) lo = mid + 1
		else hi = mid
	}
	list.splice(lo, 0, entry)
}

function removeVeto(list: VetoEntry[], entry: VetoEntry): void {
	const idx = list.indexOf(entry)
	if (idx >= 0) list.splice(idx, 1)
}

function normalizeDecision(decision: VetoDecision): { allow: boolean; reason?: string } {
	if (decision === 'allow') return { allow: true }
	if (decision === 'deny') return { allow: false }
	return { allow: false, reason: decision.reason }
}

function compareEntries(a: ProbeEntry, b: ProbeEntry): number {
	if (a.priority !== b.priority) return a.priority - b.priority
	return a.id - b.id
}

function insertSorted(list: ProbeEntry[], entry: ProbeEntry): void {
	let lo = 0
	let hi = list.length
	while (lo < hi) {
		const mid = (lo + hi) >>> 1
		if (compareEntries(list[mid] as ProbeEntry, entry) <= 0) lo = mid + 1
		else hi = mid
	}
	list.splice(lo, 0, entry)
}

function removeEntry(list: ProbeEntry[], entry: ProbeEntry): void {
	const idx = list.indexOf(entry)
	if (idx >= 0) list.splice(idx, 1)
}

export class ProbeRegistry {
	private readonly typedByKind: Map<ProbeEventKind, ProbeEntry[]> = new Map()
	private readonly vetoByKind: Map<VetoableEventKind, VetoEntry[]> = new Map()
	private readonly catchAll: ProbeEntry[] = []
	private readonly byName: Map<string, ProbeEntry | VetoEntry> = new Map()
	private nextId = 1
	private log?: Logger

	setLogger(log: Logger): void {
		this.log = log.child({ component: 'ProbeRegistry' })
	}

	on<K extends ProbeEventKind>(
		kind: K | readonly K[],
		handler: ProbeHandler<K>,
		opts: ProbeOptions<K> = {},
	): Unsubscribe {
		const kinds: readonly K[] = Array.isArray(kind) ? kind : [kind as K]
		const entry = this.makeEntry(
			handler as (e: ProbeEvent, c: ProbeContext) => void,
			opts as unknown as ProbeOptions,
		)

		for (const k of kinds) {
			let bucket = this.typedByKind.get(k)
			if (!bucket) {
				bucket = []
				this.typedByKind.set(k, bucket)
			}
			insertSorted(bucket, entry)
		}

		return () => {
			for (const k of kinds) {
				const bucket = this.typedByKind.get(k)
				if (bucket) removeEntry(bucket, entry)
			}
			if (entry.name) this.byName.delete(entry.name)
		}
	}

	onAny(
		handler: (event: ProbeEvent, ctx: ProbeContext) => void,
		opts: ProbeOptions = {},
	): Unsubscribe {
		const entry = this.makeEntry(handler, opts)
		insertSorted(this.catchAll, entry)
		return () => {
			removeEntry(this.catchAll, entry)
			if (entry.name) this.byName.delete(entry.name)
		}
	}

	dispatch(event: ProbeEvent, ctx: ProbeContext, betweenTier?: () => void): void {
		const frozen = Object.isFrozen(event) ? event : Object.freeze(event)
		this.runTier(this.typedByKind.get(frozen.type) ?? [], frozen, ctx)
		if (betweenTier) {
			try {
				betweenTier()
			} catch (error) {
				this.logThrow('between-tier', frozen.type, error)
			}
		}
		this.runTier(this.catchAll, frozen, ctx)
	}

	veto<K extends VetoableEventKind>(
		kind: K,
		handler: VetoHandler<K>,
		opts: ProbeOptions<K> = {},
	): Unsubscribe {
		if (opts.name !== undefined) {
			const existing = this.byName.get(opts.name)
			if (existing && !opts.override) {
				throw new ProbeNameCollisionError(opts.name)
			}
			if (existing && opts.override) this.removeAnywhere(existing)
		}

		const entry: VetoEntry = {
			id: this.nextId++,
			name: opts.name,
			priority: opts.priority ?? 0,
			handler: handler as (e: ProbeEvent, c: ProbeContext) => VetoDecision,
			where: opts.where as ((event: ProbeEvent) => boolean) | undefined,
		}

		let bucket = this.vetoByKind.get(kind)
		if (!bucket) {
			bucket = []
			this.vetoByKind.set(kind, bucket)
		}
		insertSortedVeto(bucket, entry)
		if (entry.name) this.byName.set(entry.name, entry)

		return () => {
			const list = this.vetoByKind.get(kind)
			if (list) removeVeto(list, entry)
			if (entry.name) this.byName.delete(entry.name)
		}
	}

	queryVeto<K extends VetoableEventKind>(event: ProbeEventOf<K>, ctx: ProbeContext): VetoOutcome {
		const wide = event as unknown as ProbeEvent
		const frozen = Object.isFrozen(wide) ? wide : Object.freeze(wide)
		const bucket = this.vetoByKind.get(frozen.type as VetoableEventKind)
		if (!bucket || bucket.length === 0) return { action: 'allow' }

		let firstDeny: VetoOutcome | undefined
		for (const entry of bucket) {
			if (entry.where && !entry.where(frozen)) continue
			let decision: VetoDecision
			try {
				decision = entry.handler(frozen, ctx)
			} catch (error) {
				this.logThrow(entry.name ?? 'unnamed', frozen.type, error)
				continue
			}
			const normalized = normalizeDecision(decision)
			if (!normalized.allow && firstDeny === undefined) {
				firstDeny = {
					action: 'deny',
					probeName: entry.name,
					reason: normalized.reason,
				}
			}
		}

		return firstDeny ?? { action: 'allow' }
	}

	clear(): void {
		this.typedByKind.clear()
		this.vetoByKind.clear()
		this.catchAll.length = 0
		this.byName.clear()
	}

	private runTier(entries: readonly ProbeEntry[], event: ProbeEvent, ctx: ProbeContext): void {
		for (const entry of entries) {
			if (entry.where && !entry.where(event)) continue
			try {
				entry.handler(event, ctx)
			} catch (error) {
				this.logThrow(entry.name ?? 'unnamed', event.type, error)
			}
		}
	}

	private makeEntry(
		handler: (event: ProbeEvent, ctx: ProbeContext) => void,
		opts: ProbeOptions,
	): ProbeEntry {
		if (opts.name !== undefined) {
			const existing = this.byName.get(opts.name)
			if (existing && !opts.override) {
				throw new ProbeNameCollisionError(opts.name)
			}
			if (existing && opts.override) this.removeAnywhere(existing)
		}

		const entry: ProbeEntry = {
			id: this.nextId++,
			name: opts.name,
			priority: opts.priority ?? 0,
			handler,
			where: opts.where as ((event: ProbeEvent) => boolean) | undefined,
		}

		if (entry.name) this.byName.set(entry.name, entry)
		return entry
	}

	private removeAnywhere(entry: ProbeEntry | VetoEntry): void {
		for (const bucket of this.typedByKind.values()) removeEntry(bucket, entry as ProbeEntry)
		removeEntry(this.catchAll, entry as ProbeEntry)
		for (const bucket of this.vetoByKind.values()) removeVeto(bucket, entry as VetoEntry)
		if (entry.name) this.byName.delete(entry.name)
	}

	private logThrow(probeName: string, eventType: string, error: unknown): void {
		if (!this.log) return
		this.log.error('probe handler threw', {
			probeName,
			eventType,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export const probe: ProbeRegistry = new ProbeRegistry()

export function createProbeRegistry(): ProbeRegistry {
	return new ProbeRegistry()
}
