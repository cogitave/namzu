export type ExecutionEnvironment = 'local' | 'remote' | 'hybrid'

export type ExecutionCapability = 'filesystem' | 'process' | 'network' | 'shell'

export interface CommandOptions {
	cwd?: string
	env?: Record<string, string>
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

export interface RemoteCommandHandler {
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
