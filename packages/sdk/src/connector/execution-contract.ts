import type { ConnectorOperationOptions } from '../types/connector/index.js'

const MANAGER_VALIDATED_INPUT = Symbol('namzu.connector.manager-validated-input')

export type ManagedConnectorOperationOptions = ConnectorOperationOptions & {
	readonly [MANAGER_VALIDATED_INPUT]: true
}

/** Internal hand-off: the manager already produced the method's canonical input. */
export function managedConnectorOptions(
	options: ConnectorOperationOptions,
): ManagedConnectorOperationOptions {
	return {
		...options,
		[MANAGER_VALIDATED_INPUT]: true,
	}
}

/** Used by BaseConnector helpers so direct calls still validate exactly once. */
export function hasManagerValidatedInput(
	options: ConnectorOperationOptions | undefined,
): options is ManagedConnectorOperationOptions {
	return Boolean(
		options &&
			(options as Partial<ManagedConnectorOperationOptions>)[MANAGER_VALIDATED_INPUT] === true,
	)
}
