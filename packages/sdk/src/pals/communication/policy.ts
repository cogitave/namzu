import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { DiskRevisionRecordStore } from '../../store/kv/revision-record-store.js'
import { defineSchema } from '../../store/schema.js'
import { addressSchema, addressTuple, hash } from './schema.js'
import {
	type PalAddress,
	type PalAuthorizationRequest,
	type PalMessageAuthorization,
	sameAddress,
} from './types.js'

/** Operator-controlled directed consent. Wake is separately opt-in. */
export interface PalMessagePermission {
	readonly v: 1
	readonly source: PalAddress
	readonly recipient: PalAddress
	readonly revision: number
	readonly enabled: boolean
	readonly allowWake: boolean
}

export interface PalMessagePermissionUpdate {
	readonly source: PalAddress
	readonly recipient: PalAddress
	/** Zero creates a new rule. Existing rules require their actual revision. */
	readonly expectedRevision: number
	readonly enabled: boolean
	readonly allowWake: boolean
}

export class PalMessagePermissionConflictError extends Error {
	override readonly name = 'PalMessagePermissionConflictError'
}

const permissionSchema = z.object({
	v: z.literal(1),
	source: addressSchema,
	recipient: addressSchema,
	revision: z.number().int().positive().safe(),
	enabled: z.boolean(),
	allowWake: z.boolean(),
})

function key(source: PalAddress, recipient: PalAddress): string {
	return hash([addressTuple(source), addressTuple(recipient)])
}

function checked(
	input: unknown,
	source?: PalAddress,
	recipient?: PalAddress,
): PalMessagePermission {
	const value = permissionSchema.parse(input)
	if (
		value.source.tenantId !== value.recipient.tenantId ||
		(source && !sameAddress(source, value.source)) ||
		(recipient && !sameAddress(recipient, value.recipient))
	)
		throw new Error('Foreign Pal communication permission.')
	Object.freeze(value.source)
	Object.freeze(value.recipient)
	return Object.freeze(value)
}

/**
 * Optional local operator policy. Missing and revoked rules deny; a stored grant
 * reference is evidence only. Every authorization reads the current revision.
 */
export class DiskPalMessagePolicy {
	private readonly root: string
	private readonly secure: (path: string) => void
	private readonly records = new DiskRevisionRecordStore<PalMessagePermission>(
		defineSchema({ kind: 'pal-message-permission', current: 1, migrations: {} }),
		'Pal message permission',
		(value) => value.revision,
	)
	constructor(options: { root: string; secureDirectory?: (path: string) => void }) {
		this.root = resolve(options.root)
		this.secure =
			options.secureDirectory ??
			((path) => {
				if (process.platform !== 'win32') chmodSync(path, 0o700)
			})
		this.directory(this.root)
	}
	private directory(path: string): void {
		mkdirSync(path, { recursive: true, mode: 0o700 })
		const entry = lstatSync(path)
		if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path)
			throw new Error('Pal communication policy requires real directories without aliases.')
		this.secure(path)
	}
	private location(source: PalAddress, recipient: PalAddress) {
		addressSchema.parse(source)
		addressSchema.parse(recipient)
		if (source.tenantId !== recipient.tenantId)
			throw new Error('Cross-tenant Pal grants are refused.')
		this.directory(this.root)
		const directory = join(this.root, key(source, recipient))
		this.directory(directory)
		const revisionsDir = join(directory, 'revisions')
		this.directory(revisionsDir)
		return { legacyPath: join(directory, 'permission.json'), revisionsDir }
	}
	async get(source: PalAddress, recipient: PalAddress): Promise<PalMessagePermission | null> {
		const capturedSource = addressSchema.parse(source)
		const capturedRecipient = addressSchema.parse(recipient)
		const value = await this.records.read(this.location(capturedSource, capturedRecipient))
		return value ? checked(value, capturedSource, capturedRecipient) : null
	}
	async update(input: PalMessagePermissionUpdate): Promise<PalMessagePermission> {
		// Capture all caller data before the first asynchronous storage boundary.
		const source = addressSchema.parse(input.source)
		const recipient = addressSchema.parse(input.recipient)
		const { expectedRevision, enabled, allowWake } = input
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new Error('A nonnegative expected permission revision is required.')
		if (typeof enabled !== 'boolean' || typeof allowWake !== 'boolean')
			throw new Error('Explicit Pal communication and wake consent are required.')
		return this.records.transact(this.location(source, recipient), (stored) => {
			const current = stored ? checked(stored, source, recipient) : null
			if ((current?.revision ?? 0) !== expectedRevision)
				throw new PalMessagePermissionConflictError(
					'Pal communication permission changed; reload it.',
				)
			const record = checked({
				v: 1,
				source,
				recipient,
				revision: expectedRevision + 1,
				enabled,
				allowWake,
			})
			return { record, result: record }
		})
	}
	async outgoing(source: PalAddress): Promise<readonly PalMessagePermission[]> {
		const captured = addressSchema.parse(source)
		this.directory(this.root)
		const rules: PalMessagePermission[] = []
		for (const name of readdirSync(this.root)) {
			if (!/^[a-f0-9]{64}$/.test(name)) continue
			const directory = join(this.root, name)
			this.directory(directory)
			this.directory(join(directory, 'revisions'))
			const stored = await this.records.read({
				legacyPath: join(directory, 'permission.json'),
				revisionsDir: join(directory, 'revisions'),
			})
			if (!stored) continue
			const rule = checked(stored)
			if (name !== key(rule.source, rule.recipient))
				throw new Error('Pal permission path identity changed.')
			if (rule.enabled && sameAddress(rule.source, captured)) rules.push(rule)
		}
		return Object.freeze(rules)
	}
	async authorize(request: PalAuthorizationRequest): Promise<PalMessageAuthorization> {
		const phase = request.phase
		if (!['send', 'deliver', 'wake'].includes(phase))
			throw new Error('Invalid Pal authorization phase.')
		const rule = await this.get(request.source.address, request.recipient)
		if (!rule?.enabled)
			return { allow: false, reason: 'No current directed Pal communication permission.' }
		if (phase === 'wake' && !rule.allowWake)
			return { allow: false, reason: 'This Pal communication permission does not allow wakeup.' }
		return {
			allow: true,
			grant: { id: key(rule.source, rule.recipient), revision: String(rule.revision) },
		}
	}
}
