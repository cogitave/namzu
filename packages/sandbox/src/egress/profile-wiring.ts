/**
 * What `createSandboxProvider` does with `egressProfile`: validate it, refuse
 * it where the chosen backend cannot honour all of it, and turn it into the
 * per-create {@link EgressPolicy} that backend already understands.
 *
 * Synchronous and free of I/O, so every refusal surfaces while the host wires
 * its provider rather than on the first `create()`. The table of what each
 * backend supports lives here once, in code, and is pinned by
 * `src/egress/__tests__/egress-profile-wiring.test.ts`; there is deliberately no
 * second copy of it to drift from this one.
 */

import type { EgressPolicy, SandboxBackendConfig } from '../index.js'
import {
	type SandboxEgressProfile,
	SandboxEgressProfileError,
	defineEgressProfile,
	egressPolicyFromProfile,
	egressProfileCoversEntry,
	egressProfileHasPorts,
} from './profile.js'
import type { BrokeredCredential } from './proxy.js'

/** The resolved egress for a provider: the policy each create carries, and the profile behind it. */
export interface ProviderEgress {
	readonly egress?: EgressPolicy
	readonly profile?: SandboxEgressProfile
}

/** Which backend a config selects, in the words refusals use. */
function backendName(backend: SandboxBackendConfig): string {
	if (backend.tier === 'container') {
		if (backend.runtime === 'aci-standby-pool') return 'aci-standby-pool'
		return backend.runtime ?? 'docker'
	}
	return backend.service === 'kubernetes' ? 'kubernetes' : 'firecracker'
}

/**
 * Resolve `egressProfile` against `defaultEgress` and the backend.
 *
 * No profile returns `defaultEgress` untouched, so every existing config
 * produces exactly the create options it did before.
 */
export function resolveProviderEgress(config: {
	readonly backend: SandboxBackendConfig
	readonly defaultEgress?: EgressPolicy
	readonly egressProfile?: SandboxEgressProfile
}): ProviderEgress {
	if (config.egressProfile === undefined) {
		return config.defaultEgress !== undefined ? { egress: config.defaultEgress } : {}
	}
	const profile = defineEgressProfile(config.egressProfile)
	const backend = backendName(config.backend)
	if (config.defaultEgress !== undefined) {
		throw new SandboxEgressProfileError(
			'conflicting-policy',
			'defaultEgress',
			'is set beside egressProfile; a provider takes one egress policy, so set one of the two',
			backend,
		)
	}
	switch (backend) {
		case 'kubernetes':
			throw new SandboxEgressProfileError(
				'conflicting-policy',
				'egressProfile',
				"is not read by the kubernetes backend: its egress is config-level and createKubernetesWorkspace takes the backend config directly, so a provider-level profile would never reach a workspace. Set backend.egress to kubernetesEgressFromProfile(profile, { engine: 'cilium' }) instead, which enforces the profile for task sandboxes and workspaces alike",
				backend,
			)
		case 'aci-standby-pool':
			throw new SandboxEgressProfileError(
				'unsupported',
				'egressProfile',
				'cannot be enforced: a standby-pool claim carries no per-sandbox egress policy, which is a property of the pooled container group profile',
				backend,
			)
		case 'firecracker': {
			const index = profile.hosts.findIndex((rule) => rule.ports !== undefined)
			if (index !== -1) {
				throw new SandboxEgressProfileError(
					'unsupported',
					`hosts[${index}].ports`,
					'cannot be enforced: the orchestrator network policy names hosts and has no field for ports',
					backend,
				)
			}
			return { egress: egressPolicyFromProfile(profile), profile }
		}
		default: {
			// docker and runsc: the egress proxy.
			const container = config.backend as {
				readonly brokeredCredentials?: readonly BrokeredCredential[]
			}
			assertBrokeredCredentialsFitProfile(profile, container.brokeredCredentials, backend)
			if (profile.hosts.length > 0 && egressProfileHasPorts(profile)) {
				const index = profile.hosts.findIndex((rule) => rule.ports !== undefined)
				throw new SandboxEgressProfileError(
					'unsupported',
					`hosts[${index}].ports`,
					'cannot be enforced yet: the docker egress proxy does not check ports',
					backend,
				)
			}
			return { egress: egressPolicyFromProfile(profile), profile }
		}
	}
}

/**
 * Refuse a brokered credential for a host the profile does not allow.
 *
 * Such a credential could never be stamped (the proxy refuses the host first),
 * so accepting it would be a control declared and silently unused; and a
 * credential aimed outside the allowlist is more often a typo in one of the
 * two than a deliberate spare.
 */
export function assertBrokeredCredentialsFitProfile(
	profile: SandboxEgressProfile,
	credentials: readonly BrokeredCredential[] | undefined,
	backend: string,
): void {
	credentials?.forEach((credential, index) => {
		if (egressProfileCoversEntry(profile, credential.host)) return
		throw new SandboxEgressProfileError(
			'conflicting-policy',
			`backend.brokeredCredentials[${index}].host`,
			`${JSON.stringify(credential.host)} is not allowed by egress profile ${JSON.stringify(profile.name)}, so the proxy would refuse every request the credential is for`,
			backend,
		)
	})
}
