import type { CredentialId, LockId, SandboxId, SessionId, TenantId, TurnId } from '../ids/index.js'

export type { LockId } from '../ids/index.js'

export type ProviderCallId = `pcall_${string}`

export type CircuitBreakerState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerSnapshot {
	readonly state: CircuitBreakerState
	readonly agentSessionId: SessionId
	readonly consecutiveFailures: number
	readonly lastFailureAt?: number
	readonly lastSuccessAt?: number
	readonly trippedAt?: number
}

export interface FileLock {
	readonly lockId: LockId
	readonly filePath: string
	readonly owner: SessionId
	readonly acquiredAt: number
	readonly expiresAt?: number
}

export type LockAcquireResult =
	| { acquired: true; lock: FileLock }
	// `holder` is OPTIONAL, and its absence is the honest answer to "who holds
	// it". The failure branch is also reached when the lock was released
	// between the attempt and the read, and this used to report `'' as SessionId`
	// for that — an empty string wearing an id type, which the nominal ids of
	// NZ-SURF-11 will not express and which no caller could have distinguished
	// from a real holder anyway.
	| { acquired: false; holder?: SessionId; filePath: string }

export interface FileOwnership {
	readonly filePath: string
	readonly owner: SessionId
	readonly claimedAt: number
}

export type OwnershipClaimResult =
	| { claimed: true; ownership: FileOwnership }
	| { claimed: false; currentOwner: SessionId; filePath: string }

export interface ProviderCallUsage {
	readonly inputTokens?: number
	readonly outputTokens?: number
	readonly totalTokens?: number
	readonly costUsd?: number
}

export type SandboxDecisionAction = 'allow' | 'deny'

export type AgentBusEvent =
	| { type: 'lock_acquired'; lockId: LockId; filePath: string; owner: SessionId }
	| { type: 'lock_released'; lockId: LockId; filePath: string; owner: SessionId }
	| { type: 'lock_denied'; filePath: string; requester: SessionId; holder: SessionId }
	| { type: 'lock_expired'; lockId: LockId; filePath: string; owner: SessionId }
	| { type: 'ownership_claimed'; filePath: string; owner: SessionId }
	| { type: 'ownership_released'; filePath: string; previousOwner: SessionId }
	| { type: 'ownership_transferred'; filePath: string; from: SessionId; to: SessionId }
	| { type: 'ownership_denied'; filePath: string; requester: SessionId; currentOwner: SessionId }
	| { type: 'breaker_tripped'; agentSessionId: SessionId; consecutiveFailures: number }
	| { type: 'breaker_reset'; agentSessionId: SessionId }
	| { type: 'breaker_half_open'; agentSessionId: SessionId }
	| { type: 'breaker_probe_success'; agentSessionId: SessionId }
	| { type: 'breaker_probe_failure'; agentSessionId: SessionId }
	| {
			type: 'provider_call_start'
			providerId: string
			model: string
			callId: ProviderCallId
			sessionId?: SessionId
			turnId?: TurnId
	  }
	| {
			type: 'provider_call_completed'
			providerId: string
			model: string
			callId: ProviderCallId
			sessionId?: SessionId
			turnId?: TurnId
			durationMs: number
			usage?: ProviderCallUsage
	  }
	| {
			type: 'provider_call_failed'
			providerId: string
			model: string
			callId: ProviderCallId
			sessionId?: SessionId
			turnId?: TurnId
			durationMs: number
			error: string
	  }
	/**
	 * A credential was written, removed, or replaced.
	 *
	 * Rotation was invisible: a lapsed OAuth token was refreshed straight
	 * into a host's file store, and this union carried a LOOKUP event and no
	 * change event — so no probe subscriber could see a credential turn
	 * over, and nothing could answer "when did this last rotate".
	 *
	 * Carries no secret and never will. The whole value of a change event is
	 * that it can be logged, forwarded and retained, which is exactly what a
	 * credential must not be. `source` names where it lives; the value stays
	 * where it lives.
	 */
	| {
			type: 'vault_credential_changed'
			/** `rotated` is a set that REPLACED a value, not a first write. */
			kind: 'set' | 'unset' | 'rotated'
			/** Which backing store changed — `env`, a file path's label, a KMS id. */
			source: string
			ref: string
			tenantId?: TenantId
			sessionId?: SessionId
			turnId?: TurnId
	  }
	| {
			type: 'vault_lookup'
			vaultId: string
			credentialId?: CredentialId
			tenantId?: TenantId
			found: boolean
			sessionId?: SessionId
			turnId?: TurnId
	  }
	| {
			type: 'sandbox_decision'
			sandboxId: SandboxId
			action: SandboxDecisionAction
			resource: string
			ruleId?: string
			sessionId?: SessionId
			turnId?: TurnId
	  }

export type AgentBusEventListener = (event: AgentBusEvent) => void
