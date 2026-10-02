import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DiskRevisionRecordStore } from '../../store/kv/revision-record-store.js'
import { defineSchema } from '../../store/schema.js'
import { channelRouteKeySchema } from '../communication/ingress-schema.js'
import type { PalChannelIdentity } from '../communication/ingress-types.js'
import { captureConnection, checkedDecision, decisionId } from './schema.js'
import type { PalChannelConnection, PalChannelRouteDecision, PalChannelRoutes } from './types.js'

export class PalChannelRouteConflictError extends Error {
	override readonly name = 'PalChannelRouteConflictError'
}
class ExistingDecision extends Error {
	constructor(readonly decision: PalChannelRouteDecision) {
		super('Existing immutable channel route.')
	}
}
function storedDecision(value: PalChannelRouteDecision): PalChannelRouteDecision {
	// DiskRecordStore validates its own envelope; it is not part of the public route identity.
	const { schemaVersion: _version, ...body } = value as PalChannelRouteDecision & {
		schemaVersion?: number
	}
	return checkedDecision(body)
}

/** Immutable target decisions only. Session and delivery ownership remain in PalIngressStore. */
export class DiskPalChannelRoutes implements PalChannelRoutes {
	private readonly root: string
	private readonly secure: (path: string) => void
	private readonly records = new DiskRevisionRecordStore<PalChannelRouteDecision>(
		defineSchema({ kind: 'pal-channel-route', current: 1, migrations: {} }),
		'Pal channel route',
		(record) => record.revision,
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
		const entry = lstatSync(path)
		if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path)
			throw new Error('Channel routes require real directories without aliases.')
		this.secure(path)
	}
	private location(id: string) {
		this.directory(this.root)
		const directory = join(this.root, id)
		this.directory(directory)
		const revisionsDir = join(directory, 'revisions')
		this.directory(revisionsDir)
		for (const name of readdirSync(revisionsDir)) {
			if (!/^[1-9][0-9]*\.json$/u.test(name)) continue
			const entry = lstatSync(join(revisionsDir, name))
			if (!entry.isFile() || entry.isSymbolicLink())
				throw new Error('Channel route commits must be real files.')
		}
		const legacyPath = join(directory, 'route.json')
		try {
			const legacy = lstatSync(legacyPath)
			if (!legacy.isFile() || legacy.isSymbolicLink())
				throw new Error('Channel route projections must be real files.')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		return { legacyPath, revisionsDir, publishLegacyProjection: false }
	}
	async get(input: PalChannelConnection, value: PalChannelIdentity) {
		const connection = captureConnection(input)
		const identity = channelRouteKeySchema
			.omit({ v: true, kind: true, recipient: true })
			.parse(value)
		if (
			identity.provider !== connection.provider ||
			identity.connectionId !== connection.connectionId ||
			identity.externalTenantId !== connection.externalTenantId
		)
			throw new Error('Foreign channel route connection.')
		const id = decisionId({
			identity,
			recipient: { tenantId: connection.tenantId, palId: '' },
		})
		const stored = await this.records.read(this.location(id))
		if (!stored) return null
		const decision = storedDecision(stored)
		if (decisionId(decision) !== id || !isDeepStrictEqual(decision.identity, identity))
			throw new Error('Channel route identity changed.')
		return decision
	}
	async reserve(input: PalChannelRouteDecision) {
		const decision = checkedDecision(input)
		try {
			return await this.records.transact(this.location(decisionId(decision)), (stored) => {
				if (stored) {
					const current = storedDecision(stored)
					if (!isDeepStrictEqual(current, decision))
						throw new PalChannelRouteConflictError(
							'This native conversation already has an immutable Pal target.',
						)
					throw new ExistingDecision(current)
				}
				return { record: decision, result: decision }
			})
		} catch (error) {
			if (error instanceof ExistingDecision) return error.decision
			throw error
		}
	}
}
