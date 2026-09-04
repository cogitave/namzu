/**
 * Who this installation is, to the kernel: one tenant id, minted once and
 * kept in the application home.
 *
 * The kernel files every project, session and run under a tenant. The CLI
 * used to file everything under the kernel's placeholder for "tenant
 * unknown", which was a label, not an identity: two machines could not be
 * told apart, and a record's tenant said nothing about where it came from.
 * A minted id costs one file and answers the question honestly.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { type TenantId, asTenantId, generateTenantId } from '@namzu/sdk'

export interface Identity {
	readonly tenantId: TenantId
	/** ISO time the identity was minted. */
	readonly createdAt: string
}

const FILE = 'identity.json'

/** The identity under `home`, or null when none has been minted. Reads only; an inventory may call this. */
export function readIdentity(home: string): Identity | null {
	const path = join(home, FILE)
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as {
			tenantId?: unknown
			createdAt?: unknown
		}
		if (typeof raw.tenantId === 'string') {
			return {
				tenantId: asTenantId(raw.tenantId),
				createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new Error(
				`${path} is not a readable identity file: ${error instanceof Error ? error.message : String(error)}. Fix or remove it; a new one is minted when it is absent.`,
			)
		}
	}
	return null
}

/** Read the identity under `home`, minting and writing one the first time. */
export function loadIdentity(home: string): Identity {
	const existing = readIdentity(home)
	if (existing) return existing
	const path = join(home, FILE)
	const identity: Identity = { tenantId: generateTenantId(), createdAt: new Date().toISOString() }
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
	return identity
}
