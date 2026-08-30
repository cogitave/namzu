export type ExecutionEnvironment = 'local' | 'remote' | 'hybrid'

export type ExecutionCapability = 'filesystem' | 'process' | 'network' | 'shell'

export interface CommandOptions {
	cwd?: string
	env?: Record<string, string>
	/**
	 * Command deadline in milliseconds; `0` disables the deadline.
	 *
	 * `LocalExecutionContext` owns its spawned process group through stdio
	 * close, first requesting termination and then forcing it after a bounded
	 * grace period. Remote handlers define how this option is enforced at their
	 * own execution boundary.
	 */
	timeoutMs?: number
	shell?: string | boolean
}

export interface CommandResult {
	exitCode: number
	stdout: string
	stderr: string
	durationMs: number
}

export interface CommandExecutor {
	executeCommand(command: string, args?: string[], options?: CommandOptions): Promise<CommandResult>
}

/**
 * @deprecated Use `CommandExecutor` so command arguments retain their
 * boundaries at the remote execution seam.
 */
export interface RemoteCommandHandler {
	/** @deprecated Use `CommandExecutor.executeCommand()`. */
	executeRemote(command: string, options?: CommandOptions): Promise<CommandResult>
}

export type ExecutionRoutingStrategy = 'local-first' | 'remote-first' | 'round-robin'

export interface ExecutionContextBase {
	id: string
	environment: ExecutionEnvironment
	capabilities?: ExecutionCapability[]
	metadata?: Record<string, unknown>
}

export interface ExecutionContextLifecycle {
	initialize(): Promise<void>
	isReady(): boolean
	teardown(): Promise<void>
}

export type ExecutionContextEvent =
	| { type: 'context_initialized'; contextId: string; environment: ExecutionEnvironment }
	| { type: 'context_ready'; contextId: string }
	| { type: 'context_error'; contextId: string; error: string }
	| { type: 'context_teardown'; contextId: string }

export type ExecutionContextEventListener = (event: ExecutionContextEvent) => void
