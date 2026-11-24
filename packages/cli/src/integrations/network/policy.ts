import type { NetworkInterfaceInfo } from 'node:os'
import { privateInterfaces } from '@namzu/sdk'
import type { NetworkConfig } from '../../config/schema.js'
import type { NetworkSettings } from './types.js'

/**
 * Whether this process runs the Namzu network, and why not when it does not.
 *
 * Off switch first: `network.enabled: false` and the `NAMZU_NETWORK=off` hard stop mean no advertisement
 * and no listener. Then the host: only a terminal with a person at it ever runs the network, whatever the
 * setting says (a headless run, a scheduled run, `serve` and the Pals never do). Then the network: `auto`
 * (the default) runs only where an interface is known to be private; `true` runs on any network.
 */
export type NetworkDecision =
	| { readonly run: true; readonly anyNetwork: boolean }
	| { readonly run: false; readonly reason: NetworkOffReason; readonly text: string }

export type NetworkOffReason = 'disabled' | 'env-off' | 'headless' | 'not-private'

export const NETWORK_ENV = 'NAMZU_NETWORK'

export function networkSettings(config: NetworkConfig | undefined): NetworkSettings {
	return {
		enabled: config?.enabled ?? 'auto',
		acceptMail: config?.acceptMail ?? 'members',
		autoAdmit: config?.autoAdmit ?? 'trusted-networks',
		sameComputer: config?.sameComputer ?? true,
		...(config?.machineName ? { machineName: config.machineName } : {}),
	}
}

export interface DecideNetworkInput {
	readonly settings: NetworkSettings
	readonly env: NodeJS.ProcessEnv
	/** True only for a terminal with a person at it. */
	readonly interactive: boolean
	readonly interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>
	/** Tests only: 127.0.0.1 counts as private. */
	readonly allowLoopback?: boolean
}

export function decideNetwork(input: DecideNetworkInput): NetworkDecision {
	const stop = input.env[NETWORK_ENV]?.trim().toLowerCase()
	if (stop === 'off' || stop === '0' || stop === 'false')
		return {
			run: false,
			reason: 'env-off',
			text: `Your Namzu network is off: ${NETWORK_ENV} is set to ${stop}.`,
		}
	if (input.settings.enabled === false)
		return {
			run: false,
			reason: 'disabled',
			text: 'Your Namzu network is off. `namzu peers on` turns it on.',
		}
	if (!input.interactive)
		return {
			run: false,
			reason: 'headless',
			text: 'Your Namzu network runs only in a terminal with a person at it.',
		}
	const anyNetwork = input.settings.enabled === true
	const eligible = privateInterfaces(input.interfaces(), {
		...(input.allowLoopback ? { allowLoopback: true } : {}),
		...(anyNetwork ? { anyAddress: true } : {}),
	})
	if (eligible.length === 0)
		return {
			run: false,
			reason: 'not-private',
			text: 'Your Namzu network is off: this network is not known to be private. `namzu peers on --anyway` allows it.',
		}
	return { run: true, anyNetwork }
}
