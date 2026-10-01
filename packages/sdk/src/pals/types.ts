import type { BrowserHost } from '../types/browser/index.js'
import type { ComputerUseHost } from '../types/computer-use/index.js'
import type { Sandbox } from '../types/sandbox/index.js'

export interface PalModel {
	readonly provider: string
	readonly model: string
}

/** Saved identity and immutable executable-profile revision; contains no secrets. */
export interface PalDefinition {
	readonly v: 1
	readonly kind: 'pal'
	readonly id: string
	readonly name: string
	readonly purpose: string
	/** Host-owned control/output directory. This is not the Pal's execution computer. */
	readonly workspace: string
	readonly model: PalModel | null
	readonly paused: boolean
	readonly revision: number
	readonly createdAt: string
	readonly updatedAt: string
}
export interface PalCreate {
	readonly name: string
	readonly purpose?: string
	readonly model?: PalModel | null
}
export interface PalUpdate {
	readonly name?: string
	readonly purpose?: string
	readonly model?: PalModel | null
	readonly paused?: boolean
}
export interface PalStore {
	create(input: PalCreate): PalDefinition
	get(id: string): PalDefinition | null
	list(): PalDefinition[]
	getRevision(id: string, revision: number): PalDefinition
	update(id: string, expectedRevision: number, changes: PalUpdate): PalDefinition
}
export interface DiskPalStoreOptions {
	/** Registry root, chosen by the embedding application. No implicit global home. */
	readonly root: string
	/** Separate host control directories. Must not overlap the registry root. */
	readonly workspaceRoot: string
	/** Host privacy hook, for example current-user Windows ACL enforcement. */
	readonly secureDirectory?: (path: string) => void
}
export interface PalEnvironmentRequest {
	readonly pal: PalDefinition
	readonly conversationId: string
	readonly signal?: AbortSignal
}
export interface PalEnvironmentLease {
	readonly palId: string
	readonly environmentId: string
	readonly generation: number
	readonly sandbox: Sandbox
	readonly computerUseHost: ComputerUseHost
	readonly browserHost?: BrowserHost
	release(): Promise<void>
}
export interface PalEnvironmentProbe {
	readonly ready: boolean
	readonly reason?: string
}
/** A host injects an actual virtual computer; a directory-only provider is invalid. */
export interface PalEnvironmentProvider {
	probe?(): Promise<PalEnvironmentProbe>
	acquire(request: PalEnvironmentRequest): Promise<PalEnvironmentLease>
}
export interface PalAdmissionRequest {
	readonly palId: string
	/** Existing conversations pin their original definition revision. */
	readonly revision?: number
	readonly conversationId: string
	readonly signal?: AbortSignal
}
export interface PalAdmission {
	readonly definition: PalDefinition
	readonly lease: PalEnvironmentLease
	/** Check current pause state before admitting each new turn. */
	assertActive(): void
	release(): Promise<void>
}
export interface PalRuntimeOptions {
	readonly store: PalStore
	readonly environments?: PalEnvironmentProvider
}
