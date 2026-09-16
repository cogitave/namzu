/**
 * Every environment variable `agent/agent.cjs` reads, for the suites that
 * load it in-process.
 *
 * The agent reads these straight off `process.env` at module load, so a
 * value a case sets and a value the shell happened to export are the same
 * value as far as the agent is concerned. Both suites clear this whole
 * list before each case and restore it after — and they clear the SAME
 * list, from here, because two hand-kept lists drift and a knob missing
 * from one of them is an ambient value quietly deciding a result.
 */
export const AGENT_ENV_KEYS = [
	// Listen mode, in the order `startListening` tries them.
	'NAMZU_AGENT_UNIX_PATH',
	'NAMZU_AGENT_VSOCK_PORT',
	'NAMZU_AGENT_TCP_PORT',
	// The credential gate.
	'NAMZU_AGENT_BIND_TOKEN',
	'NAMZU_AGENT_REQUIRE_TOKEN',
	// What a peer may spend, before the gate can run and after.
	'NAMZU_AGENT_MAX_FRAME_BYTES',
	'NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES',
	'NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS',
	'NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES',
	'NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS',
	'NAMZU_AGENT_PREAUTH_DEADLINE_MS',
	'NAMZU_AGENT_REFUSAL_FLUSH_GRACE_MS',
	// Execution leases and cancellation.
	'NAMZU_AGENT_EXECUTION_LEASE_TTL_MS',
	'NAMZU_AGENT_EXECUTION_TERMINAL_TTL_MS',
	'NAMZU_AGENT_MAX_TRACKED_EXECUTIONS',
	'NAMZU_AGENT_CANCEL_GRACE_MS',
	'NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS',
	'NAMZU_AGENT_RESEED_HOOK',
	// Retained execution output, and how long a retained record outlives
	// its command.
	'NAMZU_AGENT_EXECUTION_LOG_BYTES',
	'NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS',
	'NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS',
	// The ceiling on a caller-requested command timeout.
	'NAMZU_SANDBOX_MAX_TIMEOUT_MS',
	// The workspace the file ops are confined to.
	'NAMZU_SANDBOX_WORKSPACE',
	'NAMZU_SANDBOX_READ_ROOTS',
	'NAMZU_SANDBOX_WRITE_ROOTS',
] as const
