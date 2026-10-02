import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { DiskRevisionRecordStore } from '../../store/kv/revision-record-store.js'
import { defineSchema } from '../../store/schema.js'
import {
	observationRouteKeySchema,
	observationSourceSchema,
} from '../communication/ingress-schema.js'
import type { PalIngressAuthorizationRequest } from '../communication/ingress-types.js'
import { addressSchema, freezeCommunicationValue } from '../communication/schema.js'
import type { PalMessageAuthorization } from '../communication/types.js'
import { subscriptionSchema } from './subscription-schema.js'
import type {
	PalActivitySubscriptionAuthorizationRequest,
	PalActivitySubscriptionStore,
} from './subscription-types.js'

export interface PalActivitySubscriptionPermission {
	readonly v: 1
	readonly subscriptionId: string
	readonly revision: number
	readonly observe: boolean
	readonly disclose: boolean
	readonly receive: boolean
	readonly wake: boolean
}
export interface PalActivitySubscriptionPermissionUpdate
	extends Omit<PalActivitySubscriptionPermission, 'v' | 'revision'> {
	readonly expectedRevision: number
}
export class PalActivitySubscriptionPermissionConflictError extends Error {
	override readonly name = 'PalActivitySubscriptionPermissionConflictError'
}
const permissionSchema = z
	.object({
		v: z.literal(1),
		subscriptionId: z.string().uuid(),
		revision: z.number().int().positive().safe(),
		observe: z.boolean(),
		disclose: z.boolean(),
		receive: z.boolean(),
		wake: z.boolean(),
	})
	.strict()
const updateSchema = permissionSchema
	.omit({ v: true, revision: true })
	.extend({ expectedRevision: z.number().int().nonnegative().safe() })
const denied = (): PalMessageAuthorization => ({
	allow: false,
	reason: 'No current permission for this exact Pal activity subscription.',
})

/** Explicit local operator consent. Missing rules deny and each phase rereads current records. */
export class DiskPalActivitySubscriptionPolicy {
	private readonly root: string
	private readonly secure: (path: string) => void
	private readonly subscriptions: PalActivitySubscriptionStore
	private readonly records = new DiskRevisionRecordStore<PalActivitySubscriptionPermission>(
		defineSchema({
			kind: 'pal-activity-subscription-permission',
			current: 1,
			migrations: {},
		}),
		'Pal activity subscription permission',
		(value) => value.revision,
	)
	constructor(options: {
		root: string
		subscriptions: PalActivitySubscriptionStore
		secureDirectory?: (path: string) => void
	}) {
		this.root = resolve(options.root)
		this.subscriptions = options.subscriptions
		this.secure =
			options.secureDirectory ??
			((path) => {
				if (process.platform !== 'win32') chmodSync(path, 0o700)
			})
		this.directory(this.root)
	}
	private directory(path: string) {
		mkdirSync(path, { recursive: true, mode: 0o700 })
		const stat = lstatSync(path)
		if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
			throw new Error('Pal activity permissions require real directories without aliases.')
		this.secure(path)
	}
	private location(id: string) {
		const key = z.string().uuid().parse(id)
		this.directory(this.root)
		const directory = join(this.root, key)
		this.directory(directory)
		const revisionsDir = join(directory, 'revisions')
		this.directory(revisionsDir)
		for (const name of readdirSync(revisionsDir)) {
			if (!/^[1-9][0-9]*\.json$/u.test(name)) continue
			const stat = lstatSync(join(revisionsDir, name))
			if (!stat.isFile() || stat.isSymbolicLink())
				throw new Error('Pal permission commits must be real files.')
		}
		return {
			legacyPath: join(directory, 'permission.json'),
			revisionsDir,
			publishLegacyProjection: false,
		}
	}
	private checked(input: unknown, id: string) {
		const { schemaVersion: _schemaVersion, ...value } = permissionSchema
			.extend({ schemaVersion: z.literal(1).optional() })
			.parse(input)
		if (value.subscriptionId !== id) throw new Error('Foreign Pal subscription permission.')
		return freezeCommunicationValue(value)
	}
	async get(id: string): Promise<PalActivitySubscriptionPermission | null> {
		const record = await this.records.read(this.location(id))
		return record === null ? null : this.checked(record, id)
	}
	async update(
		input: PalActivitySubscriptionPermissionUpdate,
	): Promise<PalActivitySubscriptionPermission> {
		const captured = updateSchema.parse(input)
		if (!(await this.subscriptions.get(captured.subscriptionId)))
			throw new Error('Unknown Pal activity subscription.')
		return this.records.transact(this.location(captured.subscriptionId), (stored) => {
			const current = stored === null ? null : this.checked(stored, captured.subscriptionId)
			if ((current?.revision ?? 0) !== captured.expectedRevision)
				throw new PalActivitySubscriptionPermissionConflictError(
					'Subscription permission changed; reload before updating.',
				)
			const { expectedRevision, ...values } = captured
			const record = this.checked(
				{ ...values, v: 1, revision: expectedRevision + 1 },
				values.subscriptionId,
			)
			return { record, result: record }
		})
	}
	async authorizeSubscription(
		request: PalActivitySubscriptionAuthorizationRequest,
	): Promise<PalMessageAuthorization> {
		const phase = z.enum(['observe', 'disclose', 'receive', 'accept']).parse(request.phase)
		const permitted = (rule: PalActivitySubscriptionPermission | null) =>
			phase === 'accept' ? rule?.observe && rule.disclose && rule.receive : rule?.[phase]
		const captured = freezeCommunicationValue(subscriptionSchema.parse(request.subscription))
		const stored = await this.subscriptions.get(captured.id)
		const subscription = stored ? freezeCommunicationValue(subscriptionSchema.parse(stored)) : null
		if (
			!subscription?.enabled ||
			subscription.configurationRevision !== captured.configurationRevision ||
			!isDeepStrictEqual(subscription.scope, captured.scope) ||
			!isDeepStrictEqual(subscription.recipient, captured.recipient)
		)
			return denied()
		const observed = await this.get(subscription.id)
		if (!permitted(observed)) return denied()
		const current = await this.subscriptions.get(subscription.id)
		if (
			!current?.enabled ||
			current.configurationRevision !== captured.configurationRevision ||
			!isDeepStrictEqual(current.scope, captured.scope) ||
			!isDeepStrictEqual(current.recipient, captured.recipient)
		)
			return denied()
		const rule = await this.get(subscription.id)
		if (!rule || !permitted(rule)) return denied()
		return {
			allow: true,
			grant: {
				id: `pal-subscription:${subscription.id}:${phase}`,
				revision: String(rule.revision),
			},
		}
	}
	async authorizeIngress(input: PalIngressAuthorizationRequest): Promise<PalMessageAuthorization> {
		if (!('kind' in input) || input.kind !== 'observation') return denied()
		const request = freezeCommunicationValue(
			z
				.object({
					kind: z.literal('observation'),
					phase: z.enum(['accept', 'deliver', 'wake']),
					source: observationSourceSchema,
					routeKey: observationRouteKeySchema,
					recipient: addressSchema,
				})
				.parse(input),
		)
		const id = z.string().uuid().parse(request.source.subscriptionId)
		const phase = z.enum(['accept', 'deliver', 'wake']).parse(request.phase)
		const stored = await this.subscriptions.get(id)
		const subscription = stored ? freezeCommunicationValue(subscriptionSchema.parse(stored)) : null
		if (
			!subscription?.enabled ||
			request.routeKey.kind !== 'observation' ||
			request.routeKey.subscriptionId !== id ||
			!isDeepStrictEqual(request.source.scope, subscription.scope) ||
			!isDeepStrictEqual(request.routeKey.scope, subscription.scope) ||
			!isDeepStrictEqual(request.recipient, subscription.recipient) ||
			!isDeepStrictEqual(request.routeKey.recipient, subscription.recipient)
		)
			return denied()
		const observed = await this.get(id)
		if (
			!observed?.observe ||
			!observed.disclose ||
			!observed.receive ||
			(phase === 'wake' && !observed.wake)
		)
			return denied()
		const current = await this.subscriptions.get(id)
		if (
			!current?.enabled ||
			current.configurationRevision !== subscription.configurationRevision ||
			!isDeepStrictEqual(current.scope, subscription.scope) ||
			!isDeepStrictEqual(current.recipient, subscription.recipient)
		)
			return denied()
		const rule = await this.get(id)
		if (!rule?.observe || !rule.disclose || !rule.receive || (phase === 'wake' && !rule.wake))
			return denied()
		return {
			allow: true,
			grant: {
				id: `pal-subscription:${id}:${phase}`,
				revision: String(rule.revision),
			},
		}
	}
}
