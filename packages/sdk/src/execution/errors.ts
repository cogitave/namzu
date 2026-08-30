export class CommandCancellationUnsupportedError extends Error {
	readonly code = 'command_cancellation_unsupported' as const

	constructor(readonly contextId: string) {
		super(
			`Remote execution context "${contextId}" cannot accept command cancellation because its generic executor has no reservation and terminal-acknowledgement protocol. No remote command was started. Use the Sandbox.exec() contract for cancellable remote command execution.`,
		)
		this.name = 'CommandCancellationUnsupportedError'
	}
}

export class RemoteExecutionBusyError extends Error {
	readonly code = 'remote_execution_busy' as const

	constructor(
		readonly contextId: string,
		readonly activeCommandCount: number,
	) {
		super(
			`Remote execution context "${contextId}" still owns ${activeCommandCount} active command${activeCommandCount === 1 ? '' : 's'}. Disconnect or teardown was refused; wait for the command${activeCommandCount === 1 ? '' : 's'} to settle, then retry.`,
		)
		this.name = 'RemoteExecutionBusyError'
	}
}
