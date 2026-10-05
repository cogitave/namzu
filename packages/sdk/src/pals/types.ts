import type { BrowserHost } from '../types/browser/index.js'
import type {
	ComputerUseAction,
	ComputerUseHost,
	ComputerUseResult,
} from '../types/computer-use/index.js'
import type { Sandbox } from '../types/sandbox/index.js'

export interface PalModel {
	readonly provider: string
	readonly model: string
}

/** Saved presentation preference. Hosts choose their own default when absent. */
export interface PalAppearance {
	readonly character: 'pixel' | 'sprout' | 'spark'
	readonly color: 'green' | 'blue' | 'amber' | 'violet' | 'rose'
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
	readonly appearance?: PalAppearance
	readonly paused: boolean
	readonly revision: number
	readonly createdAt: string
	readonly updatedAt: string
}
export interface PalCreate {
	readonly name: string
	readonly purpose?: string
	readonly model?: PalModel | null
	readonly appearance?: PalAppearance
}
export interface PalUpdate {
	readonly name?: string
	readonly purpose?: string
	readonly model?: PalModel | null
	readonly appearance?: PalAppearance
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
/** Human input to the Pal's guest desktop; no shell, filesystem or host target. */
export type PalComputerInput =
	| Extract<
			ComputerUseAction,
			{
				readonly type: 'mouse_move' | 'mouse_click' | 'mouse_drag' | 'scroll' | 'type_text' | 'key'
			}
	  >
	| {
			/** One X keysym, never a chord. Complete AI key taps remain unchanged. */
			readonly type: 'key_down' | 'key_up'
			readonly key: string
			/** Host-created keyboard focus lifetime; cleanup cannot release another lifetime's keys. */
			readonly keyboardId: string
	  }
	| {
			/** Release only keys held by this keyboard lifetime, not all guest keys. */
			readonly type: 'release_keys'
			readonly keyboardId: string
	  }
/** Optional provider-owned exclusive control. A provider must gate every agent effect. */
export interface PalComputerControl {
	readonly mode: 'pal' | 'operator' | 'transitioning'
	/** Opt in only after the owned guest confirms session-scoped held keyboard support. */
	readonly heldKeyboard?: true
	/** Reserve the transition before checking all guest activity; refuse unless idle is confirmed. */
	takeOver(): Promise<void>
	/** Return only the input authority. This must not start a query or replay input. */
	returnControl(): Promise<void>
	executeInput(input: PalComputerInput): Promise<ComputerUseResult>
}
export interface PalComputerControlState {
	readonly supported: boolean
	readonly mode: 'pal' | 'operator' | 'transitioning' | 'unavailable'
	readonly heldKeyboard?: true
}
/** Host-only credentials for a readonly RFB WebSocket stream; never pass to a renderer. */
export interface PalComputerScreenStream {
	readonly protocol: 'rfb'
	readonly url: string
	readonly authorization: string
}
export interface PalEnvironmentLease {
	readonly palId: string
	readonly environmentId: string
	readonly generation: number
	readonly sandbox: Sandbox
	readonly computerUseHost: ComputerUseHost
	readonly browserHost?: BrowserHost
	readonly operatorControl?: PalComputerControl
	readonly screenStream?: PalComputerScreenStream
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
/** Exclusive model conversation authority; it does not grant computer access. */
export interface PalConversationAdmission {
	readonly definition: PalDefinition
	/** Reread current pause, ownership and workspace before every paid request. */
	assertActive(): void
	/** Acquire a real, separately guarded guest admission only when work needs it. */
	acquireComputer(): Promise<PalAdmission>
	release(): Promise<void>
}
export interface PalRuntimeOptions {
	readonly store: PalStore
	readonly environments?: PalEnvironmentProvider
}
