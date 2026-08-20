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
 * Base environment keys that are safe to pass into local sandboxes.
 * Windows adds its non-secret core process fragment at the spawn boundary;
 * everything else ambient is stripped on every platform.
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
// A container needs one place the user will see and several the user
// will not, and the difference has to be legible to the model from the
// path alone — otherwise everything lands in the output bind and the
// user reads the agent's scratch work as its answer.
// Exported so prompt-template consumers can write
// `Outputs go to ${SANDBOX_DEFAULT_OUTPUTS_PATH}` instead of
// hard-coding the string in two places that drift.

/** Default container path for the user-visible outputs (RW) bind. */
export const SANDBOX_DEFAULT_OUTPUTS_PATH = '/mnt/user-data/outputs'

/** Default container path for user-uploaded files (RO). */
export const SANDBOX_DEFAULT_UPLOADS_PATH = '/mnt/user-data/uploads'

/**
 * Default container path for the agent's working/scratch space (RW).
 * Sibling mount to {@link SANDBOX_DEFAULT_OUTPUTS_PATH} — anything
 * written here is invisible to the output collector by design: an
 * agent needs somewhere to think out loud that is not the deliverable.
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
