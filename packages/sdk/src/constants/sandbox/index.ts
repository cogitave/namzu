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

// ---------------------------------------------------------------------------
// ContainerSandboxLayout default container paths
// ---------------------------------------------------------------------------
//
// Mirrors the taxonomy Anthropic's container architecture exposes to
// the model (Claude container blueprint, Code Interpreter, "skills").
// Exported so prompt-template consumers can write
// `Outputs go to ${SANDBOX_DEFAULT_OUTPUTS_PATH}` instead of
// hard-coding the string in two places that drift.

/** Default container path for the deliverables (RW) bind. */
export const SANDBOX_DEFAULT_OUTPUTS_PATH = '/mnt/user-data/outputs'

/** Default container path for user-uploaded files (RO). */
export const SANDBOX_DEFAULT_UPLOADS_PATH = '/mnt/user-data/uploads'

/**
 * Default container path for the agent's working/scratch space (RW).
 * Sibling mount to {@link SANDBOX_DEFAULT_OUTPUTS_PATH} — anything
 * written here is invisible to the deliverables collector by design,
 * mirroring the Anthropic Cowork pattern (`/home/claude` scratch vs.
 * `/mnt/user-data/outputs` user-visible).
 */
export const SANDBOX_DEFAULT_SCRATCH_PATH = '/mnt/user-data/scratch'

/** Default container path for cached tool fetches (RO). */
export const SANDBOX_DEFAULT_TOOL_RESULTS_PATH = '/mnt/user-data/tool_results'

/** Default container path for prior-conversation transcripts (RO). */
export const SANDBOX_DEFAULT_TRANSCRIPTS_PATH = '/mnt/transcripts'

/**
 * Default parent path under which each skill bundle binds.
 * Per-skill default is `${SANDBOX_DEFAULT_SKILLS_PARENT}/<skill-id>`.
 */
export const SANDBOX_DEFAULT_SKILLS_PARENT = '/mnt/skills'
