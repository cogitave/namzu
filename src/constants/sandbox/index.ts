/** Default timeout for sandbox command execution */
export const SANDBOX_DEFAULT_TIMEOUT_MS = 30_000

/** Default memory limit per sandbox */
export const SANDBOX_DEFAULT_MEMORY_LIMIT_MB = 512

/** Default max processes per sandbox */
export const SANDBOX_DEFAULT_MAX_PROCESSES = 32

/** Max stdout/stderr output size before truncation */
export const SANDBOX_MAX_OUTPUT_BYTES = 10 * 1024 * 1024

/** Temp directory prefix for sandbox roots */
export const SANDBOX_TEMP_DIR_PREFIX = 'namzu-sbx-'

/** Grace period before SIGKILL after SIGTERM */
export const SANDBOX_KILL_GRACE_MS = 3_000

/**
 * Environment variable keys that are safe to pass into sandboxes.
 * Everything else is stripped.
 */
export const SANDBOX_SAFE_ENV_KEYS = new Set([
	'PATH',
	'HOME',
	'SHELL',
	'LANG',
	'TERM',
	'LC_ALL',
	'LC_CTYPE',
])
