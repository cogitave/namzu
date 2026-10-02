import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { DiskRevisionRecordStore } from '../../store/kv/revision-record-store.js'
import { defineSchema } from '../../store/schema.js'
import { freezeCommunicationValue } from '../communication/schema.js'
import {
	storedSubscriptionSchema,
	subscriptionCursorSchema,
	subscriptionSchema,
} from './subscription-schema.js'
import type { PalActivitySubscription, PalActivitySubscriptionStore } from './subscription-types.js'
import type { PalActivityCursor } from './types.js'

export class PalActivitySubscriptionConflictError extends Error {
	override readonly name = 'PalActivitySubscriptionConflictError'
}

/** Private immutable revision commits. No cursors are accepted from a client or model. */
export class DiskPalActivitySubscriptionStore implements PalActivitySubscriptionStore {
	private readonly root: string
	private readonly secure: (path: string) => void
	private readonly records = new DiskRevisionRecordStore<PalActivitySubscription>(
		defineSchema({
			kind: 'pal-activity-subscription',
			current: 1,
			migrations: {},
		}),
		'Pal activity subscription',
		(value) => value.revision,
	)
	constructor(options: {
		root: string
		secureDirectory?: (path: string) => void
	}) {
		this.root = resolve(options.root)
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
			throw new Error('Pal subscriptions require real directories without aliases.')
		this.secure(path)
	}
	private location(input: string) {
		const id = z.string().uuid().parse(input)
		this.directory(this.root)
		const directory = join(this.root, id)
		this.directory(directory)
		const revisionsDir = join(directory, 'revisions')
		this.directory(revisionsDir)
		for (const name of readdirSync(revisionsDir)) {
			if (!/^[1-9][0-9]*\.json$/u.test(name)) continue
			const stat = lstatSync(join(revisionsDir, name))
			if (!stat.isFile() || stat.isSymbolicLink())
				throw new Error('Pal subscription commits must be real files.')
		}
		return {
			legacyPath: join(directory, 'subscription.json'),
			revisionsDir,
			publishLegacyProjection: false,
		}
	}
	private checked(input: unknown, id: string): PalActivitySubscription {
		const value = storedSubscriptionSchema.parse(input)
		if (value.id !== id || value.configurationRevision > value.revision)
			throw new Error('Foreign or invalid Pal activity subscription.')
		return freezeCommunicationValue(value)
	}
	async get(id: string): Promise<PalActivitySubscription | null> {
		const value = await this.records.read(this.location(id))
		return value === null ? null : this.checked(value, id)
	}
	async create(input: Parameters<PalActivitySubscriptionStore['create']>[0]) {
		const value = subscriptionSchema.parse({
			...input,
			v: 1,
			revision: 1,
			configurationRevision: 1,
			cursor: null,
		})
		const proposed = this.checked(value, value.id)
		return this.records.transact(this.location(proposed.id), (stored) => {
			if (stored !== null)
				throw new PalActivitySubscriptionConflictError('Subscription identity already exists.')
			return { record: proposed, result: proposed }
		})
	}
	async setEnabled(input: Parameters<PalActivitySubscriptionStore['setEnabled']>[0]) {
		const captured = z
			.object({
				id: z.string().uuid(),
				expectedRevision: z.number().int().positive().safe(),
				enabled: z.boolean(),
			})
			.strict()
			.parse(input)
		return this.records.transact(this.location(captured.id), (stored) => {
			const current = stored === null ? null : this.checked(stored, captured.id)
			if (!current || current.revision !== captured.expectedRevision)
				throw new PalActivitySubscriptionConflictError(
					'Subscription changed; reload before changing consent.',
				)
			const record = this.checked(
				{
					...current,
					enabled: captured.enabled,
					revision: current.revision + 1,
					configurationRevision: current.configurationRevision + 1,
				},
				current.id,
			)
			return { record, result: record }
		})
	}
	async advance(input: PalActivitySubscription, inputCursor: PalActivityCursor) {
		const parsed = subscriptionSchema.parse(input)
		const captured = this.checked(parsed, parsed.id)
		const cursor = freezeCommunicationValue(subscriptionCursorSchema.parse(inputCursor))
		if (cursor.after.seq < cursor.root.seq || cursor.after.offset < cursor.root.offset)
			throw new Error('Subscription cursor cannot precede its root.')
		if (captured.cursor) {
			const previous = captured.cursor
			if (
				cursor.scopeHash !== previous.scopeHash ||
				!isDeepStrictEqual(cursor.root, previous.root) ||
				cursor.after.seq < previous.after.seq ||
				cursor.after.offset < previous.after.offset ||
				cursor.generation < previous.generation ||
				(cursor.after.seq === previous.after.seq && !isDeepStrictEqual(cursor, previous))
			)
				throw new Error('Subscription cursor identity changed or moved backwards.')
		}
		return this.records.transact(this.location(captured.id), (stored) => {
			const current = stored === null ? null : this.checked(stored, captured.id)
			if (!current || !current.enabled || !isDeepStrictEqual(current, captured))
				throw new PalActivitySubscriptionConflictError(
					'Subscription changed before accepted progress could commit.',
				)
			const record = this.checked(
				{ ...current, revision: current.revision + 1, cursor },
				current.id,
			)
			return { record, result: record }
		})
	}
}
