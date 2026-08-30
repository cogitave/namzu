export type ExecutionEnvironment = 'local' | 'remote' | 'hybrid'

export type ExecutionCapability = 'filesystem' | 'process' | 'network' | 'shell'

export interface CommandOptions {
	cwd?: string
	env?: Record<string, string>
	/**
	 * Caller-owned cancellation for this command.
	 *
	 * A compliant executor may accept this only when it can prove that command
	 * admission never happened or that admitted work reached quiescence before
	 * settling. `LocalExecutionContext` owns that guarantee for its process
	 * group. `RemoteExecutionContext` refuses this option because its generic
	 * executor seam has no reservation and terminal-acknowledgement protocol;
	 * use the `Sandbox.exec()` contract for cancellable remote execution.
	 */
	signal?: AbortSignal
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

export type CommandTermination =
	| {
			/** Caller cancellation was already present, so no process was admitted. */
			origin: 'caller'
			admitted: false
	  }
	| {
			/** The first Namzu-owned cause that requested termination. */
			origin: 'caller' | 'timeout' | 'teardown'
			admitted: true
			/** The direct child's actual close signal, when Node reported one. */
			signal?: string
	  }

export interface CommandResult {
	/** Numeric process exit, or `null` when no numeric exit exists. */
	exitCode: number | null
	stdout: string
	stderr: string
	/** Whether the executor retained only part of stdout. Absent means unknown. */
	stdoutTruncated?: boolean
	/** Whether the executor retained only part of stderr. Absent means unknown. */
	stderrTruncated?: boolean
	durationMs: number
	/** Present only when Namzu requested termination or refused pre-aborted admission. */
	termination?: CommandTermination
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
