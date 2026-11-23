/**
 * Per-machine state of the Namzu network, under `<home>/network/`:
 *
 * ```
 * machine.json  machine.key.pem  machine.cert.pem  network.json
 * members.json  peers.json  session-roles.json  trusted-networks.json  join-attempt.json
 * leader.lock  audit.jsonl
 * ```
 *
 * The directory is 0700 and every file 0600, written atomically. Reads are
 * zod-parsed; a corrupt file is renamed aside to `<file>.corrupt-<ts>` and the
 * feature degrades instead of throwing. Nothing is created until a caller
 * writes; an off machine leaves nothing behind.
 *
 * @experimental
 */

import { existsSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { hardenPeerRuntimeDir } from '../peers/dir.js'
import { atomicWriteFile } from '../utils/atomic-write.js'
import { type MachineKey, exportMachineKeyPem, importMachineKeyPem } from './identity.js'
import { AdmissionSchema, RevocationSchema } from './membership.js'

const FILE_MODE = 0o600

export const MachineFileSchema = z
	.object({
		v: z.literal(1),
		machineId: z.string().length(64),
		name: z.string().max(80).optional(),
		role: z.string().max(500).optional(),
		listenPort: z.number().int().min(1).max(65535).optional(),
		createdAt: z.number().int().nonnegative(),
	})
	.strict()
export type MachineFile = z.infer<typeof MachineFileSchema>

export const NetworkFileSchema = z
	.object({
		v: z.literal(1),
		netId: z.string().length(16),
		founderPublicKey: z.string().min(1),
		createdAt: z.number().int().nonnegative(),
	})
	.strict()
export type NetworkFile = z.infer<typeof NetworkFileSchema>

export const MembersFileSchema = z
	.object({
		v: z.literal(1),
		rev: z.number().int().nonnegative(),
		members: z.array(AdmissionSchema),
		revoked: z.array(RevocationSchema),
	})
	.strict()
export type MembersFile = z.infer<typeof MembersFileSchema>

const AddressSchema = z
	.object({
		host: z.string().min(1).max(255),
		port: z.number().int().min(1).max(65535),
		at: z.number().int().nonnegative(),
		manual: z.boolean().optional(),
	})
	.strict()
export type RememberedAddress = z.infer<typeof AddressSchema>

export const PeersFileSchema = z
	.object({
		v: z.literal(1),
		machines: z.record(
			z.string(),
			z.object({ name: z.string().max(80), addresses: z.array(AddressSchema).max(4) }).strict(),
		),
	})
	.strict()
export type PeersFile = z.infer<typeof PeersFileSchema>

export const SessionRolesFileSchema = z
	.object({
		v: z.literal(1),
		roles: z
			.array(
				z
					.object({
						conversationId: z.string().min(1),
						role: z.string().max(500),
						by: z.string().max(80),
						at: z.number().int().nonnegative(),
					})
					.strict(),
			)
			.max(64),
	})
	.strict()
export type SessionRolesFile = z.infer<typeof SessionRolesFileSchema>

export const TrustedNetworksFileSchema = z
	.object({
		v: z.literal(1),
		networks: z
			.array(
				z
					.object({
						/** Fingerprint of the local network (see `fingerprint.ts`); not a secret. */
						id: z.string().length(16),
						name: z.string().min(1).max(40),
						trustedAt: z.number().int().nonnegative(),
					})
					.strict(),
			)
			.max(64),
	})
	.strict()
export type TrustedNetworksFile = z.infer<typeof TrustedNetworksFileSchema>

/**
 * The one request this machine has out to join a network, shared by every terminal of the machine: the
 * nonce a repeat of the ask reuses (so the other machine shows the same code), and how the ask ended, so
 * nobody asks again at once.
 */
export const JoinAttemptFileSchema = z
	.object({
		v: z.literal(1),
		/** The network asked (its id when known, else `host:port`). */
		target: z.string().min(1).max(300),
		nonce: z.string().min(1).max(64),
		startedAt: z.number().int().nonnegative(),
		/** Set once the other side answered or the ask ran out; absent while it waits. */
		result: z.enum(['denied', 'expired', 'refused']).optional(),
		endedAt: z.number().int().nonnegative().optional(),
	})
	.strict()
export type JoinAttemptFile = z.infer<typeof JoinAttemptFileSchema>

export const LeaderLockSchema = z
	.object({
		pid: z.number().int().positive(),
		startedAt: z.number().int().nonnegative(),
		port: z.number().int().min(0).max(65535),
	})
	.strict()
export type LeaderLock = z.infer<typeof LeaderLockSchema>

export type ReadResult<T> =
	| { readonly status: 'ok'; readonly value: T }
	| { readonly status: 'missing' }
	| { readonly status: 'corrupt' }

export interface NetworkStoreOptions {
	/** The Namzu home (`~/.namzu`). The store works in `<home>/network`. */
	readonly home: string
	/** Tighten the directory; the CLI supplies one that also restricts a Windows ACL. */
	readonly hardenDirectory?: (path: string) => void
	readonly now?: () => number
}

export interface NetworkStore {
	readonly dir: string
	/** True when the directory exists: some network state may be there. */
	exists(): boolean
	file(name: string): string
	readMachine(): Promise<ReadResult<MachineFile>>
	writeMachine(value: MachineFile): Promise<void>
	readKey(): Promise<ReadResult<MachineKey>>
	writeKey(key: MachineKey): Promise<void>
	readCertificate(): Promise<string | undefined>
	writeCertificate(pem: string): Promise<void>
	readNetwork(): Promise<ReadResult<NetworkFile>>
	writeNetwork(value: NetworkFile): Promise<void>
	readMembers(): Promise<ReadResult<MembersFile>>
	writeMembers(value: MembersFile): Promise<void>
	readPeers(): Promise<ReadResult<PeersFile>>
	writePeers(value: PeersFile): Promise<void>
	readSessionRoles(): Promise<ReadResult<SessionRolesFile>>
	writeSessionRoles(value: SessionRolesFile): Promise<void>
	readTrustedNetworks(): Promise<ReadResult<TrustedNetworksFile>>
	writeTrustedNetworks(value: TrustedNetworksFile): Promise<void>
	readJoinAttempt(): Promise<ReadResult<JoinAttemptFile>>
	writeJoinAttempt(value: JoinAttemptFile): Promise<void>
	clearJoinAttempt(): Promise<void>
	/** Forget the network and the identity (a removed machine starts over). The audit log stays. */
	reset(): Promise<void>
}

export function createNetworkStore(options: NetworkStoreOptions): NetworkStore {
	const dir = join(options.home, 'network')
	const now = options.now ?? Date.now
	const harden =
		options.hardenDirectory ?? ((path: string) => hardenPeerRuntimeDir(path, process.getuid?.()))
	let hardened = false
	const ensure = () => {
		if (hardened) return
		harden(dir)
		hardened = true
	}
	const file = (name: string) => join(dir, name)

	async function setAside(path: string): Promise<void> {
		await rename(path, `${path}.corrupt-${now()}`).catch(() => undefined)
	}

	async function readText(path: string): Promise<string | undefined> {
		try {
			return await readFile(path, 'utf8')
		} catch {
			return undefined
		}
	}

	async function readJson<T>(name: string, schema: z.ZodType<T>): Promise<ReadResult<T>> {
		const path = file(name)
		const text = await readText(path)
		if (text === undefined) return { status: 'missing' }
		try {
			const parsed = schema.safeParse(JSON.parse(text))
			if (parsed.success) return { status: 'ok', value: parsed.data }
		} catch {
			// fall through to corrupt
		}
		await setAside(path)
		return { status: 'corrupt' }
	}

	async function writeJson(name: string, value: unknown): Promise<void> {
		ensure()
		await atomicWriteFile(file(name), `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE })
	}

	return {
		dir,
		exists: () => existsSync(dir),
		file,
		readMachine: () => readJson('machine.json', MachineFileSchema),
		writeMachine: (v) => writeJson('machine.json', MachineFileSchema.parse(v)),
		async readKey() {
			const path = file('machine.key.pem')
			const text = await readText(path)
			if (text === undefined) return { status: 'missing' }
			try {
				return { status: 'ok', value: importMachineKeyPem(text) }
			} catch {
				await setAside(path)
				return { status: 'corrupt' }
			}
		},
		async writeKey(key) {
			ensure()
			await atomicWriteFile(file('machine.key.pem'), exportMachineKeyPem(key), { mode: FILE_MODE })
		},
		readCertificate: () => readText(file('machine.cert.pem')),
		async writeCertificate(pem) {
			ensure()
			await atomicWriteFile(file('machine.cert.pem'), pem, { mode: FILE_MODE })
		},
		readNetwork: () => readJson('network.json', NetworkFileSchema),
		writeNetwork: (v) => writeJson('network.json', NetworkFileSchema.parse(v)),
		readMembers: () => readJson('members.json', MembersFileSchema),
		writeMembers: (v) => writeJson('members.json', MembersFileSchema.parse(v)),
		readPeers: () => readJson('peers.json', PeersFileSchema),
		writePeers: (v) => writeJson('peers.json', PeersFileSchema.parse(v)),
		readSessionRoles: () => readJson('session-roles.json', SessionRolesFileSchema),
		writeSessionRoles: (v) => writeJson('session-roles.json', SessionRolesFileSchema.parse(v)),
		readTrustedNetworks: () => readJson('trusted-networks.json', TrustedNetworksFileSchema),
		writeTrustedNetworks: (v) =>
			writeJson('trusted-networks.json', TrustedNetworksFileSchema.parse(v)),
		readJoinAttempt: () => readJson('join-attempt.json', JoinAttemptFileSchema),
		writeJoinAttempt: (v) => writeJson('join-attempt.json', JoinAttemptFileSchema.parse(v)),
		clearJoinAttempt: () => rm(file('join-attempt.json'), { force: true }),
		async reset() {
			for (const name of [
				'machine.json',
				'machine.key.pem',
				'machine.cert.pem',
				'network.json',
				'members.json',
				'peers.json',
				'session-roles.json',
				'join-attempt.json',
			]) {
				await rm(file(name), { force: true })
			}
		},
	}
}
